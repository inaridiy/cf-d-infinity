// 同じ ShardCore を本物の workerd と DO の SQLite で動かす結合テスト。
import { execFileSync } from "node:child_process";
import { readFileSync } from "node:fs";
import { createClient } from "@libsql/client";
import { eq } from "drizzle-orm";
import { drizzle } from "drizzle-orm/libsql";
import { integer, sqliteTable, text } from "drizzle-orm/sqlite-core";
import { Miniflare } from "miniflare";
import { afterAll, beforeAll, describe, expect, it } from "vitest";

let mf: Miniflare;

async function post(path: string, body: unknown) {
  const r = await mf.dispatchFetch(`http://x${path}`, {
    method: "POST", body: JSON.stringify(body), headers: { authorization: "Bearer test" },
  });
  const json = (await r.json()) as Record<string, unknown>;
  return { status: r.status, ...json } as { status: number; rows: Record<string, unknown>[]; error?: string; token: number; results: { rows: unknown[] }[] };
}
const sql = (s: string, params: unknown[] = [], extra: object = {}) => post("/sql", { sql: s, params, ...extra });

beforeAll(async () => {
  execFileSync("npm", ["run", "-s", "bundle"], { stdio: "inherit" });
  mf = new Miniflare({
    modules: [
      { type: "ESModule", path: "dist/worker.js", contents: readFileSync("dist/worker.js", "utf8") },
      { type: "CompiledWasm", path: "dist/sql-wasm.wasm", contents: readFileSync("src/sql-wasm.wasm") },
    ],
    compatibilityDate: "2026-07-01",
    bindings: { DINF_SHARD_COUNT: "4", DINF_API_TOKEN: "test", DINF_ADMIN_TOKEN: "admin-test" },
    durableObjects: {
      DINF_SHARD: { className: "DinfShard", useSQLite: true },
      DINF_META: { className: "DinfMeta", useSQLite: true },
      DINF_AUTOSCALER: { className: "DinfAutoscaler", useSQLite: true },
    },
  });
  await post("/ddl", { sql: `CREATE TABLE acct(tenant_id INTEGER NOT NULL, id INTEGER NOT NULL, email TEXT UNIQUE, n INTEGER NOT NULL DEFAULT 0, PRIMARY KEY (tenant_id,id)) SHARD KEY (tenant_id)` });
}, 60000);
afterAll(() => mf?.dispose());

describe("authentication and the production surface", () => {
  const raw = (path: string, token: string, body: unknown = {}) =>
    mf.dispatchFetch(`http://x${path}`, { method: "POST", body: JSON.stringify(body), headers: { authorization: `Bearer ${token}` } });

  it("separates the data token from the admin token", async () => {
    expect((await raw("/admin/status", "test")).status).toBe(401);
    expect((await raw("/admin/status", "admin-test")).status).toBe(200);
    expect((await raw("/v3/pipeline", "admin-test", { baton: null, requests: [{ type: "close" }] })).status).toBe(401);
    expect((await raw("/v3/pipeline", "test", { baton: null, requests: [{ type: "close" }] })).status).toBe(200);
  });

  it("has no benchmark endpoint in the production build", async () => {
    expect((await raw("/bench", "admin-test", { op: "ping" })).status).not.toBe(200);
  });

  it("rejects a tampered baton", async () => {
    const step = async (baton: string | null, sql: string) =>
      (await (await raw("/v3/pipeline", "test", { baton, requests: [{ type: "execute", stmt: { sql } }] })).json()) as {
        baton: string | null; results: { type: string; error?: { code: string } }[];
      };
    const first = await step(null, "BEGIN");
    expect(first.results[0]!.type).toBe("ok");
    expect(first.baton).toMatch(/\./);
    const [payload, sig] = first.baton!.split(".");
    const forged = `${payload!.slice(0, -2)}AA.${sig}`;
    const bad = await step(forged, "SELECT 1");
    expect(bad.results[0]!.error?.code).toBe("BATON_INVALID");
    const good = await step(first.baton, "ROLLBACK");
    expect(good.results[0]!.type).toBe("ok");
  });
});

describe("DDL followed at once by another request", () => {
  it("lets a batch use a table that a separate request created a moment ago", async () => {
    // 要求ごとに接続を作るので、表定義のキャッシュは isolate で共有している。DDL の結果をそこへ戻さないと失敗する。
    expect((await sql("CREATE TABLE fresh(id INTEGER PRIMARY KEY, n INTEGER)")).status).toBe(200);
    const r = await post("/batch", { statements: [{ sql: "INSERT INTO fresh(id, n) VALUES (1, 1)" }, { sql: "SELECT n FROM fresh WHERE id = 1" }] });
    expect(r.status).toBe(200);
    expect(r.results[1]!.rows).toEqual([{ n: 1 }]);
  });
});

describe("a stock @libsql/client over WebSocket (hrana2)", () => {
  const connect = async () => createClient({ url: (await mf.ready).toString().replace(/^http/, "ws").replace(/\/$/, ""), authToken: "test" });

  it("runs statements, batches and an interactive transaction on one connection", async () => {
    const db = await connect();
    try {
      await db.execute("CREATE TABLE ws_users(id INTEGER PRIMARY KEY, name TEXT NOT NULL, n INTEGER NOT NULL DEFAULT 0)");
      const ins = await db.execute({ sql: "INSERT INTO ws_users(name) VALUES (?)", args: ["alice"] });
      expect(ins.rowsAffected).toBe(1);
      await db.batch([
        { sql: "INSERT INTO ws_users(name) VALUES (?)", args: ["bob"] },
        { sql: "UPDATE ws_users SET n = n + 1 WHERE name = ?", args: ["alice"] },
      ], "write");
      const tx = await db.transaction("write");
      const before = await tx.execute({ sql: "SELECT n FROM ws_users WHERE name = ?", args: ["alice"] });
      await tx.execute({ sql: "UPDATE ws_users SET n = ? WHERE name = ?", args: [Number(before.rows[0]!.n) + 10, "alice"] });
      await tx.commit();
      const rows = await db.execute("SELECT name, n FROM ws_users ORDER BY name");
      expect(rows.rows.map((r) => [r.name, Number(r.n)])).toEqual([["alice", 11], ["bob", 0]]);
      await expect(db.execute("SELECT * FROM nosuch")).rejects.toThrow(/no such table/);
      // エラーの後も同じ接続で続けられる。
      expect((await db.execute("SELECT count(*) c FROM ws_users")).rows[0]!.c).toBe(2);
    } finally {
      db.close();
    }
  });

  it("rejects a connection with the wrong token", async () => {
    const db = createClient({ url: (await mf.ready).toString().replace(/^http/, "ws").replace(/\/$/, ""), authToken: "wrong" });
    await expect(db.execute("SELECT 1")).rejects.toThrow();
    db.close();
  });
});

describe("a stock @libsql/client against the Worker, changing only the URL", () => {
  const connect = async () => createClient({ url: (await mf.ready).toString().replace(/\/$/, ""), authToken: "test" });

  it("runs DDL, reads and writes", async () => {
    const db = await connect();
    await db.execute("CREATE TABLE lib_users(id INTEGER PRIMARY KEY, name TEXT NOT NULL, data BLOB)");
    const ins = await db.execute({ sql: "INSERT INTO lib_users(name, data) VALUES (?, ?)", args: ["alice", new Uint8Array([1, 2, 3])] });
    expect(ins.rowsAffected).toBe(1);
    expect(Number(ins.lastInsertRowid)).toBeGreaterThan(0);
    await db.execute({ sql: "INSERT INTO lib_users(name) VALUES (:n)", args: { n: "bob" } });
    const rows = await db.execute("SELECT id, name, data FROM lib_users ORDER BY name");
    expect(rows.columns).toEqual(["id", "name", "data"]);
    expect(rows.rows.map((r) => r.name)).toEqual(["alice", "bob"]);
    expect(new Uint8Array(rows.rows[0]!.data as ArrayBuffer)).toEqual(new Uint8Array([1, 2, 3]));
    await expect(db.execute("INSERT INTO lib_users(name) VALUES (NULL)")).rejects.toThrow(/NOT NULL/);
    await expect(db.execute("SELECT * FROM nosuch")).rejects.toThrow(/no such table/);
  });
  it("reads its own writes across shards on separate connections", async () => {
    const db = await connect();
    await db.execute("CREATE TABLE lib_c(id INTEGER PRIMARY KEY, n INTEGER)");
    for (let i = 1; i <= 8; i++) {
      await db.execute({ sql: "INSERT INTO lib_c VALUES (?, ?)", args: [i, i] });
      const r = await db.execute("SELECT count(*) c FROM lib_c");
      expect(r.rows[0]!.c).toBe(i);
    }
  });
  it("runs batch as one atomic transaction", async () => {
    const db = await connect();
    await db.execute("CREATE TABLE lib_b(id INTEGER PRIMARY KEY, v TEXT UNIQUE)");
    await db.batch(["INSERT INTO lib_b VALUES (1, 'a')", "INSERT INTO lib_b VALUES (2, 'b')"], "write");
    await expect(db.batch(["INSERT INTO lib_b VALUES (3, 'c')", "INSERT INTO lib_b VALUES (4, 'a')"], "write")).rejects.toThrow();
    expect((await db.execute("SELECT count(*) c FROM lib_b")).rows[0]!.c).toBe(2);
  });
  it("retries a conflicting batch inside the Worker", async () => {
    const db = await connect();
    await db.execute("CREATE TABLE lib_r(id INTEGER PRIMARY KEY, n INTEGER)");
    await db.execute("INSERT INTO lib_r VALUES (1, 0)");
    await Promise.all(Array.from({ length: 8 }, () => db.batch(["UPDATE lib_r SET n = n + 1 WHERE id = 1"], "write")));
    expect((await db.execute("SELECT n FROM lib_r")).rows[0]!.n).toBe(8);
  });
  it("runs an interactive transaction across HTTP requests", async () => {
    const db = await connect();
    await db.execute("CREATE TABLE lib_t(id INTEGER PRIMARY KEY, n INTEGER)");
    await db.execute("INSERT INTO lib_t VALUES (1, 10), (2, 20)");
    const tx = await db.transaction("write");
    await tx.execute("UPDATE lib_t SET n = n - 5 WHERE id = 1");
    await tx.execute("UPDATE lib_t SET n = n + 5 WHERE id = 2");
    const inside = await tx.execute("SELECT sum(n) s, min(n) m FROM lib_t");
    expect(inside.rows[0]!.m).toBe(5);
    await tx.commit();
    expect((await db.execute("SELECT n FROM lib_t ORDER BY id")).rows.map((r) => r.n)).toEqual([5, 25]);
    const undo = await db.transaction("write");
    await undo.execute("DELETE FROM lib_t");
    await undo.rollback();
    expect((await db.execute("SELECT count(*) c FROM lib_t")).rows[0]!.c).toBe(2);
  });
  it("works under the Drizzle libsql driver", async () => {
    const client = await connect();
    await client.execute("CREATE TABLE lib_d(id INTEGER PRIMARY KEY, name TEXT, n INTEGER NOT NULL DEFAULT 0)");
    const t = sqliteTable("lib_d", { id: integer("id").primaryKey(), name: text("name"), n: integer("n").notNull().default(0) });
    const orm = drizzle(client);
    await orm.insert(t).values([{ name: "x" }, { name: "y" }]);
    await orm.update(t).set({ n: 7 }).where(eq(t.name, "y"));
    expect((await orm.select().from(t).orderBy(t.name)).map((r) => [r.name, r.n])).toEqual([["x", 0], ["y", 7]]);
    await orm.transaction(async (tx) => {
      await tx.insert(t).values({ name: "z" });
      await tx.delete(t).where(eq(t.name, "x"));
    });
    expect((await orm.select().from(t).orderBy(t.name)).map((r) => r.name)).toEqual(["y", "z"]);
  });
});

describe("on workerd with real Durable Objects", () => {
  it("runs point reads and writes", async () => {
    expect((await sql("INSERT INTO acct(tenant_id,id,email,n) VALUES (?,?,?,?)", [1, 1, "a@x", 100])).error).toBeUndefined();
    const r = await sql("SELECT email, n FROM acct WHERE tenant_id = ? AND id = ?", [1, 1]);
    expect(r.rows).toEqual([{ email: "a@x", n: 100 }]);
  });
  it("uses the global index and enforces UNIQUE across shards", async () => {
    await sql("INSERT INTO acct(tenant_id,id,email) VALUES (2,1,'b@x')");
    expect((await sql("SELECT tenant_id FROM acct WHERE email = ?", ["b@x"])).rows).toEqual([{ tenant_id: 2 }]);
    const dup = await sql("INSERT INTO acct(tenant_id,id,email) VALUES (3,1,'b@x')");
    expect(dup.status).toBe(400);
    expect(dup.error).toMatch(/UNIQUE/);
  });
  it("moves money atomically across shards under concurrency", async () => {
    for (let t = 10; t < 14; t++) await sql("INSERT INTO acct(tenant_id,id,n) VALUES (?,1,100)", [t]);
    const transfers = Array.from({ length: 12 }, (_, i) => {
      const from = 10 + (i % 4);
      const to = 10 + ((i + 1) % 4);
      return post("/batch", { statements: [
        { sql: "UPDATE acct SET n = n - 1 WHERE tenant_id = ? AND id = 1", params: [from] },
        { sql: "UPDATE acct SET n = n + 1 WHERE tenant_id = ? AND id = 1", params: [to] },
      ] });
    });
    const res = await Promise.all(transfers);
    expect(res.filter((r) => r.status === 200).length).toBeGreaterThan(0);
    const sum = await sql("SELECT sum(n) s FROM acct WHERE tenant_id IN (10,11,12,13)");
    expect(sum.rows).toEqual([{ s: 400 }]);
  });
  it("captures UPSERT in a DO and scatters aggregates", async () => {
    await sql("INSERT INTO acct(tenant_id,id,n) VALUES (20,1,1) ON CONFLICT(tenant_id,id) DO UPDATE SET n = n + 1");
    await sql("INSERT INTO acct(tenant_id,id,n) VALUES (20,1,1) ON CONFLICT(tenant_id,id) DO UPDATE SET n = n + 1");
    expect((await sql("SELECT n FROM acct WHERE tenant_id = 20 AND id = 1")).rows).toEqual([{ n: 2 }]);
    const c = await sql("SELECT count(*) c FROM acct");
    expect(c.error).toBeUndefined();
    expect((c.rows[0] as { c: number }).c).toBeGreaterThanOrEqual(7);
  });
  it("carries the session token so a reader sees its own session's write", async () => {
    const w = await sql("UPDATE acct SET n = 777 WHERE tenant_id = 1 AND id = 1");
    const r = await post("/sql", { sql: "SELECT n FROM acct WHERE tenant_id = 1 AND id = 1", token: w.token });
    expect(r.rows).toEqual([{ n: 777 }]);
  });
  it("refuses requests without the API token", async () => {
    const r = await mf.dispatchFetch("http://x/sql", { method: "POST", body: "{}" });
    expect(r.status).toBe(401);
  });
  it("runs the Worker side SQLite for what one shard cannot answer", async () => {
    const r = await sql("SELECT n % 2 p, count(*) c FROM acct GROUP BY p HAVING c > 0 ORDER BY p");
    expect(r.error).toBeUndefined();
    expect(r.rows.length).toBeGreaterThan(0);
    const w = await sql("SELECT email, row_number() OVER (ORDER BY tenant_id) r FROM acct WHERE email IS NOT NULL ORDER BY r");
    expect(w.error).toBeUndefined();
    expect((w.rows[0] as { r: number }).r).toBe(1);
  });
});

describe("DDL through the HTTP /ddl endpoint", () => {
  it("runs the same checks as SQL DDL: a global UNIQUE index over existing duplicates is refused and removed", async () => {
    await post("/ddl", { sql: "CREATE TABLE dup(id INTEGER PRIMARY KEY, email TEXT)" });
    await sql("INSERT INTO dup(id, email) VALUES (1, 'a@example.test'), (2, 'a@example.test')");
    const r = await post("/ddl", { sql: "CREATE UNIQUE INDEX dup_email ON dup(email)" });
    expect(r.status).toBe(400);
    // index が残っていなければ、重複する値をもう 1 行入れられる。
    const again = await sql("INSERT INTO dup(id, email) VALUES (3, 'a@example.test')");
    expect([again.status, again.error]).toEqual([200, undefined]);
  });

  it("backfills a global index over rows that already exist, so a lookup through it finds them", async () => {
    await post("/ddl", { sql: "CREATE TABLE people(id INTEGER PRIMARY KEY, email TEXT)" });
    await sql("INSERT INTO people(id, email) VALUES (1, 'x@example.test'), (2, 'y@example.test')");
    expect((await post("/ddl", { sql: "CREATE UNIQUE INDEX people_email ON people(email)" })).status).toBe(200);
    expect((await sql("SELECT id FROM people WHERE email = ?", ["y@example.test"])).rows).toEqual([{ id: 2 }]);
    expect((await sql("INSERT INTO people(id, email) VALUES (3, 'x@example.test')")).status).toBe(400);
  });
});
