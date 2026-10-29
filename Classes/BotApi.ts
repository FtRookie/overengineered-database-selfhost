import { Elysia, t } from 'elysia';
import { Database } from "bun:sqlite";
import { timingSafeEqual } from "node:crypto";
import { LegacyJson } from "./LegacyJson";
import { DatabaseInteractions } from "./DatabaseInteractions";

export type GrantEntry = { userId: string, key: string, value: unknown };
export type GrantsOfRow =
    | { kind: "none" }
    | { kind: "grants", entries: GrantEntry[] }
    | { kind: "corrupt", reason: string };

/**
 * Bot → Backend: an API for the Discord bot, opt-in per deployment.
 *
 * Mounted only when `Access Tokens/BOT_TOKEN` exists. Unlike the write and admin tokens no placeholder is
 * generated, so a self-host that never set up the bot integration exposes none of these routes and sees no
 * new warning.
 *
 * The one thing it writes is a player's per-block limits. The write lands in the stored row and is held as a
 * pending change until the game pushes the row back carrying it (see {@link DatabaseInteractions.reconcilePush}).
 */
// A Roblox user id, and a block id as the game spells them. The game's block list cannot be checked from here.
const grantParams = t.Object({
    id: t.String({ pattern: "^[0-9]{1,20}$" }),
    blockId: t.String({ pattern: "^[A-Za-z0-9_]{1,64}$" }),
});

export namespace BotApi {
    /** Grant map of one stored player row. Only the top-level `blocks` map; `slots[].blocks` is a block count. */
    export const grantsOf = (userId: string, stored: unknown): GrantsOfRow => {
        const row = LegacyJson.peel(stored);
        if (row === LegacyJson.FAILED) return { kind: "corrupt", reason: "not valid JSON" };
        if (typeof row !== "object" || row === null || Array.isArray(row)) return { kind: "corrupt", reason: "row is not an object" };

        const blocks = (row as { blocks?: unknown }).blocks;
        if (blocks === undefined || blocks === null) return { kind: "none" };
        if (typeof blocks !== "object" || Array.isArray(blocks)) {
            return { kind: "corrupt", reason: `blocks is ${Array.isArray(blocks) ? "an array" : typeof blocks}` };
        }

        const entries = Object.entries(blocks).map(([key, value]) => ({ userId, key, value }));
        return entries.length ? { kind: "grants", entries } : { kind: "none" };
    };

    /** Constant-time, so the comparison leaks nothing about how much of a guess was right. */
    export const isAuthorized = (header: string | undefined, token: string) => {
        const expected = Buffer.from(`Bearer ${token}`);
        const given = Buffer.from(header ?? "");
        return given.length === expected.length && timingSafeEqual(given, expected);
    };

    export const init = (app: Elysia, db: Database, base: string, token: string | undefined) => {
        if (token === undefined) {
            console.log("BOT_TOKEN: not found, the bot API is disabled.");
            return;
        }

        const unauthorized = { error: "Incorrect token", err_type: "INCORRECT_TOKEN" } as const;

        // one player's grants, for /blocks list
        app.get(`/${base}/bot/player/:id/blocks`, ({ params: { id }, headers, set }) => {
            if (!isAuthorized(headers.authorization, token)) {
                set.status = 401;
                return unauthorized;
            }

            const row = DatabaseInteractions.getRawPlayerDataEntryByID(db, id);
            if (!row) {
                set.status = 404;
                return { error: "Not found", err_type: "NOT_FOUND" };
            }

            const result = grantsOf(id, row.data);
            if (result.kind === "corrupt") {
                set.status = 500;
                return { error: `Stored data for player ${id}: ${result.reason}`, err_type: "CORRUPT_ROW" };
            }

            const blocks = result.kind === "grants"
                ? Object.fromEntries(result.entries.map((e) => [e.key, e.value]))
                : {};
            return { playerID: id, blocks };
        });

        // every grant in the mirror: a full table scan, meant for audits rather than a hot path
        app.get(`/${base}/bot/grants`, ({ headers, set }) => {
            if (!isAuthorized(headers.authorization, token)) {
                set.status = 401;
                return unauthorized;
            }

            let rowsScanned = 0;
            let rowsWithGrants = 0;
            const entries: GrantEntry[] = [];
            const corrupt: { playerID: string, reason: string }[] = [];

            for (const row of DatabaseInteractions.iterateRawPlayers(db)) {
                rowsScanned++;
                const result = grantsOf(row.playerID, row.data);
                if (result.kind === "corrupt") corrupt.push({ playerID: row.playerID, reason: result.reason });
                if (result.kind !== "grants") continue;

                rowsWithGrants++;
                for (const entry of result.entries) entries.push(entry);
            }

            return { rowsScanned, rowsWithGrants, entries, corrupt };
        });

        const writeGrant = (id: string, blockId: string, limit: number | undefined, set: { status?: number | string }) => {
            const result = DatabaseInteractions.setBlockLimit(db, id, blockId, limit);
            if (!result.ok) {
                set.status = 500;
                return { error: result.reason, err_type: "INSERT_FAIL" };
            }
            return { playerID: id, blocks: result.blocks };
        };

        app.put(`/${base}/bot/player/:id/blocks/:blockId`, ({ params: { id, blockId }, body, headers, set }) => {
            if (!isAuthorized(headers.authorization, token)) {
                set.status = 401;
                return unauthorized;
            }
            return writeGrant(id, blockId, body.limit, set);
        }, {
            params: grantParams,
            body: t.Object({ limit: t.Integer({ minimum: 0, maximum: DatabaseInteractions.MAX_BLOCK_LIMIT }) }),
        });

        // absent rather than 0, so a revoked block leaves no key behind
        app.delete(`/${base}/bot/player/:id/blocks/:blockId`, ({ params: { id, blockId }, headers, set }) => {
            if (!isAuthorized(headers.authorization, token)) {
                set.status = 401;
                return unauthorized;
            }
            return writeGrant(id, blockId, undefined, set);
        }, { params: grantParams });

        console.log("BOT_TOKEN: Token found, the bot API is enabled.");
    };
}
