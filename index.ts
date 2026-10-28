import { appendFileSync, createReadStream, existsSync, readdirSync } from "node:fs";
import { createInterface } from "node:readline";
import { Database } from "bun:sqlite";
import { HttpHandler } from "./Classes/HttpHandler";
import { basename, extname, resolve } from "node:path";
import { rename } from "node:fs/promises";
import { CuratedImport } from "./Classes/CuratedImport";
import { LegacyJson } from "./Classes/LegacyJson";
import { TokenHandler } from "./Classes/TokenHandler";
import { DatabaseInteractions, type ParsedSlotFormat, type ParsedSlotFormatWithIndex, type SavedPlayerFormat, type UnparsedCommonData, type UnparsedCommonDataWithIndex } from "./Classes/DatabaseInteractions";

// export db write token
const placeholder = "REPLACE THIS TEXT WITH YOUR TOKEN OR PASSWORD (BETTER USE TOKENS)";
const [WRITE_TOKEN, isUsingPlaceholderWriteToken] = await TokenHandler.getOrGenerateToken(Bun.file("./Access Tokens/WRITE_TOKEN"), placeholder);
const [ADMIN_TOKEN, isUsingPlaceholderAdminToken] = await TokenHandler.getOrGenerateToken(Bun.file("./Access Tokens/ADMIN_TOKEN"), placeholder);

export { WRITE_TOKEN, isUsingPlaceholderWriteToken };
export { ADMIN_TOKEN, isUsingPlaceholderAdminToken };

// optional: only a deployment wired to the Discord bot has one, so no placeholder is generated (see BotApi)
const botTokenFile = Bun.file("./Access Tokens/BOT_TOKEN");
const BOT_TOKEN = (await botTokenFile.exists()) ? (await botTokenFile.text()).trim() || undefined : undefined;

export { BOT_TOKEN };

function destringifyData(entry: UnparsedCommonData | undefined): SavedPlayerFormat | undefined;
function destringifyData(entry: UnparsedCommonDataWithIndex | undefined): ParsedSlotFormatWithIndex | undefined;
function destringifyData(entry: (UnparsedCommonData | UnparsedCommonDataWithIndex) | undefined): any
{
    if (!entry) return undefined;

    const data = LegacyJson.peel(entry.data);
    if (data === LegacyJson.FAILED) {
        console.warn("Skipped a row that could not be parsed:", JSON.stringify(entry).slice(0, 120));
        return undefined;
    }

    return { ...entry, data };
}


/**
 * Reads a curated `.json` / `.jsonl` file — already-correct rows that must not be run through any repair.
 * See {@link CuratedImport}. Returns false when the file is not of that kind, so the caller falls through to
 * the legacy `.txt` path.
 */
const importCurated = async (filepath: string, rowsFrom: (parsed: unknown) => unknown[],
                             insert: (rows: any[]) => void): Promise<boolean> =>
{
    const extension = extname(filepath);
    if (!CuratedImport.isCurated(extension)) return false;

    console.log("filepath:", filepath, "(curated, no repairs applied)");
    const rows: unknown[] = [];
    // spreading a whole file's rows into push() overflows the stack somewhere past half a million of them
    const collect = (parsed: unknown) => { for (const row of rowsFrom(parsed)) rows.push(row); };
    let parsed = 0;
    let failed = 0;

    if (CuratedImport.isLineDelimited(extension)) {
        // streamed, so a large file never has to be held whole
        const lines = createInterface({ input: createReadStream(filepath), crlfDelay: Infinity });
        let lineNumber = 0;
        for await (const line of lines) {
            lineNumber++;
            if (line.trim().length === 0) continue;

            try {
                collect(JSON.parse(line));
                parsed++;
            } catch (err) {
                failed++;
                console.warn(`Skipped ${basename(filepath)} line ${lineNumber}: ${err}`);
            }
        }
    } else {
        try {
            collect(JSON.parse(await Bun.file(filepath).text()));
            parsed++;
        } catch (err) {
            failed++;
            console.warn(`Skipped ${basename(filepath)}: ${err}`);
        }
    }

    if (rows.length) insert(rows);

    // a file nothing could be read from is left alone rather than marked done: a single typo in a hand-edited
    // .json otherwise consumes the whole file, and the warning above is easy to miss in a long import log
    if (parsed === 0 && failed > 0) {
        console.warn(`Left ${basename(filepath)} unprocessed so it can be corrected and retried.`);
        return true;
    }

    await rename(filepath, filepath + ".processed");
    return true;
}

// could've done generic but I'm too lazy
const convertToSQL = async (filepath: string, callback: (line: string[][]) => void) =>
{
    if (extname(filepath) !== ".txt") return;
    console.log("filepath:", filepath);

    const filename = basename(filepath);
    // the legacy dump is uniformly double-escaped and must be unslashed; migrations.txt is written by this app
    // from live data and is already correct, so unslashing it would corrupt good saves
    const unslashLines = LegacyJson.needsUnslashing(filename);
    const fileStream = createReadStream(filepath);
    const lines = createInterface({
        input: fileStream,
        crlfDelay: Infinity,
    });

    // Hey, look! Batch operations!
    const BATCH_SIZE = 5_000;
    let batch: string[][] = [];
    for await (const line of lines) {
        batch.push((unslashLines ? LegacyJson.unslash(line) : line).split("\t"));
        if (batch.length >= BATCH_SIZE) {
            callback(batch);
            batch = [];
            console.log(`Processed another ${BATCH_SIZE} of ${filename}..`);
        }
    }

    if (batch.length) {
        callback(batch);
        console.log(`Processed last ${batch.length} of ${filename}.`);
    }

    await rename(filepath, filepath + ".processed");
}

// Make a new database or find existing one
const DB_PATH = "./db_files/database.sqlite";
const db = new Database(DB_PATH);
db.run("PRAGMA journal_mode = WAL;");
db.run("PRAGMA synchronous = OFF;");

DatabaseInteractions.initPlayerTable(db);
DatabaseInteractions.initSavesTable(db);

const promises: Promise<void>[] = [];
console.log("Uploading data from .txt files...")

const TEXT_PLAYERS_FOLDER = "./db_files/players";
if (existsSync(TEXT_PLAYERS_FOLDER)) {
    for (const file of readdirSync(TEXT_PLAYERS_FOLDER)) {
        const start = Date.now();
        const name = `players/${file}`;
        console.log(`Loading ${name}...`);


        const path = resolve(TEXT_PLAYERS_FOLDER, file);
        if (await importCurated(path, CuratedImport.playerRowsFrom,
            (rows) => DatabaseInteractions.insertPlayers(db, rows))) {
            console.log(`Finished loading ${name} in ${(Date.now() - start) / 1000}s.`);
            continue;
        }

        const p = convertToSQL(
            path,
            (batch) => DatabaseInteractions.insertPlayers(db, batch.map(v =>
            {
                const [playerID, data] = v as [string, string,];
                return destringifyData({
                    playerID, data
                });
            }).filter(v => !!v))
        );
        promises.push(p);
        console.log(`Finished loading ${name} in ${(Date.now() - start) / 1000}s.`);
    }
}

const TEXT_SAVES_FOLDER = "./db_files/saves";
if (existsSync(TEXT_SAVES_FOLDER)) {
    for (const file of readdirSync(TEXT_SAVES_FOLDER)) {
        const start = Date.now();
        const name = `saves/${file}`;
        console.log(`Loading ${name}...`);
        const path = resolve(TEXT_SAVES_FOLDER, file);
        if (await importCurated(path, CuratedImport.saveRowsFrom,
            (rows) => DatabaseInteractions.insertSave(db, rows))) {
            console.log(`Finished loading ${name} in ${(Date.now() - start) / 1000}s.`);
            continue;
        }

        const p = convertToSQL(
            path,
            (batch) => DatabaseInteractions.insertSave(db,
                batch.map(v =>
                {
                    const [increment, index, playerID, data] = v as [string, string, string, string,];
                    return destringifyData({
                        playerID, index, data
                    });
                }).filter(v => !!v)));
        promises.push(p);
        console.log(`Finished loading ${name} in ${(Date.now() - start) / 1000}s.`);
    }
}

if (!promises.length)
    console.log("No .txt files found.");
else {
    await Promise.allSettled(promises);
    console.log("Import complete!");
}

const migrationsPlayer = `${TEXT_PLAYERS_FOLDER}/migrations.txt.processed`;
const migrationsSave = `${TEXT_SAVES_FOLDER}/migrations.txt.processed`;

// `${body.toID}\t${JSON.stringify(v.Data)}\n`
export const logMigration = async ({ migratedPlayer, migratedSave }: { migratedPlayer: SavedPlayerFormat, migratedSave: ParsedSlotFormatWithIndex[] }) =>
{
    // Player Metadata
    try {
        appendFileSync(
            migrationsPlayer,
            `${migratedPlayer.playerID}\t${migratedPlayer.data}\n`, // ID, Data
            "utf-8");
        console.log(`Migration player data for ${migratedPlayer.playerID} written successfully.`);
    } catch (e) {
        console.warn(`Unable to write migration player data for ${migratedPlayer.playerID}!`);
        console.error(e);
    }

    // Saves
    for (let i = 0; i < migratedSave.length; i++) {
        const save = migratedSave[i]!;
        try {
            appendFileSync(
                migrationsSave,
                `${i}\t${save.index}\t${save.playerID}\t${JSON.stringify(save)}\n`, // Increment, Index, ID, Data
                "utf-8"
            );
            console.log(`Migration save data for ${save.playerID} [${save.index}] written successfully.`);
        } catch (e) {
            console.warn(`Unable to write migration save data for ${save.playerID} [${save.index}]!`);
            console.error(e);
        }
    }
}

// http server
HttpHandler.init(db, "overengineered", 1367);
