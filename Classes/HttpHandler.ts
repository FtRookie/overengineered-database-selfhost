import { Elysia, t } from 'elysia';
import { DatabaseInteractions, type DataResult, type SaveResult } from './DatabaseInteractions';
import { Database } from "bun:sqlite";
import { write_token } from '../Access Tokens/securityTokens';


// AI slop here :)
function splitUtf8(str: string, maxBytes = 4096)
{
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
type errType = "OUT_OF_INDEX" | "NOT_FOUND" | "INCORRECT_TOKEN";
type errcode = { error: string, err_type: errType } | { status: string };

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

const findCachedSaveData = (id: playerID, index: slotIndex) =>
{
    const playerCached = cachedSaveData.get(id);
    if (!playerCached) {
        cachedSaveData.set(id, new Map());
        return;
    }

    return playerCached.get(index);
};


const updateSaveCache = (db: Database, id: playerID, index: slotIndex) =>
{
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

export namespace HttpHandler
{
    export const init = (db: Database, base: string, port: number) =>
    {
        const app = new Elysia();
        app.listen(port);

        // read player data by id
        app.get(`/${base}/player/:id`, ({ params: { id } }): errcode | DataResult =>
        {
            const player = DatabaseInteractions.getDataEntryByID(db, id);
            return player ?? { error: 'Not found', err_type: "NOT_FOUND" };
        });

        // read all saves by player id
        app.get(`/${base}/save/:id`, ({ params: { id } }): errcode | { saves: SaveResult[] } =>
        {
            const saves = DatabaseInteractions.getSavesOfPlayerByID(db, id);
            return saves ? ({ saves }) : { error: 'Not found', err_type: "NOT_FOUND" };
        });

        // read single save by player id
        app.get(`/${base}/save/:id/:index`, ({ params: { id, index } }): errcode | string =>
        {
            const save = updateSaveCache(db, id, index);
            return save.data ?? { error: 'Not found', err_type: "NOT_FOUND" };
        });

        // read single save by player id by page 
        app.get(`/${base}/save/:id/:index/:page`, ({ params: { id, index, page } }): errcode | string =>
        {
            const pg = Number(page);
            if (isNaN(pg)) return { error: 'No page found', err_type: "NOT_FOUND" };

            const save = updateSaveCache(db, id, index);
            const indexOutOfBounds = pg > save.slicedData.length - 1;
            return indexOutOfBounds ?
                { error: 'Page out of index', err_type: "OUT_OF_INDEX" } :
                save.slicedData[pg] ?? { error: 'Not found', err_type: "NOT_FOUND" };
        });

        // write player
        app.post(`/${base}/player`, ({ body }): errcode =>
        {
            if (body.token !== write_token) return { error: "Incorrect token", err_type: "INCORRECT_TOKEN" };
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
        app.post(`/${base}/save`, ({ body }): errcode =>
        {
            if (body.token !== write_token) return { error: "Incorrect token", err_type: "INCORRECT_TOKEN" };
            DatabaseInteractions.insertSave(db, [body]);

            const saveForCache = {
                data: body.data,
                slicedData: splitUtf8(body.data, 1_000_000)
            };
            cachedSaveData.get(body.playerID)?.set(body.index, saveForCache);
            // remove that from the cache after 30 mins
            setTimeout(
                () => cachedSaveData.get(body.playerID)?.delete(body.index),
                30 * 60 * 1_000
            );

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