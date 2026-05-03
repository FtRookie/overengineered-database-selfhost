import { DatabaseInteractions, type playerDataEntry } from "./Classes/DatabaseInteractions";
import { createReadStream, existsSync, readdirSync, renameSync } from "node:fs";
import { createInterface } from "node:readline";
import { Database } from "bun:sqlite";
import { HttpHandler } from "./Classes/HttpHandler";
import { extname, resolve } from "node:path";

console.time("Import");


function groupAndJoin(parts: string[]): string[]
{
    const result: string[] = [];
    let currentGroup: string[] = [];

    for (const part of parts) {
        const trimmed = part.trim();

        if (trimmed !== "") {
            currentGroup.push(trimmed);
        } else {

            if (currentGroup.length > 0) {
                result.push(currentGroup.join(""));
                currentGroup = [];
            }
        }
    }

    if (currentGroup.length > 0) {
        result.push(currentGroup.join(" "));
    }

    return result;
}

// could've done generic but I'm too lazy
const convertToSQL = async (filepath: string, callback: (line: string[][]) => void) =>
{
    if (!await Bun.file(filepath).exists())
        return;

    if (extname(filepath) === ".processed")
        return;

    const fileStream = createReadStream(filepath);
    const rl = createInterface({
        input: fileStream,
        crlfDelay: Infinity,
    });

    // I AM TOO LAZY TO PERFORM BATCH OPERATIONS!
    const BATCH_SIZE = 5000;
    let batch: string[][] = new Array(BATCH_SIZE);
    for await (const line of rl) {
        batch.push(groupAndJoin(line.split(/[\t ]/gm)));
        if (batch.length >= BATCH_SIZE) {
            callback(batch);
            batch = [];
        }

    }

    if (batch.length)
        callback(batch);

    renameSync(filepath, filepath + ".processed");
}

// db handling
const DB_PATH = "./db_files/database.sqlite";
const db = new Database(DB_PATH);
db.run("PRAGMA journal_mode = WAL;");
db.run("PRAGMA synchronous = OFF;");

DatabaseInteractions.initPlayerTable(db);
DatabaseInteractions.initSavesTable(db);

const promises: Promise<any>[] = [];

const TEXT_USERS_FOLDER = "./db_files/players";
if (existsSync(TEXT_USERS_FOLDER)) {
    for (const file of readdirSync(resolve())) {
        const p = convertToSQL(file, (arr) => DatabaseInteractions.insertPlayers(db, arr.map(v =>
        {
            const [_, slotIndex, playerId, data] = v;
            return {
                slotIndex: Number(slotIndex!),
                playerId: playerId!,
                data: data!
            };
        })));
        promises.push(p);
    }
}

const TEXT_SAVES_FOLDER = "./db_files/saves";
if (existsSync(TEXT_SAVES_FOLDER)) {
    for (const file of readdirSync(resolve())) {
        const p = convertToSQL(file, (arr) => DatabaseInteractions.insertSave(db,
            arr.map(v =>
            {
                const [playerId, data] = v;
                return {
                    playerId: playerId!,
                    data: data!
                };
            })));
        promises.push(p);
    }
}

await Promise.allSettled(promises);

console.timeEnd("Import");

// http server
HttpHandler.init(db, 1367);
