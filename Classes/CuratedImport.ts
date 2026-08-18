import type { ParsedSlotFormatWithIndex, SavedPlayerFormat } from "./DatabaseInteractions";

/**
 * The curated import channel: files a maintainer has already repaired by hand, or that this app wrote itself.
 *
 * The `.txt` channel exists for the 2019 dump, which is uniformly double-escaped and must be unslashed. Running
 * that over an already-correct row damages it — and doing it twice damages a row the maintainer just fixed,
 * since `\\\\` becomes `\\` becomes `\`. Rather than trying to detect which is which, correctness is declared by
 * the extension: **nothing in this file is repaired, transformed, or unescaped.**
 *
 * Both `.json` and `.jsonl` are accepted and mean the same thing. `.jsonl` is read a line at a time and is the
 * one to use for anything large; `.json` is parsed whole and is easier to hand-edit.
 *
 * Shape, keyed by user id:
 *
 *   players   { "<userid>": { <player data> } }
 *   saves     { "<userid>": { "<slot index>": { <save data> } } }
 *
 * The nesting for saves is what lets one player hold several slots without repeating a key.
 */
export namespace CuratedImport {
    export const EXTENSIONS = [".json", ".jsonl"] as const;

    export const isCurated = (extension: string) =>
        (EXTENSIONS as readonly string[]).includes(extension.toLowerCase());

    /** `.jsonl` is streamed; `.json` is one document and must be read whole. */
    export const isLineDelimited = (extension: string) => extension.toLowerCase() === ".jsonl";

    const isObject = (value: unknown): value is Record<string, unknown> =>
        typeof value === "object" && value !== null && !Array.isArray(value);

    /** `{ "<userid>": { … } }` → one row per user id. */
    export const playerRowsFrom = (parsed: unknown): SavedPlayerFormat[] => {
        if (!isObject(parsed)) throw new Error("expected an object keyed by user id");

        return Object.entries(parsed).map(([playerID, data]) => {
            if (!isObject(data)) throw new Error(`player ${playerID}: expected an object of player data`);
            return { playerID, data };
        });
    };

    /** `{ "<userid>": { "<index>": { … } } }` → one row per user id and slot index. */
    export const saveRowsFrom = (parsed: unknown): ParsedSlotFormatWithIndex[] => {
        if (!isObject(parsed)) throw new Error("expected an object keyed by user id");

        const rows: ParsedSlotFormatWithIndex[] = [];
        for (const [playerID, slots] of Object.entries(parsed)) {
            if (!isObject(slots)) throw new Error(`player ${playerID}: expected an object keyed by slot index`);

            for (const [index, data] of Object.entries(slots)) {
                if (!isObject(data)) throw new Error(`player ${playerID} slot ${index}: expected an object`);
                rows.push({ playerID, index, data });
            }
        }

        return rows;
    };
}
