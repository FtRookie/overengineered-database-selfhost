import { Elysia } from 'elysia';
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
 * Bot → Backend: a read-only API for the Discord bot, opt-in per deployment.
 *
 * Mounted only when `Access Tokens/BOT_TOKEN` exists. Unlike the write and admin tokens no placeholder is
 * generated, so a self-host that never set up the bot integration exposes none of these routes and sees no
 * new warning.
 *
 * Read-only by design, and not just for now: the game's DataStore is authoritative and this database holds a
 * coalesced mirror of it. A write here would never reach a game server, and the next mirror would overwrite
 * it. Anything that must change player data still goes through the game.
 */
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

        console.log("BOT_TOKEN: Token found, the bot API is enabled.");
    };
}
