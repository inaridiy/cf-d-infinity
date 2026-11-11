// 衝突を自分で解決する INSERT (OR IGNORE、OR REPLACE、REPLACE、ON CONFLICT) を、シャードをまたぐ UNIQUE のある表へ入れる。
// 衝突する行が別のシャードにあっても、SQLite と同じ結果になること。「無ければ作る」を、UNIQUE な email のような列で書けること。
import { DatabaseSync } from "node:sqlite";
import { describe, expect, it } from "vitest";
import { Db } from "../src/client/db";
import { ownerOf } from "../src/routing";
import { quiescentProblems } from "./invariants";
import { SimCluster } from "./sim";

const USERS = `CREATE TABLE users(tenant_id INTEGER NOT NULL, id INTEGER NOT NULL, email TEXT, code TEXT, n INTEGER NOT NULL DEFAULT 0,
  PRIMARY KEY (tenant_id, id), UNIQUE (email), UNIQUE (tenant_id, code)) SHARD KEY (tenant_id)`;
const ALL = "SELECT tenant_id, id, email, code, n FROM users ORDER BY tenant_id, id";

/** 同じ文を D∞ と本物の SQLite に流し、文ごとの変更行数と、最後の全行を比べる。 */
async function same(statements: [string, unknown[]][], shards = 3) {
  const c = new SimCluster({ shards });
  const db = c.client();
  const lite = new DatabaseSync(":memory:");
  await db.ddl(USERS);
  lite.exec(USERS.replace(/SHARD KEY \([^)]*\)/, ""));
  for (const [sql, params] of statements) {
    const want = (() => {
      try {
        return Number(lite.prepare(sql).run(...(params as never[])).changes);
      } catch (e) {
        return `ERROR ${(e as Error).message}`;
      }
    })();
    const got = await db.query(sql, params as never).then((r) => r.changes, (e: Error) => `ERROR ${e.message}`);
    expect({ sql, params, got }).toEqual({ sql, params, got: want });
  }
  expect((await db.query(ALL)).rows).toEqual(lite.prepare(ALL).all().map((r) => ({ ...r })));
  expect(await quiescentProblems(c)).toEqual([]);
  expect(c.spanEscapes).toEqual([]);
  return { c, db };
}

describe("INSERT that resolves conflicts itself, on a table with a UNIQUE that spans shards", () => {
  const seed: [string, unknown[]][] = [
    ["INSERT INTO users(tenant_id, id, email, code) VALUES (1, 1, 'a@x', 'c1')", []],
    ["INSERT INTO users(tenant_id, id, email, code) VALUES (2, 1, 'b@x', 'c1')", []],
    ["INSERT INTO users(tenant_id, id, email, code) VALUES (3, 1, 'c@x', 'c1')", []],
  ];

  it("OR IGNORE skips a row whose email is held by a row of another tenant, and inserts the others", async () => {
    await same([...seed,
      ["INSERT OR IGNORE INTO users(tenant_id, id, email, code) VALUES (4, 1, 'a@x', 'c1')", []],
      ["INSERT OR IGNORE INTO users(tenant_id, id, email, code) VALUES (4, 2, 'd@x', 'c2')", []],
      ["INSERT OR IGNORE INTO users(tenant_id, id, email, code) VALUES (5, 1, 'e@x', 'k'), (5, 2, 'b@x', 'l'), (5, 3, 'e@x', 'm'), (1, 1, 'z@x', 'z')", []],
      ["INSERT OR IGNORE INTO users(tenant_id, id, email, code) VALUES (?, ?, ?, ?)", [6, 1, null, null]],
    ]);
  });

  it("ON CONFLICT DO NOTHING does the same, with and without a conflict target", async () => {
    await same([...seed,
      ["INSERT INTO users(tenant_id, id, email, code) VALUES (4, 1, 'a@x', 'c1') ON CONFLICT DO NOTHING", []],
      ["INSERT INTO users(tenant_id, id, email, code) VALUES (4, 1, 'b@x', 'c1') ON CONFLICT (email) DO NOTHING", []],
      ["INSERT INTO users(tenant_id, id, email, code) VALUES (4, 1, 'new@x', 'c1') ON CONFLICT (email) DO NOTHING", []],
    ]);
  });

  it("ON CONFLICT (email) DO UPDATE rewrites the row that holds the email, wherever it lives", async () => {
    await same([...seed,
      ["INSERT INTO users(tenant_id, id, email, code) VALUES (9, 9, 'a@x', 'zz') ON CONFLICT (email) DO UPDATE SET n = n + 1, code = excluded.code", []],
      ["INSERT INTO users(tenant_id, id, email, code) VALUES (9, 9, 'b@x', 'q') ON CONFLICT (email) DO UPDATE SET n = n + 10 WHERE users.n = 0", []],
      ["INSERT INTO users(tenant_id, id, email, code) VALUES (1, 1, 'fresh@x', 'c9') ON CONFLICT (tenant_id, id) DO UPDATE SET email = excluded.email", []],
      // 書き換えた先の email が別の行と衝突するなら、SQLite と同じく UNIQUE 違反になる。
      ["INSERT INTO users(tenant_id, id, email, code) VALUES (2, 1, 'x@x', 'c1') ON CONFLICT (tenant_id, id) DO UPDATE SET email = 'c@x'", []],
    ]);
  });

  it("OR REPLACE and REPLACE remove the rows they conflict with, on whichever shard, and insert the new row", async () => {
    await same([...seed,
      ["INSERT OR REPLACE INTO users(tenant_id, id, email, code) VALUES (4, 1, 'a@x', 'c1')", []],
      ["REPLACE INTO users(tenant_id, id, email, code) VALUES (2, 1, 'c@x', 'c7')", []],
      ["INSERT OR REPLACE INTO users(tenant_id, id, email, code) VALUES (4, 2, 'a@x', 'c1')", []],
    ]);
  });

  it("INSERT ... SELECT with OR IGNORE goes the same way", async () => {
    await same([...seed,
      ["INSERT OR IGNORE INTO users(tenant_id, id, email, code) SELECT tenant_id + 10, id, email, code FROM users", []],
      ["INSERT OR IGNORE INTO users(tenant_id, id, email, code) SELECT tenant_id + 20, id, 'n' || email, code FROM users WHERE tenant_id < 10", []],
    ]);
  });

  it("a UNIQUE column left out of the statement is NULL and conflicts with nothing", async () => {
    await same([...seed,
      ["INSERT OR IGNORE INTO users(tenant_id, id, email) VALUES (7, 1, 'g@x')", []],
      ["INSERT INTO users(tenant_id, id, code) VALUES (1, 1, 'c5') ON CONFLICT (tenant_id, id) DO UPDATE SET n = n + 1", []],
      ["INSERT INTO users(tenant_id, id) VALUES (8, 1) ON CONFLICT DO NOTHING", []],
      ["INSERT OR REPLACE INTO users(tenant_id, id, n) VALUES (1, 1, 5)", []],
    ]);
  });

  it("refuses a statement that leaves out a UNIQUE column that has a DEFAULT: the value is not known when rows are gathered", async () => {
    const db = new SimCluster({ shards: 2 }).client();
    await db.ddl(`CREATE TABLE d(id INTEGER PRIMARY KEY, email TEXT DEFAULT 'none@x' UNIQUE, n INTEGER)`);
    await expect(db.query("INSERT OR IGNORE INTO d(id, n) VALUES (1, 1)")).rejects.toThrow(/^unsupported: .*UNIQUE column email, which has a DEFAULT/);
    await db.query("INSERT OR IGNORE INTO d(id, email, n) VALUES (1, 'a@x', 1)");
    expect((await db.query("SELECT email FROM d")).rows).toEqual([{ email: "a@x" }]);
  });

  it("two transactions that create the same email with OR IGNORE do not both insert it", async () => {
    const c = new SimCluster({ shards: 3 });
    const db = c.client();
    await db.ddl(USERS);
    const { routing } = await c.catalog();
    const on = (shard: string) => { for (let t = 1; ; t++) if (ownerOf(routing, JSON.stringify([t])) === shard) return t; };
    const [x, y] = [await new Db(c, { retries: 0 }).begin(), await new Db(c, { retries: 0 }).begin()];
    await x.query("INSERT OR IGNORE INTO users(tenant_id, id, email, code) VALUES (?, 1, 'same@x', 'a')", [on("s0")]);
    await y.query("INSERT OR IGNORE INTO users(tenant_id, id, email, code) VALUES (?, 1, 'same@x', 'a')", [on("s1")]).catch(() => undefined);
    const out = [await x.commit().then(() => "ok", (e: Error) => e.message), await y.commit().then(() => "ok", (e: Error) => e.message)];
    await c.settle();
    expect((await new Db(c).query("SELECT count(*) AS n FROM users WHERE email = 'same@x'")).rows).toEqual([{ n: 1 }]);
    expect(out.filter((o) => o === "ok").length).toBeGreaterThanOrEqual(1);
    expect(await quiescentProblems(c)).toEqual([]);
  });
});
