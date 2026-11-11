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

  it("a UNIQUE column left out that has a DEFAULT: the default is what conflicts, and it is resolved all the same", async () => {
    const c = new SimCluster({ shards: 3 });
    const db = c.client();
    const lite = new DatabaseSync(":memory:");
    const ddl = `CREATE TABLE d(id INTEGER PRIMARY KEY, email TEXT DEFAULT 'none@x' UNIQUE, n INTEGER)`;
    await db.ddl(ddl);
    lite.exec(ddl);
    for (const sql of [
      "INSERT OR IGNORE INTO d(id, n) VALUES (1, 1)",
      "INSERT OR IGNORE INTO d(id, n) VALUES (2, 2)", // 既定値 'none@x' が、別のシャードの行 1 と衝突する。無視される
      "INSERT OR REPLACE INTO d(id, n) VALUES (3, 3)", // 行 1 を消して、行 3 が入る
      "INSERT INTO d(id, n) VALUES (4, 4) ON CONFLICT (email) DO UPDATE SET n = n + 100",
      "INSERT INTO d(id, n) VALUES (5, 5)", // 衝突を解決しない文は、SQLite と同じく UNIQUE 違反になる
    ]) {
      const want = (() => { try { return Number(lite.prepare(sql).run().changes); } catch (e) { return `ERROR ${(e as Error).message}`; } })();
      expect({ sql, got: await db.query(sql).then((r) => r.changes, (e: Error) => `ERROR ${e.message}`) }).toEqual({ sql, got: want });
    }
    expect((await db.query("SELECT id, email, n FROM d ORDER BY id")).rows).toEqual(lite.prepare("SELECT id, email, n FROM d ORDER BY id").all().map((r) => ({ ...r })));
    expect(await quiescentProblems(c)).toEqual([]);
  });

  it("UPDATE OR IGNORE and UPDATE OR REPLACE resolve a conflict with a row of another tenant", async () => {
    await same([...seed,
      ["UPDATE OR IGNORE users SET email = 'a@x' WHERE tenant_id = 2 AND id = 1", []],
      ["UPDATE OR IGNORE users SET email = 'a@x' WHERE tenant_id IN (2, 3)", []],
      ["UPDATE OR REPLACE users SET email = 'a@x' WHERE tenant_id = 2 AND id = 1", []],
      ["UPDATE OR REPLACE users SET code = 'k', email = 'c@x' WHERE tenant_id = 2", []],
      ["UPDATE OR IGNORE users SET n = n + 1, email = 'fresh@x' WHERE tenant_id = 2", []],
    ]);
    // 複数の行を同じ UNIQUE の値へ書き換える文 (どの行が残るかが、行の並び順で決まる) は、ここでは比べない。
    // 行の並び順は SQL では定まらず、シャードをまたぐと SQLite 単体の順序を再現できない。
  });

  it("a write that does not resolve conflicts fails with SQLite's error, whichever shard holds the conflicting row", async () => {
    await same([...seed,
      ["INSERT INTO users(tenant_id, id, email, code) VALUES (4, 1, 'a@x', 'c1')", []], // 別の tenant の email
      ["INSERT INTO users(tenant_id, id, email, code) VALUES (1, 2, 'd@x', 'c1')", []], // 同じ tenant の code
      ["INSERT INTO users(tenant_id, id, email, code) VALUES (1, 1, 'e@x', 'c9')", []], // 主キー
      ["UPDATE users SET email = 'a@x' WHERE tenant_id = 2 AND id = 1", []],
      ["UPDATE users SET email = 'b@x' WHERE n = 0", []], // 複数シャードの行を書き換える文。1 行目から衝突する
      ["UPDATE users SET code = 'c1' WHERE tenant_id = 1 AND id = 1", []], // 自分自身の値への書き換えは衝突しない
      ["UPDATE users SET tenant_id = 2 WHERE tenant_id = 1 AND id = 1", []], // 行を別の tenant へ移すと、主キーが衝突する
    ]);
  });

  it("a write across tenants resolves a conflict on a UNIQUE that stays inside one tenant", async () => {
    await same([...seed,
      ["INSERT INTO users(tenant_id, id, email, code) VALUES (1, 2, 'd@x', 'c2'), (2, 2, 'e@x', 'c2'), (3, 2, 'f@x', 'c2')", []],
      ["UPDATE OR IGNORE users SET code = 'c1' WHERE id = 2", []], // どの tenant でも、行 1 が c1 を持っている
      ["UPDATE OR REPLACE users SET code = 'c1' WHERE id = 2 AND tenant_id IN (1, 3)", []], // 行 1 を消して置き換える
      ["DELETE FROM users WHERE code = 'c1' AND tenant_id = 3", []],
    ]);
  });

  it("a statement with `x IN table` is answered from every shard, whether it reads or writes", async () => {
    const c = new SimCluster({ shards: 3 });
    const db = c.client();
    await db.ddl("CREATE TABLE allowed(id INTEGER PRIMARY KEY)");
    await db.ddl("CREATE TABLE t(id INTEGER PRIMARY KEY, ok INTEGER)");
    for (let i = 1; i <= 6; i++) await db.query("INSERT INTO allowed VALUES (?)", [i]);
    for (let i = 1; i <= 6; i++) await db.query("INSERT INTO t VALUES (?, ? IN allowed)", [i, i + 3]);
    expect((await db.query("SELECT id, ok FROM t ORDER BY id")).rows.map((r) => r.ok)).toEqual([1, 1, 1, 0, 0, 0]);
    for (let i = 1; i <= 6; i++) {
      expect((await db.query("SELECT ? IN allowed AS hit FROM t WHERE id = ?", [7 - i, i])).rows).toEqual([{ hit: 1 }]);
    }
    await db.query("UPDATE t SET ok = 2 WHERE id = 1 AND 6 IN allowed");
    expect((await db.query("SELECT ok FROM t WHERE id = 1")).rows).toEqual([{ ok: 2 }]);
    expect(c.spanEscapes).toEqual([]);
  });

  it("an INSERT reads only the rows it can conflict with, not the table it inserts into", async () => {
    // 基準経路の INSERT は、挿入先の表を集めない。集めるのは、入れる行と主キーか UNIQUE の値が同じ行だけである。
    // 表を丸ごと集めても結果は同じだが、行数の上限に当たって、大きな表へ 1 行も入れられなくなる。
    const { c, db } = await same(Array.from({ length: 30 }, (_, i): [string, unknown[]] =>
      ["INSERT INTO users(tenant_id, id, email, code) VALUES (?, ?, ?, ?)", [1 + (i % 6), i, `u${i}@x`, `k${i}`]]));
    const before = c.net.log.length;
    await db.query("INSERT OR IGNORE INTO users(tenant_id, id, email, code) VALUES (7, 1, 'u3@x', 'k')");
    await db.query("INSERT INTO users(tenant_id, id, email, code) VALUES (7, 2, 'new@x', 'k2') ON CONFLICT (email) DO UPDATE SET n = n + 1");
    const reads = c.net.log.slice(before).filter((m) => m.method === "exec").map((m) => (m.req as { sql: string }).sql);
    expect(reads.length).toBeGreaterThan(0);
    expect(reads.filter((sql) => /FROM "users"/.test(sql) && !/WHERE/.test(sql))).toEqual([]);
    expect((await db.query("SELECT count(*) AS c FROM users")).rows).toEqual([{ c: 31 }]);
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
