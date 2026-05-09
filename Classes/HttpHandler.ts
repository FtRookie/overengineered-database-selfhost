import { Elysia, t } from 'elysia';
import { DatabaseInteractions, type SaveResult } from './DatabaseInteractions';
import { Database } from "bun:sqlite";
import { write_token } from '../Access Tokens/securityTokens';


// AI slop here :)
function splitUtf8(str: string, maxBytes = 4096) {
    const buffer = Buffer.from(str, 'utf8');
    const chunks = [];
    let offset = 0;

    while (offset < buffer.length) {
        let end = offset + maxBytes;

        while (end > offset && (buffer[end]! & 0xC0) === 0x80) {
            end--;
        }

        if (end === offset) {
            const byte = buffer[offset]!;
            let charLen = 1;
            if ((byte & 0xE0) === 0xC0) charLen = 2;
            else if ((byte & 0xF0) === 0xE0) charLen = 3;
            else if ((byte & 0xF8) === 0xF0) charLen = 4;
            end = offset + charLen;
        }

        chunks.push(buffer.subarray(offset, end).toString('utf8'));
        offset = end;
    }

    return chunks;
}

type playerID = string;
type slotIndex = string;

const cachedSaveData = new Map<
    playerID,
    Map<
        slotIndex,
        {
            data: string,
            slicedData: string[]
        }
    >
>();

const findCachedSaveData = (id: playerID, index: slotIndex) => {
    const playerCached = cachedSaveData.get(id);
    if (!playerCached) {
        cachedSaveData.set(id, new Map());
        return;
    }

    return playerCached.get(index);
};


const updateSaveCache = (db: Database, id: playerID, index: slotIndex) => {
    let cachedSave = findCachedSaveData(id, index);
    if (!cachedSave) {
        const gotSave: SaveResult = DatabaseInteractions.getSavesOfPlayerByIDWithIndex(db, id, index);
        const saveStr = JSON.stringify(gotSave);
        cachedSave = {
            data: saveStr,
            slicedData: splitUtf8(saveStr, 1_000_000)
        };
        cachedSaveData.get(id)!.set(index, cachedSave);

        // remove that from the cache after 30 mins
        setTimeout(
            () => cachedSaveData.get(id)?.delete(index),
            30 * 60 * 1_000
        );
    }
    return cachedSave;
}

export namespace HttpHandler {
    export const init = (db: Database, base: string, port: number) => {
        const app = new Elysia();
        app.listen(port);

        // read player data by id
        app.get(`/${base}/player/:id`, ({ params: { id } }) => {
            const player = DatabaseInteractions.getDataEntryByID(db, id);
            return player ?? { error: 'Not found' };
        });

        // read all saves by player id
        app.get(`/${base}/save/:id`, ({ params: { id } }) => {
            const saves = DatabaseInteractions.getSavesOfPlayerByID(db, id);
            return saves ? ({ saves }) : { error: 'Not found' };
        });

        // read single save by player id
        app.get(`/${base}/save/:id/:index`, ({ params: { id, index } }) => {
            const save = updateSaveCache(db, id, index);
            return save.data ?? { error: 'Not found' };
        });

        // read single save by player id by page 
        app.get(`/${base}/save/:id/:index/:page`, ({ params: { id, index, page } }) => {
            const pg = Number(page);
            if (isNaN(pg)) return { error: 'No page found' };

            const save = updateSaveCache(db, id, index);
            const indexOutOfBounds = pg > save.slicedData.length - 1;
            return indexOutOfBounds ?
                { error: 'Page out of index' } :
                save.slicedData[pg] ?? { error: 'Not found' };
        });

        // write player
        app.post(`/${base}/player`, ({ body }) => {
            if (body.token !== write_token) return { error: "incorrect token" };
            DatabaseInteractions.insertPlayers(db, [body]);
            return { status: 'ok' };
        }, {
            body: t.Object({
                playerID: t.String(),
                data: t.String(),
                token: t.String(),
            })
        });

        // write save (I'm not doing batches)
        app.post(`/${base}/save`, ({ body }) => {
            if (body.token !== write_token) return { error: "incorrect token" };
            DatabaseInteractions.insertSave(db, [body]);
            return { status: 'ok' };
        }, {
            body: t.Object({
                playerID: t.String(),
                index: t.String(),
                data: t.String(),
                token: t.String(),
            })
        });

        console.log(`HTTP is running on http://localhost:${port}`);
    }
}