import { expect, test } from "bun:test";
import { CuratedImport } from "../Classes/CuratedImport";

const { isCurated, isLineDelimited, playerRowsFrom, saveRowsFrom } = CuratedImport;

test("both extensions are the curated channel, .txt is not", () => {
    expect(isCurated(".json")).toBe(true);
    expect(isCurated(".jsonl")).toBe(true);
    expect(isCurated(".JSON")).toBe(true);
    expect(isCurated(".txt")).toBe(false);
    expect(isLineDelimited(".jsonl")).toBe(true);
    expect(isLineDelimited(".json")).toBe(false);
});

test("players: one row per user id", () => {
    expect(playerRowsFrom({ "1": { seen1: true }, "2": { seen1: false } }))
        .toEqual([{ playerID: "1", data: { seen1: true } }, { playerID: "2", data: { seen1: false } }]);
});

test("saves: one row per user id and slot index", () => {
    expect(saveRowsFrom({ "1": { "31": { version: 38 }, "34": { version: 38 } } }))
        .toEqual([
            { playerID: "1", index: "31", data: { version: 38 } },
            { playerID: "1", index: "34", data: { version: 38 } },
        ]);
});

// the whole point of the channel: content passes through untouched
test("backslashes survive the curated path exactly", () => {
    const source = String.raw`print("a\\b") -- match %d\d`;
    const rows = saveRowsFrom({ "7": { "1": { blocks: [{ config: { source } }] } } });
    expect((rows[0]!.data as any).blocks[0].config.source).toBe(source);
});

test("malformed input is rejected, not guessed at", () => {
    expect(() => playerRowsFrom([])).toThrow();
    expect(() => playerRowsFrom({ "1": "not an object" })).toThrow();
    expect(() => saveRowsFrom({ "1": { "31": "not an object" } })).toThrow();
});
