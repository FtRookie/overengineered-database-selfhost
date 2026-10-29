import { Database } from "bun:sqlite";
import { LegacyJson } from "./LegacyJson";

export type UnparsedCommonData = {
    playerID: string,
    data: string,
}

export type UnparsedCommonDataWithIndex = UnparsedCommonData & {
    index: string,
}

export type ParsedSlotFormat = {
    playerID: string,
    data: { [key: string]: any }
}

export type ParsedSlotFormatWithIndex = ParsedSlotFormat & {
    index: string,
}

export type SavedSlotDatabaseFormat = {
    playerID: string,
    index: string,
    data: string
}


export type SavedPlayerDatabaseFormat = {
    playerID: string,
    data: string
}

export type SavedPlayerFormat = {
    playerID: string,
    data: { [key: string]: any }
}

export type InteractionResult = "SUCCESS" | "FAIL"

export namespace DatabaseInteractions {
    /* USERID \t {
         "data": { ... }, 
         "slots": [ ... ],
         "features": [ ... ],
         "settings": { ... },
         "achievements": { ... }
        }
    */
    export const initPlayerTable = (db: Database) => {
        db.run(`
            CREATE TABLE IF NOT EXISTS players (
                playerID TEXT UNIQUE,
                data TEXT
            )
        `);
    }

    export const insertPlayers = (
        db: Database,
        playerData: SavedPlayerFormat[]
    ): InteractionResult => {
        try {
            const prep = db.prepare(`
                INSERT INTO players (playerID, data) 
                VALUES ($player, $data)
                ON CONFLICT(playerID) DO UPDATE SET data = excluded.data
        `);
            db.transaction((data: typeof playerData) => {
                for (const d of data) {
                    prep.run({ $player: d.playerID, $data: JSON.stringify(d.data) });
                }
            })(playerData);
        } catch {
            return "FAIL"
        }
        return "SUCCESS"
    }

    export const getPlayerDataEntryByID = (db: Database, playerID: string) => {
        const res = db.query(`
            SELECT * FROM players 
            WHERE playerID = ? 
            LIMIT 1
        `).get(playerID) as SavedPlayerDatabaseFormat;
        if (!res) return;
        return { ...res, data: JSON.parse(res.data) }
    };

    /** Unparsed row — the only way to read one whose data will not parse. */
    export const getRawPlayerDataEntryByID = (db: Database, playerID: string) => {
        return db.query(`
            SELECT * FROM players
            WHERE playerID = ?
            LIMIT 1
        `).get(playerID) as SavedPlayerDatabaseFormat | null ?? undefined;
    };

    /** Every player row, unparsed and one at a time, so a full scan never holds the whole table. */
    export const iterateRawPlayers = (db: Database) =>
        db.query(`SELECT playerID, data FROM players`).iterate() as IterableIterator<SavedPlayerDatabaseFormat>;

    export type BlockLimits = { [blockId: string]: number };
    /** Upper bound the bot's /blocks command already enforces; checked here too since this is where it is stored. */
    export const MAX_BLOCK_LIMIT = 5000;
    export type SetBlockLimitResult =
        | { ok: true, blocks: BlockLimits }
        | { ok: false, reason: string };

    /**
     * Top-level row keys written here rather than by the game, per player, until a game push carries them.
     * The game mirrors its whole cached row, so without this a push sent before it fetched the change would
     * overwrite it. In memory only: a restart drops them, and the stored row is all that remains.
     */
    const pendingChanges = new Map<string, { [key: string]: unknown }>();

    const parseRow = (stored: string | null | undefined): { [key: string]: unknown } | undefined => {
        const row = LegacyJson.peel(stored ?? "");
        if (row === LegacyJson.FAILED || typeof row !== "object" || row === null || Array.isArray(row)) return;
        return row as { [key: string]: unknown };
    };

    const limitsOf = (row: { [key: string]: unknown }): BlockLimits => {
        const blocks = row.blocks;
        return typeof blocks === "object" && blocks !== null && !Array.isArray(blocks) ? { ...blocks as BlockLimits } : {};
    };

    // Luau serializes an empty table as `[]`, and the game omits a map it never filled
    const isEmpty = (value: unknown) =>
        value === undefined || value === null || (typeof value === "object" && Object.keys(value).length === 0);
    const sameValue = (a: unknown, b: unknown) => (isEmpty(a) && isEmpty(b)) || Bun.deepEquals(a, b);

    /**
     * Set one per-player block limit in the row's `blocks` map, or remove it when `limit` is undefined, so a
     * revoked block leaves no key behind. A player with no row yet gets one holding only the limit. A row that
     * will not parse is refused rather than replaced, so a grant can never be what destroys a player's data.
     */
    export const setBlockLimit = (db: Database, playerID: string, blockId: string, limit: number | undefined): SetBlockLimitResult => {
        // synchronous end to end: nothing else touches the row between this read and the write below
        const existing = getRawPlayerDataEntryByID(db, playerID);
        const row = existing ? parseRow(existing.data) : {};
        if (!row) return { ok: false, reason: `Stored data for player ${playerID} is not valid JSON` };

        const blocks = limitsOf(row);
        if (limit === undefined) delete blocks[blockId];
        else blocks[blockId] = limit;

        if (insertPlayers(db, [{ playerID, data: { ...row, blocks } }]) !== "SUCCESS") {
            return { ok: false, reason: "Error while upserting player metadata" };
        }

        pendingChanges.set(playerID, { ...pendingChanges.get(playerID), blocks });
        return { ok: true, blocks };
    };

    /** Keys changed here that the game has not pushed back yet, for it to apply to its own copy. */
    export const getPendingChanges = (playerID: string): { [key: string]: unknown } => ({ ...pendingChanges.get(playerID) });

    /**
     * A row pushed by the game, with every pending change it does not carry yet laid back on top. A change the
     * push already carries is the game having adopted it, and is dropped.
     */
    export const reconcilePush = (incoming: SavedPlayerFormat): SavedPlayerFormat => {
        const changes = pendingChanges.get(incoming.playerID);
        if (!changes) return incoming;

        const data = { ...incoming.data };
        for (const [key, value] of Object.entries(changes)) {
            if (sameValue(data[key], value)) delete changes[key];
            else data[key] = value;
        }
        if (Object.keys(changes).length === 0) pendingChanges.delete(incoming.playerID);

        return { playerID: incoming.playerID, data };
    };


    // SLOT DATA:
    //  INCREMENT \t INDEX \t USERID \t { "blocks": [ ... ], "version": ## }
    export const initSavesTable = (db: Database) => {
        db.run(`
            CREATE TABLE IF NOT EXISTS saves (
            increment INTEGER PRIMARY KEY AUTOINCREMENT,
            playerID TEXT,
            "index" TEXT,
            data TEXT,
            UNIQUE(playerID, "index")
            )
        `);
    }

    export const insertSave = (
        db: Database,
        saveData: ParsedSlotFormatWithIndex[]
    ): InteractionResult => {
        try {
            const prep = db.prepare(`
            INSERT INTO saves (playerID, "index", data) 
            VALUES ($player, $index, $data)
            ON CONFLICT(playerID, "index") DO UPDATE SET data = excluded.data
        `);

            db.transaction((data: typeof saveData) => {
                for (const d of data) {
                    prep.run({
                        $player: d.playerID,
                        $index: d.index,
                        $data: JSON.stringify(d.data)
                    });
                }

            })(saveData);
        } catch {
            return "FAIL"
        }
        return "SUCCESS"
    }

    // Full rows (with index), data parsed. Map to .data if you only need the blobs.
    export const getSavesOfPlayerByID = (db: Database, playerID: string) => {
        const res = db.query(`
            SELECT * FROM saves
            WHERE playerID = ?
            ORDER BY increment DESC
        `).all(playerID) as SavedSlotDatabaseFormat[];
        return res.map(v => ({ ...v, data: JSON.parse(v.data) })) as ParsedSlotFormatWithIndex[];
    };

    export const getSavesOfPlayerByIDWithIndex = (db: Database, playerID: string, index: string) => {
        const res = db.query(`
            SELECT * FROM saves 
            WHERE playerID = ? AND "index" = ?
            ORDER BY increment DESC 
            LIMIT 1
        `).get(playerID, index) as SavedSlotDatabaseFormat | undefined;
        if (!res) return;
        return { ...res, data: JSON.parse(res.data) } as ParsedSlotFormatWithIndex;
    }
}