import { Database } from "bun:sqlite";


export type playerDataEntry = {
    slotIndex: number,
    playerId: string,
    data: string,
}

export namespace DatabaseInteractions
{

    export const initPlayerTable = (db: Database) =>
    {
        db.run(`
      CREATE TABLE IF NOT EXISTS players (
        increment INTEGER PRIMARY KEY AUTOINCREMENT,
        slot_index INTEGER,
        player_id TEXT UNIQUE,
        data TEXT
      )
    `);
    }

    export const insertPlayers = (db: Database,
        playerData: {
            playerId: string,
            data: string,
        }[]
    ) =>
    {
        const prep = db.prepare(`
        INSERT INTO players (slot_index, player_id, data) 
        VALUES ($slot, $player, $data)
        ON CONFLICT(player_id) DO UPDATE SET 
            data = excluded.data
    `);
        db.transaction((data) =>
        {
            for (const d of data) {
                prep.run({ $slot: d.slotIndex, $player: d.playerId, $data: d.data });
            }
        })(playerData);
    }

    export const getPlayerDataEntryByID = (db: Database, playerID: string) => db.query(`
  SELECT * FROM players 
  WHERE player_id = ? 
  ORDER BY increment DESC 
  LIMIT 1
`).get(playerID);

    export const initSavesTable = (db: Database) =>
    {
        db.run(`
      CREATE TABLE IF NOT EXISTS saves (
        increment INTEGER PRIMARY KEY AUTOINCREMENT,
        player_id TEXT UNIQUE,
        data TEXT
      )
    `);
    }

    export const insertSave = (db: Database,
        playerData: {
            playerId: string,
            data: string,
        }[]
    ) =>
    {

        const prep = db.prepare(`
        INSERT INTO saves (player_id, data) 
        VALUES ($player, $data)
        ON CONFLICT(player_id) DO UPDATE SET 
            data = excluded.data
    `);

        db.transaction((data: typeof playerData) =>
        {
            for (const d of data) {
                prep.run({ $player: d.playerId, $data: d.data });
            }
        })(playerData);
    }

    export const getSavesOfPlayerByID = (db: Database, playerID: string) => db.query(`
  SELECT * FROM saves 
  WHERE player_id = ? 
  ORDER BY increment DESC 
  LIMIT 1
`).get(playerID);
}