// 同じ ShardCore を本物の workerd と DO の SQLite で動かす結合テスト。
// 環境変数 DINF_LIVE_URL を与えると、Miniflare を起こさず、同じ試験を Cloudflare に置いた Worker へ向けて流す
// (scripts/cloudflare-check.sh。トークンは DINF_LIVE_TOKEN と DINF_LIVE_ADMIN_TOKEN)。
import { execFileSync } from "node:child_process";
import { readFileSync } from "node:fs";
import { createClient } from "@libsql/client";
import { eq } from "drizzle-orm";
import { drizzle } from "drizzle-orm/libsql";
import { migrate } from "drizzle-orm/libsql/migrator";
import { integer, sqliteTable, text } from "drizzle-orm/sqlite-core";
import { Miniflare } from "miniflare";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { drizzleMigrationsTable } from "../src/binding";
import { ADD, INIT, REBUILD, migrations } from "./drizzle-fixtures";

const LIVE = process.env.DINF_LIVE_URL?.replace(/\/$/, "");
const TOKEN = LIVE ? (process.env.DINF_LIVE_TOKEN ?? "") : "test";
const ADMIN = LIVE ? (process.env.DINF_LIVE_ADMIN_TOKEN ?? "") : "admin-test";
// 本物へ向けるときは、送る要求の数に上限を置く。試験の誤りで要求を送り続け、費用を積むことがないようにする。
// @libsql/client も、作るときの globalThis.fetch を使うので、ここで数えられる (WebSocket の上の文は数えない)。
const MAX_REQUESTS = Number(process.env.DINF_LIVE_MAX_REQUESTS ?? 3000);
let sent = 0;
if (LIVE) {
  const real = globalThis.fetch;
  globalThis.fetch = ((input: RequestInfo | URL, init?: RequestInit) => {
    if (++sent > MAX_REQUESTS) throw new Error(`more than ${MAX_REQUESTS} requests to ${LIVE}; stopped`);
    return real(input, init);
  }) as typeof fetch;
}

let mf: Miniflare | undefined;
/** Worker の URL。末尾の / は付けない。 */
const base = async () => LIVE ?? (await mf!.ready).toString().replace(/\/$/, "");
const dispatch = (path: string, init: RequestInit): Promise<Response> =>
  LIVE ? fetch(`${LIVE}${path}`, init) : (mf!.dispatchFetch(`http://x${path}`, init as never) as unknown as Promise<Response>);

async function post(path: string, body: unknown, token = TOKEN) {
  const r = await dispatch(path, { method: "POST", body: JSON.stringify(body), headers: { authorization: `Bearer ${token}` } });
  const json = (await r.json()) as Record<string, unknown>;
  return { status: r.status, ...json } as { status: number; rows: Record<string, unknown>[]; error?: string; token: number; results: { rows: unknown[] }[] };
}
const sql = (s: string, params: unknown[] = [], extra: object = {}) => post("/sql", { sql: s, params, ...extra });

beforeAll(async () => {
  if (LIVE) {
    await post("/ddl", { sql: `CREATE TABLE acct(tenant_id INTEGER NOT NULL, id INTEGER NOT NULL, email TEXT UNIQUE, n INTEGER NOT NULL DEFAULT 0, PRIMARY KEY (tenant_id,id)) SHARD KEY (tenant_id)` });
    return;
  }
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
afterAll(async () => {
  // URL は書かない (アカウントの workers.dev の名前が出る)。
  if (LIVE) console.log(`sent ${sent} HTTP requests to the live Worker`);
  await mf?.dispose();
});

describe("authentication and the production surface", () => {
  const raw = (path: string, token: string, body: unknown = {}) =>
    dispatch(path, { method: "POST", body: JSON.stringify(body), headers: { authorization: `Bearer ${token}` } });

  it("separates the data token from the admin token", async () => {
    expect((await raw("/admin/status", TOKEN)).status).toBe(401);
    expect((await raw("/admin/status", ADMIN)).status).toBe(200);
    expect((await raw("/v3/pipeline", ADMIN, { baton: null, requests: [{ type: "close" }] })).status).toBe(401);
    expect((await raw("/v3/pipeline", TOKEN, { baton: null, requests: [{ type: "close" }] })).status).toBe(200);
  });

  it("has no benchmark endpoint in the production build", async () => {
    expect((await raw("/bench", ADMIN, { op: "ping" })).status).not.toBe(200);
  });

  it("rejects a tampered baton", async () => {
    const step = async (baton: string | null, sql: string) =>
      (await (await raw("/v3/pipeline", TOKEN, { baton, requests: [{ type: "execute", stmt: { sql } }] })).json()) as {
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
  const connect = async () => createClient({ url: (await base()).replace(/^http/, "ws"), authToken: TOKEN });

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
    const db = createClient({ url: (await base()).replace(/^http/, "ws"), authToken: "wrong" });
    await expect(db.execute("SELECT 1")).rejects.toThrow();
    db.close();
  });
});

describe("a stock @libsql/client against the Worker, changing only the URL", () => {
  const connect = async () => createClient({ url: await base(), authToken: TOKEN });

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

// PR #16 以降の仕組みを、本物の workerd と DO で通す。取引の中の DDL (先の確定)、行のある表への UNIQUE の index
// (書き込み禁止と期限の延長)、DROP の守り (禁止、確認、DROP)。どれもシャードから Meta を呼ぶ。
describe("Drizzle's libSQL migrator on workerd", () => {
  const connectHttp = async () => createClient({ url: await base(), authToken: TOKEN });

  it("applies migrations that create a UNIQUE index and rebuild a table, and keeps the rows", async () => {
    const client = await connectHttp();
    await client.execute(drizzleMigrationsTable());
    const folder = (list: typeof INIT[]) => migrations(list);
    await migrate(drizzle(client), { migrationsFolder: folder([INIT, ADD]) });
    await client.execute("INSERT INTO users(id, email, name, age) VALUES (1, 'a@x', 'A', 30), (2, 'b@x', NULL, 40)");
    await migrate(drizzle(client), { migrationsFolder: folder([INIT, ADD, REBUILD]) });
    const rows = await client.execute("SELECT id, email, name, age FROM users ORDER BY id");
    expect(rows.rows.map((r) => ({ ...r }))).toEqual([{ id: 1, email: "a@x", name: "A", age: 30 }, { id: 2, email: "b@x", name: "", age: 40 }]);
    expect((await client.execute("SELECT count(*) AS n FROM __drizzle_migrations")).rows[0]!.n).toBe(3);
    await expect(client.execute("INSERT INTO users(id, email, name) VALUES (9, 'a@x', 'Z')")).rejects.toThrow(/UNIQUE constraint failed/);
  });

  it("runs an interactive transaction that changes the schema, across HTTP requests", async () => {
    const client = await connectHttp();
    const tx = await client.transaction("write");
    await tx.execute("CREATE TABLE tx_ddl(id INTEGER PRIMARY KEY, v INTEGER)");
    await tx.execute("INSERT INTO tx_ddl VALUES (1, 1)");
    await tx.execute("CREATE TABLE tx_ddl_new(id INTEGER PRIMARY KEY, v INTEGER, w INTEGER)");
    await tx.execute("INSERT INTO tx_ddl_new(id, v) SELECT id, v FROM tx_ddl");
    await tx.execute("DROP TABLE tx_ddl");
    await tx.execute("ALTER TABLE tx_ddl_new RENAME TO tx_ddl");
    await tx.commit();
    expect((await client.execute("SELECT id, v, w FROM tx_ddl")).rows.map((r) => ({ ...r }))).toEqual([{ id: 1, v: 1, w: null }]);
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
    const r = await dispatch("/sql", { method: "POST", body: "{}" });
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

// 書き込み禁止の期限の延長を、本物の DO で通す。期限 (meta.ts の INDEX_LEASE_MS、5 秒) より長くかかる index の作成は、
// 延長が周期で続かなければ、Meta に取り消されて失敗する。長くかからせるために、作る前に、その表に書いた取引を開いたままにする。
describe("a UNIQUE index build that outlives one lease", () => {
  it("keeps its write lock past the lease by renewing it, and ends with the index and the rows agreeing", async () => {
    const client = createClient({ url: await base(), authToken: TOKEN });
    await client.execute("CREATE TABLE lease_t(id INTEGER PRIMARY KEY, email TEXT)");
    await client.execute("INSERT INTO lease_t VALUES (1, 'a@x'), (2, 'b@x')");
    const tx = await client.transaction("write");
    await tx.execute("INSERT INTO lease_t VALUES (3, 'c@x')");
    const t0 = Date.now();
    const build = post("/ddl", { sql: "CREATE UNIQUE INDEX lease_email ON lease_t(email)" });
    await new Promise((r) => setTimeout(r, 7000));
    const committed = await tx.commit().then(() => true, (e: Error) => e.message);
    const built = await build;
    const ms = Date.now() - t0;
    console.log(`build ${ms} ms, status ${built.status}, ${built.error ?? "ok"}; the open transaction: ${committed}`);
    expect([built.status, built.error]).toEqual([200, undefined]);
    // 期限より早く終わったなら、この試験は延長を確かめていない。
    expect(ms).toBeGreaterThan(5000);
    const rows = await client.execute("SELECT id FROM lease_t ORDER BY id");
    const viaIndex = await client.execute("SELECT id FROM lease_t WHERE email = 'c@x'");
    expect(viaIndex.rows.map((r) => r.id)).toEqual(rows.rows.some((r) => r.id === 3) ? [3] : []);
    await expect(client.execute("INSERT INTO lease_t VALUES (9, 'a@x')")).rejects.toThrow(/UNIQUE constraint failed/);
  });
});

// 分割の枠 (M15) を、本物の DO で通す。枠を取り、子の受け入れが Meta の startSplit を、親の fence が checkSplit を呼び、
// 終わりに枠を返す。返っていなければ、後の表定義の変更が待たされる。
describe("a split through /admin/split", () => {
  const admin = (path: string, body: object = {}) => post(path, body, ADMIN) as unknown as Promise<Record<string, unknown> & { status: number }>;

  it("moves part of a shard to a new one, keeps every row, and lets a schema change run after it", async () => {
    expect((await post("/ddl", { sql: "CREATE TABLE sp(id INTEGER PRIMARY KEY, v INTEGER NOT NULL)" })).status).toBe(200);
    const values = Array.from({ length: 40 }, (_, i) => `(${i + 1}, ${(i + 1) * 10})`).join(", ");
    expect((await sql(`INSERT INTO sp(id, v) VALUES ${values}`)).error).toBeUndefined();
    const before = (await admin("/admin/status")) as unknown as { shards: string[] };
    const parent = before.shards[0]!;
    const child = `shard-${Math.max(...before.shards.map((s) => Number(s.slice("shard-".length)))) + 1}`;
    const r = await admin("/admin/split", { parent, child });
    expect([r.status, r.error]).toEqual([200, undefined]);
    const after = (await admin("/admin/status")) as unknown as { shards: string[]; splits: unknown[] };
    expect(after.shards).toContain(child);
    expect(after.splits).toEqual([]);
    // 子へ移った行も含めて、全部の行が読め、書ける。
    expect((await sql("SELECT count(*) c, sum(v) s FROM sp")).rows).toEqual([{ c: 40, s: 8200 }]);
    expect((await sql("UPDATE sp SET v = v + 1")).error).toBeUndefined();
    expect((await post("/ddl", { sql: "CREATE INDEX sp_v ON sp(v)" })).status).toBe(200);
    expect((await sql("SELECT count(*) c, sum(v) s FROM sp WHERE v > 0")).rows).toEqual([{ c: 40, s: 8240 }]);
  });
});
