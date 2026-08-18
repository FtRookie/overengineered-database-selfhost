import { expect, test } from "bun:test";
import { LegacyJson } from "../Classes/LegacyJson";

const { peel, unslash, needsUnslashing, FAILED, MAX_PEELS } = LegacyJson;

// --- provenance, which is the only sound signal ---

test("the legacy dump is unslashed, migrations.txt is not", () => {
    expect(needsUnslashing("saves_2019_part1.txt")).toBe(true);
    expect(needsUnslashing("migrations.txt")).toBe(false);
});

test("why it cannot be decided by inspection: doubling often keeps the JSON valid", () => {
    const good = JSON.stringify({ note: "line one\nline two" });
    const damaged = good.replaceAll("\\", "\\\\");

    // damaged parses perfectly well, it is just wrong — so "does it parse" proves nothing
    expect(() => JSON.parse(damaged)).not.toThrow();
    expect(JSON.parse(damaged).note).not.toBe("line one\nline two");
    expect(JSON.parse(unslash(damaged)).note).toBe("line one\nline two");
});

test("unslashing a healthy row would corrupt it, which is why migrations.txt is excluded", () => {
    const source = String.raw`print("a\\b")`;
    const healthy = JSON.stringify({ config: { source } });

    expect(JSON.parse(healthy).config.source).toBe(source);
    expect(JSON.parse(unslash(healthy)).config.source).not.toBe(source);
});

// --- peel: bounded, and unchanged in meaning ---

test("multiply stringified rows are peeled", () => {
    const slot = { version: 38, blocks: [] };
    expect(peel(JSON.stringify(JSON.stringify(JSON.stringify(slot))))).toEqual(slot);
});

test("an already-parsed object passes straight through", () => {
    const obj = { version: 38, blocks: [] };
    expect(peel(obj)).toBe(obj);
});

test("nesting past the cap is refused rather than looped forever", () => {
    let nested = JSON.stringify({ version: 38 });
    for (let i = 0; i < MAX_PEELS + 2; i++) nested = JSON.stringify(nested);
    expect(peel(nested)).toBe(FAILED);
});

test("unparseable input is refused rather than thrown", () => {
    expect(peel("{ not json")).toBe(FAILED);
});
