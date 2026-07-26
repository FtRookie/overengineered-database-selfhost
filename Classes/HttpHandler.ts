import { Elysia, t } from 'elysia';
import { Database } from "bun:sqlite";
import { ADMIN_TOKEN, isUsingPlaceholderAdminToken, isUsingPlaceholderWriteToken, logMigration, WRITE_TOKEN } from '..';
import { GameEventsHandler } from './GameEventsHandler';
import { DatabaseInteractions, type SavedPlayerFormat, type ParsedSlotFormatWithIndex, type ParsedSlotFormat } from './DatabaseInteractions';

export type ErrorType = "OUT_OF_INDEX" | "NOT_FOUND" | "INCORRECT_TOKEN" | "INSERT_FAIL" | "CORRUPT_ROW";
type ErrorCode = { error: string, err_type: ErrorType } | { status: string };
type MigrationResult = { error: string, err_type: ErrorType } | { metadata: string, saves: string }

type PlayerID = string;
type SlotIndex = string;
type PreparedCachedSaveData = {
    data: { [key: string]: unknown },
    slicedData: string[]
    timeout?: ReturnType<typeof setTimeout>
};
const cachedSaveData = new Map<
    PlayerID,
    Map<SlotIndex, PreparedCachedSaveData>
>();

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

// Roblox caps a response it can read, so a save is handed out in pages this size.
const PAGE_BYTES = 1_000_000;
const CACHE_TTL_MS = 30 * 60 * 1_000;

/**
 * Writes INVALIDATE the cache; they never rebuild it.
 *
 * They used to. The read path cached JSON.stringify(row) — the whole row, blob nested under .data — and the
 * write path cached JSON.stringify(body.data), just the blob. Same key, two different shapes, decided by
 * whichever happened to run first. Dropping the entry is simpler and is the only version that cannot drift.
 */
const dropCachedSave = (id: PlayerID, index: SlotIndex) =>
{
    const forPlayer = cachedSaveData.get(id);
    const cached = forPlayer?.get(index);
    if (!cached) return;

    clearTimeout(cached.timeout);
    forPlayer!.delete(index);
};

const updateSaveCache = (db: Database, id: PlayerID, index: SlotIndex): PreparedCachedSaveData | undefined =>
{
    let forPlayer = cachedSaveData.get(id);
    if (!forPlayer) {
        forPlayer = new Map();
        cachedSaveData.set(id, forPlayer);
    }

    let cached = forPlayer.get(index);
    if (!cached) {
        const row = DatabaseInteractions.getSavesOfPlayerByIDWithIndex(db, id, index);
        if (!row) return; // nothing to cache

        cached = { data: row.data, slicedData: splitUtf8(JSON.stringify(row), PAGE_BYTES) };
        forPlayer.set(index, cached);
    }

    clearTimeout(cached.timeout);
    cached.timeout = setTimeout(() => dropCachedSave(id, index), CACHE_TTL_MS);

    return cached;
}

/**
 * Chunked uploads.
 *
 * Roblox caps an outgoing request body at roughly 1MB, so a large build cannot be written in one POST — no
 * amount of proxy configuration changes that, the engine simply will not send it. It arrives in pieces
 * instead, and is committed only once every piece is here.
 *
 * A partial upload never touches the saves table. An interrupted save therefore leaves the player's existing
 * slot exactly as it was, which is the whole point: half a build written over a good one is worse than no
 * save at all.
 */
type UploadID = string;
type PendingUpload = {
    playerID: PlayerID,
    index: SlotIndex,
    parts: (string | undefined)[],
    received: number,
    bytes: number,
    timeout: ReturnType<typeof setTimeout>
};

const pendingUploads = new Map<UploadID, PendingUpload>();

const UPLOAD_TTL_MS = 5 * 60 * 1_000;
const MAX_UPLOAD_PARTS = 64;
const MAX_UPLOAD_BYTES = 32 * 1024 * 1024;

const dropUpload = (uploadID: UploadID) =>
{
    const upload = pendingUploads.get(uploadID);
    if (!upload) return;

    clearTimeout(upload.timeout);
    pendingUploads.delete(uploadID);
};

const touchUpload = (uploadID: UploadID, upload: PendingUpload) =>
{
    clearTimeout(upload.timeout);
    upload.timeout = setTimeout(() => dropUpload(uploadID), UPLOAD_TTL_MS);
};

/** Offset of the first string token not followed by ':' ',' '}' ']'. Token walk, not regex — a regex matches inside string contents. */
const findBrokenSeparator = (text: string): number | undefined =>
{
    let i = 0;
    while (i < text.length) {
        if (text[i] !== '"') { i++; continue; }

        let end = i + 1;
        while (end < text.length && text[end] !== '"') end += text[end] === "\\" ? 2 : 1;
        if (end >= text.length) return i; // unterminated string

        let after = end + 1;
        while (after < text.length && /\s/.test(text[after]!)) after++;

        const next = text[after];
        if (next !== undefined && next !== ":" && next !== "," && next !== "}" && next !== "]") return i;
        i = end + 1;
    }
    return undefined;
};

export namespace HttpHandler
{
    export const init = (db: Database, base: string, port: number) =>
    {
        const app = new Elysia();
        app.listen(port);

        // read player data by id
        app.get(`/${base}/player/:id`, ({ params: { id }, set }): ErrorCode | SavedPlayerFormat =>
        {
            // Must stay non-200: the game reads a 200-with-error as "no row yet" and would overwrite the player.
            try {
                const player = DatabaseInteractions.getPlayerDataEntryByID(db, id);
                return player ?? { error: 'Not found', err_type: "NOT_FOUND" };
            } catch (err) {
                set.status = 500;
                return { error: `Stored data for player ${id} is not valid JSON: ${err}`, err_type: "CORRUPT_ROW" };
            }
        });

        // raw row, for one the parser rejects
        app.get(`/${base}/player/:id/raw`, ({ params: { id } }) =>
        {
            const row = DatabaseInteractions.getRawPlayerDataEntryByID(db, id);
            if (!row) return { error: 'Not found', err_type: "NOT_FOUND" };

            const data = row.data ?? "";
            let parseError: string | undefined;
            try { JSON.parse(data); } catch (err) { parseError = String(err); }

            const suspectAt = findBrokenSeparator(data);

            return {
                playerID: row.playerID,
                length: data.length,
                parseError,
                suspectAt,
                suspect: suspectAt === undefined ? undefined : data.slice(Math.max(0, suspectAt - 120), suspectAt + 120),
                data,
            };
        });

        // hand repair of a rejected row
        app.post(`/${base}/player/raw`, ({ body }): ErrorCode =>
        {
            if (isUsingPlaceholderAdminToken) return { error: "Using placeholder token", err_type: "INCORRECT_TOKEN" };
            if (body.token !== ADMIN_TOKEN) return { error: "Incorrect token", err_type: "INCORRECT_TOKEN" };

            // Parse first: a repair must not leave the row worse.
            let parsed: unknown;
            try { parsed = JSON.parse(body.data); } catch (err) {
                return { error: `Refused, the replacement is not valid JSON: ${err}`, err_type: "INSERT_FAIL" };
            }
            if (typeof parsed !== "object" || parsed === null || Array.isArray(parsed)) {
                return { error: "Refused, the replacement is not a JSON object", err_type: "INSERT_FAIL" };
            }

            return DatabaseInteractions.insertPlayers(db, [{ playerID: body.playerID, data: parsed as SavedPlayerFormat["data"] }]) === "SUCCESS"
                ? { status: 'ok' }
                : { error: "Error while upserting player metadata", err_type: "INSERT_FAIL" };
        }, {
            body: t.Object({
                playerID: t.String(),
                data: t.String(),
                token: t.String(),
            })
        });

        // read all saves by player id
        app.get(`/${base}/save/:id`, ({ params: { id } }): ErrorCode | { saves: ParsedSlotFormat["data"][] } =>
        {
            const saves = DatabaseInteractions.getSavesOfPlayerByID(db, id);
            return saves ? { saves: saves.map(s => s.data) } : { error: 'Not found', err_type: "NOT_FOUND" };
        });

        // read single save by player id
        app.get(`/${base}/save/:id/:index`, ({ params: { id, index } }): ErrorCode | string =>
        {
            const save = updateSaveCache(db, id, index);
            if (save) return JSON.stringify(save.data);
            return { error: 'Not found', err_type: "NOT_FOUND" };
        });

        // read single save by player id by page 
        app.get(`/${base}/save/:id/:index/:page`, ({ params: { id, index, page } }): ErrorCode | string =>
        {
            const pg = Number(page);
            if (isNaN(pg)) return { error: 'No page found', err_type: "NOT_FOUND" };

            const save = updateSaveCache(db, id, index);
            if (!save) return { error: 'Not found', err_type: "NOT_FOUND" };

            const indexOutOfBounds = pg > save.slicedData.length - 1;
            return indexOutOfBounds ?
                { error: 'Page out of index', err_type: "OUT_OF_INDEX" } :
                save?.slicedData[pg] ?? { error: 'Not found', err_type: "NOT_FOUND" };
        });

        //get events
        app.get(`/${base}/events`, ({ query }) =>
            GameEventsHandler.getEventsAfterTimestamp(query.time),
            {
                query: t.Object({
                    time: t.Number()
                })
            });

        //get events
        app.post(`/${base}/events`, ({ body }) =>
        {
            if (isUsingPlaceholderAdminToken) return { error: "Using placeholder token", err_type: "INCORRECT_TOKEN" };
            if (body.token !== ADMIN_TOKEN) return { error: "Incorrect token", err_type: "INCORRECT_TOKEN" };
            GameEventsHandler.addEvent(body.data);
            return { status: "ok" };
        },
            {
                body: t.Object({
                    data: t.Any(),
                    token: t.String()
                })
            });

        // write player
        app.post(`/${base}/player`, ({ body }): ErrorCode =>
        {
            if (isUsingPlaceholderWriteToken) return { error: "Using placeholder token", err_type: "INCORRECT_TOKEN" };
            if (body.token !== WRITE_TOKEN) return { error: "Incorrect token", err_type: "INCORRECT_TOKEN" };
            if (!Object.keys(body.data).length) return { error: "Incorrect body data type", err_type: "INSERT_FAIL" };
            return DatabaseInteractions.insertPlayers(db, [body]) === "SUCCESS"
                ? { status: 'ok' }
                : { error: "Error while upserting player metadata", err_type: "INSERT_FAIL" };
        }, {
            body: t.Object({
                playerID: t.String(),
                data: t.Record(t.String(), t.Any()),
                token: t.String(),
            })
        });

        // write save (I'm not doing batches)
        app.post(`/${base}/save`, ({ body }): ErrorCode =>
        {
            if (isUsingPlaceholderWriteToken) return { error: "Using placeholder token", err_type: "INCORRECT_TOKEN" };
            if (body.token !== WRITE_TOKEN) return { error: "Incorrect token", err_type: "INCORRECT_TOKEN" };
            if (!Object.keys(body.data).length) return { error: "Incorrect body data type", err_type: "INSERT_FAIL" };

            const insertResult = DatabaseInteractions.insertSave(db, [body]);
            if (insertResult === "FAIL") return { error: "Error while upserting save data", err_type: "INSERT_FAIL" };

            dropCachedSave(body.playerID, body.index);
            return { status: 'ok' };
        }, {
            body: t.Object({
                playerID: t.String(),
                index: t.String(),
                data: t.Record(t.String(), t.Any()),
                token: t.String(),
            })
        });

        // write save in pieces, for builds Roblox cannot send in one request. See pendingUploads.
        app.post(`/${base}/save/chunk`, ({ body }): ErrorCode =>
        {
            if (isUsingPlaceholderWriteToken) return { error: "Using placeholder token", err_type: "INCORRECT_TOKEN" };
            if (body.token !== WRITE_TOKEN) return { error: "Incorrect token", err_type: "INCORRECT_TOKEN" };

            if (body.parts < 1 || body.parts > MAX_UPLOAD_PARTS) return { error: `parts must be 1..${MAX_UPLOAD_PARTS}`, err_type: "INSERT_FAIL" };
            if (body.part < 0 || body.part >= body.parts) return { error: "part is out of range", err_type: "INSERT_FAIL" };

            let upload = pendingUploads.get(body.uploadID);
            if (!upload) {
                upload = {
                    playerID: body.playerID,
                    index: body.index,
                    parts: new Array(body.parts).fill(undefined),
                    received: 0,
                    bytes: 0,
                    timeout: setTimeout(() => dropUpload(body.uploadID), UPLOAD_TTL_MS)
                };
                pendingUploads.set(body.uploadID, upload);
            }

            // One upload id belongs to one slot. Without this, a second caller reusing the id could graft its
            // chunks onto somebody else's build and commit the result over their save.
            if (upload.playerID !== body.playerID || upload.index !== body.index || upload.parts.length !== body.parts) {
                dropUpload(body.uploadID);
                return { error: "Upload id does not match this slot", err_type: "INSERT_FAIL" };
            }

            const existing = upload.parts[body.part];
            if (existing === undefined) upload.received++;
            else upload.bytes -= Buffer.byteLength(existing, 'utf8');

            upload.parts[body.part] = body.data;
            upload.bytes += Buffer.byteLength(body.data, 'utf8');

            if (upload.bytes > MAX_UPLOAD_BYTES) {
                dropUpload(body.uploadID);
                return { error: "Upload is too large", err_type: "INSERT_FAIL" };
            }

            if (upload.received < body.parts) {
                touchUpload(body.uploadID, upload);
                return { status: 'pending' };
            }

            // Parse BEFORE writing. A truncated or mangled upload must fail loudly, not overwrite a good slot
            // with junk that only fails to load months later.
            let data: unknown;
            try {
                data = JSON.parse(upload.parts.join(""));
            } catch {
                dropUpload(body.uploadID);
                return { error: "Assembled upload is not valid JSON", err_type: "INSERT_FAIL" };
            }

            dropUpload(body.uploadID);

            if (!data || typeof data !== 'object' || !Object.keys(data).length) {
                return { error: "Incorrect body data type", err_type: "INSERT_FAIL" };
            }

            const assembled = { playerID: body.playerID, index: body.index, data } as ParsedSlotFormatWithIndex;
            if (DatabaseInteractions.insertSave(db, [assembled]) === "FAIL") {
                return { error: "Error while upserting save data", err_type: "INSERT_FAIL" };
            }

            dropCachedSave(body.playerID, body.index);
            return { status: 'ok' };
        }, {
            body: t.Object({
                playerID: t.String(),
                index: t.String(),
                uploadID: t.String(),
                part: t.Number(),
                parts: t.Number(),
                data: t.String(),
                token: t.String(),
            })
        });

        // copies saves of one person to saves of another person
        app.post(`/${base}/migrate`, ({ body }): MigrationResult =>
        {
            if (isUsingPlaceholderWriteToken) return { error: "Using placeholder token", err_type: "INCORRECT_TOKEN" };
            if (body.token !== WRITE_TOKEN) return { error: "Incorrect token", err_type: "INCORRECT_TOKEN" };

            // Migrate metadata
            const metadata = DatabaseInteractions.getPlayerDataEntryByID(db, body.fromID);
            if (!metadata) return { error: `No meta data from playerID ${body.fromID} was found`, err_type: "NOT_FOUND" }
            const migratedPlayer = { ...metadata, playerID: body.toID, data: metadata!.data } as SavedPlayerFormat;

            // Migrate saves — each keeps its own index.
            const allSaves = DatabaseInteractions.getSavesOfPlayerByID(db, body.fromID);
            if (!allSaves.length) return { error: `No save data from playerID ${body.fromID} was found`, err_type: "NOT_FOUND" }
            const migratedSave = allSaves.map(v => ({ ...v, playerID: body.toID })) as ParsedSlotFormatWithIndex[];

            logMigration({ migratedPlayer, migratedSave })

            const result = {
                metadata: DatabaseInteractions.insertPlayers(db, [migratedPlayer]),
                saves: DatabaseInteractions.insertSave(db, migratedSave)
            };

            // The destination's slots just changed underneath their cache. Without this, whatever was read
            // before the migration keeps being served for the next 30 minutes — the migration would look like
            // it silently did nothing.
            for (const save of migratedSave) dropCachedSave(body.toID, save.index);

            return result;
        }, {
            body: t.Object({
                fromID: t.String(),
                toID: t.String(),
                token: t.String(),
            })
        });

        console.log(`HTTP is running on http://localhost:${port}`);
    }
}

