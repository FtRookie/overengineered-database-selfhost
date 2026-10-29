import { expect, test } from "bun:test";
import { Database } from "bun:sqlite";
import { Elysia } from "elysia";
import { BotApi } from "../Classes/BotApi";
import { DatabaseInteractions } from "../Classes/DatabaseInteractions";

const { setBlockLimit, getPendingChanges, reconcilePush, insertPlayers } = DatabaseInteractions;

const fresh = () => {
    const db = new Database(":memory:");
    DatabaseInteractions.initPlayerTable(db);
    return db;
};
const rowOf = (db: Database, id: string) => JSON.parse(DatabaseInteractions.getRawPlayerDataEntryByID(db, id)!.data);

// pending changes are module state shared by every test, so each test uses its own player ids

test("a limit lands in the row's blocks map and leaves the rest of the row alone", () => {
    const db = fresh();
    insertPlayers(db, [{ playerID: "101", data: { settings: { a: 1 }, blocks: { makster: 2 } } }]);

    expect(setBlockLimit(db, "101", "luacircuit", 1)).toEqual({ ok: true, blocks: { makster: 2, luacircuit: 1 } });
    expect(rowOf(db, "101")).toEqual({ settings: { a: 1 }, blocks: { makster: 2, luacircuit: 1 } });
});

test("removal leaves no key behind", () => {
    const db = fresh();
    insertPlayers(db, [{ playerID: "102", data: { blocks: { luacircuit: 1, makster: 2 } } }]);

    setBlockLimit(db, "102", "luacircuit", undefined);
    expect(rowOf(db, "102").blocks).toEqual({ makster: 2 });
});

test("a player with no row gets one holding only the limit", () => {
    const db = fresh();
    setBlockLimit(db, "103", "luacircuit", 1);
    expect(rowOf(db, "103")).toEqual({ blocks: { luacircuit: 1 } });
});

test("a corrupt row is refused, not replaced, and nothing is held pending", () => {
    const db = fresh();
    db.prepare(`INSERT INTO players (playerID, data) VALUES (?, ?)`).run("104", "{not json");

    expect(setBlockLimit(db, "104", "luacircuit", 1).ok).toBe(false);
    expect(DatabaseInteractions.getRawPlayerDataEntryByID(db, "104")!.data).toBe("{not json");
    expect(getPendingChanges("104")).toEqual({});
});

test("a push that predates the change gets it laid back on top, and it stays pending", () => {
    const db = fresh();
    insertPlayers(db, [{ playerID: "105", data: { settings: { a: 1 } } }]);
    setBlockLimit(db, "105", "luacircuit", 1);

    const pushed = reconcilePush({ playerID: "105", data: { settings: { a: 2 } } });
    expect(pushed.data).toEqual({ settings: { a: 2 }, blocks: { luacircuit: 1 } });
    expect(getPendingChanges("105")).toEqual({ blocks: { luacircuit: 1 } });
});

test("a push carrying the change drops it from pending", () => {
    setBlockLimit(fresh(), "106", "luacircuit", 1);

    reconcilePush({ playerID: "106", data: { blocks: { luacircuit: 1 } } });
    expect(getPendingChanges("106")).toEqual({});
});

test("an emptied map matches the game's `[]` or a missing key", () => {
    const db = fresh();
    insertPlayers(db, [{ playerID: "107", data: { blocks: { luacircuit: 1 } } }]);
    setBlockLimit(db, "107", "luacircuit", undefined);

    reconcilePush({ playerID: "107", data: { blocks: [] } });
    expect(getPendingChanges("107")).toEqual({});

    setBlockLimit(db, "108", "luacircuit", 1);
    setBlockLimit(db, "108", "luacircuit", undefined);
    reconcilePush({ playerID: "108", data: { settings: {} } });
    expect(getPendingChanges("108")).toEqual({});
});

test("a push for a player with nothing pending passes through unchanged", () => {
    const incoming = { playerID: "109", data: { settings: {} } };
    expect(reconcilePush(incoming)).toBe(incoming);
});

const serve = (id: string) => {
    const db = fresh();
    insertPlayers(db, [{ playerID: id, data: { settings: {} } }]);
    const app = new Elysia();
    BotApi.init(app, db, "overengineered", "tok");
    const call = (method: string, path: string, body?: unknown, auth = "Bearer tok") =>
        app.handle(new Request(`http://localhost/overengineered${path}`, {
            method,
            headers: { authorization: auth, ...(body ? { "content-type": "application/json" } : {}) },
            body: body ? JSON.stringify(body) : undefined,
        }));
    return { db, call };
};

test("bot routes: put, read and delete a limit", async () => {
    const { call } = serve("110");

    const put = await call("PUT", "/bot/player/110/blocks/luacircuit", { limit: 1 });
    expect(put.status).toBe(200);
    expect(await put.json()).toEqual({ playerID: "110", blocks: { luacircuit: 1 } });

    expect(await (await call("GET", "/bot/player/110/blocks")).json()).toEqual({ playerID: "110", blocks: { luacircuit: 1 } });
    expect(getPendingChanges("110")).toEqual({ blocks: { luacircuit: 1 } });

    const del = await call("DELETE", "/bot/player/110/blocks/luacircuit");
    expect(await del.json()).toEqual({ playerID: "110", blocks: {} });
});

test("bot routes: refuse a wrong token, a bad id, and an out-of-range limit", async () => {
    const { db, call } = serve("111");
    const before = rowOf(db, "111");

    expect((await call("PUT", "/bot/player/111/blocks/luacircuit", { limit: 1 }, "Bearer nope")).status).toBe(401);
    expect((await call("DELETE", "/bot/player/111/blocks/luacircuit", undefined, "Bearer nope")).status).toBe(401);
    expect((await call("PUT", "/bot/player/111/blocks/bad%20id", { limit: 1 })).status).toBe(422);
    expect((await call("PUT", "/bot/player/abc/blocks/luacircuit", { limit: 1 })).status).toBe(422);
    expect((await call("PUT", "/bot/player/111/blocks/luacircuit", { limit: 5001 })).status).toBe(422);
    expect((await call("PUT", "/bot/player/111/blocks/luacircuit", { limit: 1.5 })).status).toBe(422);

    expect(rowOf(db, "111")).toEqual(before);
    expect(getPendingChanges("111")).toEqual({});
});
