import { Database } from "bun:sqlite";

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