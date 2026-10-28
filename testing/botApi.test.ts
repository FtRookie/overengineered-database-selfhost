import { expect, test } from "bun:test";
import { Database } from "bun:sqlite";
import { Elysia } from "elysia";
import { BotApi } from "../Classes/BotApi";
import { DatabaseInteractions } from "../Classes/DatabaseInteractions";

const { grantsOf, isAuthorized } = BotApi;

test("reads the top-level blocks map, not slots[].blocks", () => {
    const row = JSON.stringify({ slots: [{ index: 1, blocks: 669 }], blocks: { luacircuit: 3 } });
    expect(grantsOf("1", row)).toEqual({ kind: "grants", entries: [{ userId: "1", key: "luacircuit", value: 3 }] });
});

test("absent, null or empty blocks is no grants", () => {
    expect(grantsOf("1", JSON.stringify({ slots: [{ blocks: 10 }] }))).toEqual({ kind: "none" });
    expect(grantsOf("1", JSON.stringify({ blocks: null }))).toEqual({ kind: "none" });
    expect(grantsOf("1", JSON.stringify({ blocks: {} }))).toEqual({ kind: "none" });
});

test("a row stringified more than once is peeled", () => {
    const row = JSON.stringify(JSON.stringify({ blocks: { luacircuit: 1 } }));
    expect(grantsOf("2", row)).toEqual({ kind: "grants", entries: [{ userId: "2", key: "luacircuit", value: 1 }] });
});

// an audit must surface what is actually stored, so odd keys and values pass through untouched
test("keys and values are reported as stored", () => {
    const row = JSON.stringify({ blocks: { "bad key": 2.5, x: "7" } });
    expect(grantsOf("5", row)).toEqual({
        kind: "grants",
        entries: [{ userId: "5", key: "bad key", value: 2.5 }, { userId: "5", key: "x", value: "7" }],
    });
});

test("unparseable rows and non-map blocks are corrupt, not dropped", () => {
    expect(grantsOf("6", "{not json").kind).toBe("corrupt");
    expect(grantsOf("7", JSON.stringify({ blocks: [1, 2] }))).toEqual({ kind: "corrupt", reason: "blocks is an array" });
    expect(grantsOf("8", JSON.stringify([1]))).toEqual({ kind: "corrupt", reason: "row is not an object" });
});

test("bearer check is exact", () => {
    expect(isAuthorized("Bearer s3cret", "s3cret")).toBe(true);
    expect(isAuthorized("Bearer s3cre", "s3cret")).toBe(false);
    expect(isAuthorized("s3cret", "s3cret")).toBe(false);
    expect(isAuthorized(undefined, "s3cret")).toBe(false);
});

const serve = (token: string | undefined) => {
    const db = new Database(":memory:");
    DatabaseInteractions.initPlayerTable(db);
    const insert = db.prepare(`INSERT INTO players (playerID, data) VALUES (?, ?)`);
    insert.run("1", JSON.stringify({ blocks: { luacircuit: 3, motorblock: 50 } }));
    insert.run("2", JSON.stringify({ slots: [{ blocks: 10 }] }));
    insert.run("3", "{not json");

    const app = new Elysia();
    BotApi.init(app, db, "overengineered", token);
    const get = (path: string, auth?: string) =>
        app.handle(new Request(`http://localhost/overengineered${path}`, { headers: auth ? { authorization: auth } : {} }));
    return { db, get };
};

test("no token means no routes", async () => {
    const { get } = serve(undefined);
    expect((await get("/bot/grants", "Bearer x")).status).toBe(404);
});

test("routes refuse a missing or wrong token", async () => {
    const { get } = serve("tok");
    expect((await get("/bot/grants")).status).toBe(401);
    expect((await get("/bot/player/1/blocks", "Bearer nope")).status).toBe(401);
});

test("one player's blocks", async () => {
    const { get } = serve("tok");
    const ok = await get("/bot/player/1/blocks", "Bearer tok");
    expect(ok.status).toBe(200);
    expect(await ok.json()).toEqual({ playerID: "1", blocks: { luacircuit: 3, motorblock: 50 } });

    expect(await (await get("/bot/player/2/blocks", "Bearer tok")).json()).toEqual({ playerID: "2", blocks: {} });
    expect((await get("/bot/player/404/blocks", "Bearer tok")).status).toBe(404);
    expect((await get("/bot/player/3/blocks", "Bearer tok")).status).toBe(500);
});

test("full grant scan, and it never writes", async () => {
    const { db, get } = serve("tok");
    const before = db.query(`SELECT playerID, data FROM players ORDER BY playerID`).all();

    const body = await (await get("/bot/grants", "Bearer tok")).json();
    expect(body.rowsScanned).toBe(3);
    expect(body.rowsWithGrants).toBe(1);
    expect(body.entries).toEqual([
        { userId: "1", key: "luacircuit", value: 3 },
        { userId: "1", key: "motorblock", value: 50 },
    ]);
    expect(body.corrupt).toEqual([{ playerID: "3", reason: "not valid JSON" }]);

    expect(db.query(`SELECT playerID, data FROM players ORDER BY playerID`).all()).toEqual(before);
});
