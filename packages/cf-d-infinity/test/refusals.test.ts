// 断る文の一覧。
//
// 持ち主の規則 4: 行がどのシャードにあるかで、文が断られたり通ったりしてはいけない。断ってよいのは、文の形、値、表定義だけで
// 決まる場合と、資源の上限だけである。ここでは次の 3 つを確かめる。
//
//   1. ソースが `unsupported:` を返す箇所は、下の一覧のとおりである。断る箇所を足したら、この試験が落ちる。足す前に、それが
//      行の配置に依らないことを確かめ、docs/sql-language.md と計画書の「対応する範囲」に書く。
//   2. 一覧の文は、シャードが 1 つでも 3 つでも、同じように断られる。
//   3. 以前は断っていた文、行の配置によって断っていた文が、シャードの数に依らず、SQLite と同じ結果になる。
import { readdirSync, readFileSync, statSync } from "node:fs";
import { join, relative } from "node:path";
import { DatabaseSync } from "node:sqlite";
import { describe, expect, it } from "vitest";
import { SimCluster } from "./sim";

const SRC = join(import.meta.dirname, "..", "src");
const files = (dir: string): string[] => readdirSync(dir).flatMap((name) => {
  const path = join(dir, name);
  return statSync(path).isDirectory() ? files(path) : name.endsWith(".ts") ? [path] : [];
});

/** `unsupported:` を返す箇所。ファイルと、メッセージの先頭である。 */
const REFUSALS = [
  // 表定義で決まる
  "sql/ddl.ts: TEMP tables",
  "sql/ddl.ts: generated columns",
  "sql/ddl.ts: COLLATE ${collation[c]} on the primary key or shard key column",
  "sql/ddl.ts: COLLATE ${collation[bad]} on column ${bad} of a UNIQUE constraint that does not include the shard key",
  "sql/ddl.ts: COLLATE ${def.collation[collatedCol]} on column ${collatedCol} of a UNIQUE index that does not include the shard key",
  "sql/ddl.ts: CREATE TRIGGER",
  "sql/ddl.ts: ALTER TABLE ... RENAME COLUMN",
  "sql/ddl.ts: ALTER TABLE ... DROP COLUMN",
  "sql/ddl.ts: a UNIQUE partial or expression index that does not include the shard key",
  "sql/ddl.ts: column name ${name} is reserved for internal use",
  // 文の形で決まる
  "sql/plan.ts: CREATE TABLE ... AS SELECT",
  "client/db.ts: a statement that writes cannot read sqlite_master or a PRAGMA function",
  "client/db.ts: BEGIN, COMMIT, ROLLBACK and SAVEPOINT inside a transaction object",
  "client/db.ts: a schema change inside a transaction",
  "client/db.ts: the table ${def.name} is too wide for a shard to scan",
  // 値で決まる
  "shard/rows.ts: NULL in the primary key column",
  "value.ts: an INTEGER beyond",
  "client/hrana.ts: the integer ${v.value} cannot be stored exactly",
].sort();

describe("the statements this database refuses", () => {
  it("are exactly the listed ones", () => {
    const found: string[] = [];
    for (const path of files(SRC)) {
      const name = relative(SRC, path);
      const text = readFileSync(path, "utf8");
      // `unsupported: ...` の文字列と、ddl.ts の unsupported("...") の呼び出し。
      for (const m of text.matchAll(/["`]unsupported: ([^"`]+)/g)) found.push(`${name}: ${m[1]}`);
      for (const m of text.matchAll(/\bunsupported\(["`]([^"`]+)["`]\)/g)) found.push(`${name}: ${m[1]}`);
    }
    const heads = [...new Set(found.filter((f) => !f.endsWith(": ${what}")))].sort();
    const missing = REFUSALS.filter((r) => !heads.some((h) => h.startsWith(r)));
    const extra = heads.filter((h) => !REFUSALS.some((r) => h.startsWith(r)));
    expect({ missing, extra }).toEqual({ missing: [], extra: [] });
  });

  const DDL = [
    "CREATE TABLE t(tenant_id INTEGER NOT NULL, id INTEGER NOT NULL, email TEXT, code TEXT, n INTEGER NOT NULL DEFAULT 0, PRIMARY KEY (tenant_id, id), UNIQUE (email), UNIQUE (tenant_id, code))",
    "CREATE TABLE k(id TEXT PRIMARY KEY, v)",
    "CREATE TABLE d(id INTEGER PRIMARY KEY, email TEXT DEFAULT 'none@x' UNIQUE, n INTEGER)",
    "CREATE TABLE allowed(id INTEGER PRIMARY KEY)",
  ];
  const ROWS = [
    "INSERT INTO t(tenant_id, id, email, code) VALUES (1, 1, 'a@x', 'c1'), (2, 1, 'b@x', 'c1'), (3, 1, 'c@x', 'c1'), (4, 1, 'd@x', 'c1')",
    "INSERT INTO d(id, n) VALUES (1, 1)",
    "INSERT INTO allowed VALUES (1), (2), (3), (4), (5), (6)",
  ];
  const cluster = async (shards: number) => {
    const db = new SimCluster({ shards }).client();
    for (const s of [...DDL, ...ROWS]) await db.query(s);
    return db;
  };

  it("are refused the same way on one shard and on three", async () => {
    const refused = [
      "CREATE TEMP TABLE x(a)",
      "CREATE TEMPORARY TABLE x(a)",
      "CREATE TABLE temp.x(a)",
      "CREATE TABLE g(a INTEGER PRIMARY KEY, b INTEGER GENERATED ALWAYS AS (a + 1))",
      "CREATE TABLE c1(a TEXT COLLATE NOCASE PRIMARY KEY)",
      "CREATE TABLE c2(a INTEGER PRIMARY KEY, b TEXT COLLATE NOCASE UNIQUE)",
      "CREATE TRIGGER tr AFTER INSERT ON t BEGIN SELECT 1; END",
      "ALTER TABLE t RENAME COLUMN n TO m",
      "ALTER TABLE t DROP COLUMN n",
      "CREATE TABLE copy AS SELECT * FROM t",
      "UPDATE t SET n = (SELECT count(*) FROM sqlite_master) WHERE tenant_id = 1 AND id = 1",
      "INSERT INTO k VALUES (NULL, 1)",
    ];
    const [one, three] = [await cluster(1), await cluster(3)];
    for (const sql of refused) {
      const a = await one.query(sql).then(() => "ok", (e: Error) => e.message);
      const b = await three.query(sql).then(() => "ok", (e: Error) => e.message);
      expect(a, sql).toMatch(/^unsupported: /);
      expect(b, sql).toBe(a);
    }
  });

  it("no longer include statements that used to depend on where rows are: they give SQLite's result on one shard and on three", async () => {
    const statements = [
      // 衝突を自分で解決する UPDATE。衝突する行が別の tenant にある。
      "UPDATE OR IGNORE t SET email = 'a@x' WHERE tenant_id = 2 AND id = 1",
      "UPDATE OR REPLACE t SET email = 'a@x' WHERE tenant_id = 3 AND id = 1",
      // DEFAULT のある UNIQUE の列を省いた INSERT。
      "INSERT OR IGNORE INTO d(id, n) VALUES (2, 2)",
      "INSERT OR REPLACE INTO d(id, n) VALUES (3, 3)",
      // FROM に現れない表を読む文。
      "UPDATE t SET n = 5 IN allowed WHERE tenant_id = 4 AND id = 1",
      "INSERT INTO t(tenant_id, id, n) VALUES (5, 1, 9 IN allowed)",
      // ON CONFLICT と RETURNING の中のサブクエリ。
      "INSERT INTO t(tenant_id, id, email) VALUES (6, 1, 'd@x') ON CONFLICT (email) DO UPDATE SET n = (SELECT count(*) FROM allowed)",
      "INSERT INTO t(tenant_id, id, email) VALUES (7, 1, 'z@x') RETURNING (SELECT max(id) FROM allowed) AS top",
    ];
    const lite = new DatabaseSync(":memory:");
    for (const s of [...DDL, ...ROWS]) lite.exec(s);
    const dbs = [await cluster(1), await cluster(3)];
    for (const sql of statements) {
      const want = (() => {
        const st = lite.prepare(sql);
        return st.columns().length > 0 ? JSON.stringify(st.all()) : `${st.run().changes} changed`;
      })();
      for (const db of dbs) {
        const got = await db.query(sql).then((r) => (r.columns.length > 0 ? JSON.stringify(r.rows) : `${r.changes} changed`), (e: Error) => `ERROR ${e.message}`);
        expect(got, sql).toBe(want);
      }
    }
    for (const table of ["t", "d"]) {
      const all = `SELECT * FROM ${table} ORDER BY 1, 2`;
      for (const db of dbs) expect((await db.query(all)).rows, table).toEqual(lite.prepare(all).all().map((r) => ({ ...r })));
    }
  });
});
