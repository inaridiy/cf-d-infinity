// 移行ツールが、取引の中で表定義を変える。
//
// Drizzle の移行は、未適用の移行の文と、記録の表 (`__drizzle_migrations`) への INSERT を、1 つの取引にまとめて送る。
// libSQL のドライバは `BEGIN`、各文、`COMMIT` の batch で、D1 のドライバは batch で送る。表を作り直す移行
// (drizzle-kit が列の変更で作る) は、新しい表を作り、行を写し、古い表を消し、名前を変える。
//
// DDL は取引の中でもその場で全シャードに効き、書き込みは COMMIT まで Worker の手元に溜まる。2026-11 までは、効く順序が
// 書いた順序と入れ替わり、表の作り直しで行が全部消えた。いまは、DDL が開いている取引を先に確定してから実行し、その後の文は
// 新しい取引になる (MySQL と同じ。持ち主の決定、2026-11-11。specs/m13_txn_schema_boundary.qnt)。batch も DDL の位置で区切る。
//
// ここでは、本物の Drizzle の移行と @libsql/client を、シミュレータにつないで流す。
import { mkdtempSync, mkdirSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createClient, type Client } from "@libsql/client";
import { drizzle as drizzleD1 } from "drizzle-orm/d1";
import { migrate as migrateD1 } from "drizzle-orm/d1/migrator";
import { drizzle } from "drizzle-orm/libsql";
import { migrate } from "drizzle-orm/libsql/migrator";
import { describe, expect, it } from "vitest";
import { drizzleMigrationsTable } from "../src/binding";
import { D1Compatible } from "../src/client/d1";
import { Db, type ClientFaults } from "../src/client/db";
import { handlePipeline, type PipelineReq } from "../src/client/hrana";
import { SimCluster } from "./sim";

/** @libsql/client の HTTP を、シミュレータの Hrana の入口へつなぐ。 */
function clientOf(c: SimCluster): Client {
  const fetch = async (input: RequestInfo | URL, init?: RequestInit): Promise<Response> => {
    const req = input instanceof Request ? input : new Request(input, init);
    const path = new URL(req.url).pathname;
    if (req.method === "GET" && (path === "/v2" || path === "/v3")) return new Response(null, { status: 200 });
    if (req.method === "POST" && (path === "/v2/pipeline" || path === "/v3/pipeline")) {
      const body = (await req.json()) as PipelineReq;
      return Response.json(await handlePipeline(body, async (token) => new Db(c, { token })));
    }
    return new Response("not found", { status: 404 });
  };
  return createClient({ url: "http://sim", fetch: fetch as never });
}

/** drizzle-kit が書き出す形の移行の置き場を作る。 */
function migrations(list: { tag: string; sql: string[] }[]): string {
  const dir = mkdtempSync(join(tmpdir(), "dinf-drizzle-"));
  mkdirSync(join(dir, "meta"));
  list.forEach((m) => writeFileSync(join(dir, `${m.tag}.sql`), m.sql.join("\n--> statement-breakpoint\n")));
  const entries = list.map((m, i) => ({ idx: i, version: "6", when: 1_700_000_000_000 + i * 1000, tag: m.tag, breakpoints: true }));
  writeFileSync(join(dir, "meta", "_journal.json"), JSON.stringify({ version: "7", dialect: "sqlite", entries }));
  return dir;
}

const INIT = {
  tag: "0000_init",
  sql: [
    "CREATE TABLE `users` (`id` integer PRIMARY KEY NOT NULL, `email` text NOT NULL, `name` text);",
    "CREATE TABLE `posts` (`id` integer PRIMARY KEY NOT NULL, `user_id` integer NOT NULL, `title` text NOT NULL);",
  ],
};
const ADD = { tag: "0001_add_age", sql: ["ALTER TABLE `users` ADD `age` integer;"] };
// drizzle-kit が、列の制約を変えるときに作る形 (SQLite は ALTER COLUMN を持たない)。
const REBUILD = {
  tag: "0002_name_not_null",
  sql: [
    "PRAGMA foreign_keys=OFF;",
    "CREATE TABLE `__new_users` (`id` integer PRIMARY KEY NOT NULL, `email` text NOT NULL, `name` text DEFAULT '' NOT NULL, `age` integer);",
    "INSERT INTO `__new_users`(\"id\", \"email\", \"name\", \"age\") SELECT \"id\", \"email\", coalesce(\"name\", ''), \"age\" FROM `users`;",
    "DROP TABLE `users`;",
    "ALTER TABLE `__new_users` RENAME TO `users`;",
    "PRAGMA foreign_keys=ON;",
  ],
};

const outcome = (p: Promise<unknown>) => p.then(() => "ok", (e: Error) => e.message);

describe("Drizzle's libSQL migrator", () => {
  // Drizzle の記録の表は `id SERIAL PRIMARY KEY` で、INSERT は id を省く。SERIAL は INTEGER ではないので、SQLite は id に NULL を
  // 入れる。この DB は、主キーに NULL のある行を断る (行を主キーの値で名指しするため)。断りの文が、直し方を言う。
  it("is refused on Drizzle's own journal table, with a message that says how to fix it", async () => {
    const c = new SimCluster({ shards: 2 });
    const r = await outcome(migrate(drizzle(clientOf(c)), { migrationsFolder: migrations([INIT]) }));
    expect(r).toMatch(/unsupported: NULL in the primary key column id of __drizzle_migrations/);
    expect(r).toMatch(/drizzleMigrationsTable\(\) from cf-d-infinity\/client/);
  });

  it("applies two migrations in one run and records both, with the journal table created first", async () => {
    const c = new SimCluster({ shards: 2 });
    const client = clientOf(c);
    await client.execute(drizzleMigrationsTable());
    expect(await outcome(migrate(drizzle(client), { migrationsFolder: migrations([INIT, ADD]) }))).toBe("ok");
    expect((await client.execute("SELECT hash FROM __drizzle_migrations")).rows.length).toBe(2);
    expect((await c.catalog()).tables.users?.columns).toEqual(["id", "email", "name", "age"]);
    // 2 回目は、何もしない。
    expect(await outcome(migrate(drizzle(client), { migrationsFolder: migrations([INIT, ADD]) }))).toBe("ok");
    expect((await client.execute("SELECT hash FROM __drizzle_migrations")).rows.length).toBe(2);
  });

  it("rebuilds a table and keeps its rows", async () => {
    const c = new SimCluster({ shards: 2 });
    const client = clientOf(c);
    await client.execute(drizzleMigrationsTable());
    expect(await outcome(migrate(drizzle(client), { migrationsFolder: migrations([INIT, ADD]) }))).toBe("ok");
    await client.execute("INSERT INTO users(id, email, name, age) VALUES (1, 'a@x', 'A', 30), (2, 'b@x', NULL, 40), (3, 'c@x', 'C', NULL)");
    expect(await outcome(migrate(drizzle(client), { migrationsFolder: migrations([INIT, ADD, REBUILD]) }))).toBe("ok");
    const rows = await client.execute("SELECT id, email, name, age FROM users ORDER BY id");
    expect(rows.rows.map((r) => ({ ...r }))).toEqual([
      { id: 1, email: "a@x", name: "A", age: 30 },
      { id: 2, email: "b@x", name: "", age: 40 },
      { id: 3, email: "c@x", name: "C", age: null },
    ]);
    expect((await client.execute("SELECT hash FROM __drizzle_migrations")).rows.length).toBe(3);
  });
});

describe("Drizzle's D1 migrator", () => {
  it("applies the migrations through batch, which splits at each schema change", async () => {
    const c = new SimCluster({ shards: 2 });
    const d1 = new D1Compatible(new Db(c));
    await d1.prepare(drizzleMigrationsTable()).run();
    expect(await outcome(migrateD1(drizzleD1(d1 as never), { migrationsFolder: migrations([INIT, ADD]) }))).toBe("ok");
    await d1.prepare("INSERT INTO users(id, email, name, age) VALUES (1, 'a@x', NULL, 30)").run();
    expect(await outcome(migrateD1(drizzleD1(d1 as never), { migrationsFolder: migrations([INIT, ADD, REBUILD]) }))).toBe("ok");
    expect((await d1.prepare("SELECT id, email, name, age FROM users").all()).results).toEqual([{ id: 1, email: "a@x", name: "", age: 30 }]);
    expect((await d1.prepare("SELECT count(*) AS n FROM __drizzle_migrations").first("n"))).toBe(3);
  });

  it("keeps a batch without schema changes all or nothing", async () => {
    const c = new SimCluster({ shards: 2 });
    const d1 = new D1Compatible(new Db(c));
    await d1.prepare("CREATE TABLE t(id INTEGER PRIMARY KEY)").run();
    expect(await outcome(d1.batch([d1.prepare("INSERT INTO t VALUES (1)"), d1.prepare("INSERT INTO t VALUES (1)")]))).toMatch(/UNIQUE constraint failed/);
    expect((await d1.prepare("SELECT count(*) AS n FROM t").first("n"))).toBe(0);
  });
});

describe("an interactive libSQL transaction that changes the schema", () => {
  // 接続をまたぐ取引。文ごとに別の HTTP 要求で、取引の状態は baton で運ぶ。
  it("writes to a table it has just created, and commits", async () => {
    const c = new SimCluster({ shards: 2 });
    const client = clientOf(c);
    await client.execute("CREATE TABLE t(id INTEGER PRIMARY KEY, v INTEGER)");
    const tx = await client.transaction("write");
    await tx.execute("INSERT INTO t VALUES (1, 1)");
    await tx.execute("CREATE TABLE a(id INTEGER PRIMARY KEY, v INTEGER)");
    await tx.execute("INSERT INTO a VALUES (1, 1)");
    await tx.commit();
    expect((await client.execute("SELECT (SELECT count(*) FROM t) AS t, (SELECT count(*) FROM a) AS a")).rows.map((r) => ({ ...r }))).toEqual([{ t: 1, a: 1 }]);
  });
});

// 移行ツールを使わない、同じ形の取引。
describe("a transaction that changes the schema", () => {
  const setup = async () => {
    const c = new SimCluster({ shards: 2 });
    const db = new Db(c);
    await db.ddl("CREATE TABLE journal(id INTEGER PRIMARY KEY, tag TEXT)");
    await db.ddl("CREATE TABLE t(id INTEGER PRIMARY KEY, v INTEGER)");
    await db.query("INSERT INTO t VALUES (10, 10), (11, 11)");
    return { c, db };
  };
  const run = async (db: Db, script: string[]) => {
    const out: string[] = [];
    for (const s of script) out.push(await outcome(db.query(s)));
    return out;
  };

  it("keeps the rows of a table it rebuilds", async () => {
    const { c, db } = await setup();
    await run(db, ["BEGIN", "CREATE TABLE __new_t(id INTEGER PRIMARY KEY, v INTEGER, w INTEGER)", "INSERT INTO __new_t(id, v) SELECT id, v FROM t",
      "DROP TABLE t", "ALTER TABLE __new_t RENAME TO t", "COMMIT"]);
    expect((await new Db(c).query("SELECT id, v FROM t ORDER BY id")).rows).toEqual([{ id: 10, v: 10 }, { id: 11, v: 11 }]);
  });

  it("keeps the writes it made between two schema changes", async () => {
    const { c, db } = await setup();
    const out = await run(db, ["BEGIN", "CREATE TABLE a(id INTEGER PRIMARY KEY)", "INSERT INTO journal VALUES (1, 'a')",
      "CREATE TABLE b(id INTEGER PRIMARY KEY)", "INSERT INTO journal VALUES (2, 'b')", "COMMIT"]);
    expect(out).toEqual(["ok", "ok", "ok", "ok", "ok", "ok"]);
    expect((await new Db(c).query("SELECT id, tag FROM journal ORDER BY id")).rows).toEqual([{ id: 1, tag: "a" }, { id: 2, tag: "b" }]);
  });

  it("rolls back only what came after the last schema change", async () => {
    const { c, db } = await setup();
    const out = await run(db, ["BEGIN", "INSERT INTO t VALUES (1, 1)", "CREATE TABLE a(id INTEGER PRIMARY KEY)", "INSERT INTO t VALUES (2, 2)", "ROLLBACK"]);
    expect(out).toEqual(["ok", "ok", "ok", "ok", "ok"]);
    expect((await new Db(c).query("SELECT id FROM t ORDER BY id")).rows).toEqual([{ id: 1 }, { id: 10 }, { id: 11 }]);
    expect((await c.catalog()).tables.a).toBeDefined();
  });

  it("does not change the schema when the work before it cannot commit, and ends the transaction", async () => {
    const c = new SimCluster({ shards: 2 });
    await new Db(c).ddl("CREATE TABLE t(id INTEGER PRIMARY KEY, v INTEGER)");
    await new Db(c).query("INSERT INTO t VALUES (1, 1)");
    const db = new Db(c);
    // 読んだ行を、別の接続が書き換える。確定の検証が競合にする (やり直してよい失敗である)。
    await db.query("BEGIN");
    await db.query("SELECT v FROM t WHERE id = 1");
    await new Db(c).query("UPDATE t SET v = 2 WHERE id = 1");
    await db.query("INSERT INTO t VALUES (5, 5)");
    expect(await outcome(db.query("CREATE TABLE a(id INTEGER PRIMARY KEY)"))).toMatch(/^conflict:/);
    expect((await c.catalog()).tables.a).toBeUndefined();
    expect(db.inTransaction).toBe(false);
    expect((await new Db(c).query("SELECT id FROM t ORDER BY id")).rows).toEqual([{ id: 1 }]);
  });

  it("writes to a table it has just created", async () => {
    const { c, db } = await setup();
    const out = await run(db, ["BEGIN", "INSERT INTO t VALUES (1, 1)", "CREATE TABLE a(id INTEGER PRIMARY KEY, v INTEGER)", "INSERT INTO a VALUES (1, 1)", "COMMIT"]);
    expect(out).toEqual(["ok", "ok", "ok", "ok", "ok"]);
    expect((await new Db(c).query("SELECT count(*) AS n FROM a")).rows).toEqual([{ n: 1 }]);
  });
});

describe("a Hrana batch that changes the schema", () => {
  /** BEGIN から始まる batch。途中の DDL の後の文が、別の接続のロックを待って競合になる。 */
  const contended = async (faults?: ClientFaults) => {
    const c = new SimCluster({ shards: 2 });
    await new Db(c).ddl("CREATE TABLE counter(id INTEGER PRIMARY KEY, n INTEGER NOT NULL)");
    await new Db(c).query("INSERT INTO counter VALUES (1, 0), (2, 0)");
    const holder = new Db(c);
    await holder.query("BEGIN");
    await holder.query("UPDATE counter SET n = n WHERE id = 2");
    const steps = ["BEGIN", "UPDATE counter SET n = n + 1 WHERE id = 1", "CREATE TABLE IF NOT EXISTS a(id INTEGER PRIMARY KEY)", "UPDATE counter SET n = n + 1 WHERE id = 2", "COMMIT"]
      .map((sql) => ({ stmt: { sql } }));
    const req = { baton: null, requests: [{ type: "batch", batch: { steps } }] } as unknown as PipelineReq;
    const res = await handlePipeline(req, async () => new Db(c, { faults }));
    await holder.query("ROLLBACK");
    const errors = ((res.results[0] as unknown as { response: { result: { step_errors: ({ code: string } | null)[] } } }).response.result.step_errors)
      .map((e) => e?.code ?? null);
    const n = (await new Db(c).query("SELECT n FROM counter WHERE id = 1")).rows[0]!.n;
    return { errors, n };
  };

  it("is not run again from the top after the schema change committed the statements before it", async () => {
    const r = await contended();
    expect(r.errors[3]).toBe("SQLITE_BUSY");
    expect(r.n).toBe(1);
  });

  it("put back: running it again from the top applies the committed statements twice", async () => {
    const r = await contended({ replayAcrossSchemaChange: true });
    expect(r.n).toBeGreaterThan(1);
  });
});
