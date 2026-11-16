// 式の木の深さの見積もり (src/sql/depth.ts) と、表を作るときの上限の確かめ (Db.assertReplays、src/shard-limits.ts の builtLimitOf)。
//
// DO の SQLite は、式の木の深さを 100 までに制限している (test/workerd-limits.test.ts)。node:sqlite と sql.js は上限を変えられず、
// シミュレータでは見えないので、見積もりを SQLite の数え方と突き合わせておく。下の SQLITE の値は、sqlite3 3.45.1 の CLI で
// `.limit expr_depth N` を二分して求めた、文が通る最小の N である (2026-11-14)。見積もりは、これより小さくなってはならない。
// 大きく出るのは、SQLite が数えない節 (値の組の中身、BETWEEN の端、COLLATE) を数えるときだけである。
import { DatabaseSync } from "node:sqlite";
import { describe, expect, it } from "vitest";
import { imageStatements } from "../src/shard/rows";
import { builtLimitOf } from "../src/shard-limits";
import { expressionDepth } from "../src/sql/depth";
import { fullScan } from "../src/sql/plan";
import { typedReadSql } from "../src/value";
import type { TableDef } from "../src/types";
import { Db } from "../src/client/db";
import { SimCluster } from "./sim";

const chain = (n: number, op = "AND") => Array.from({ length: n }, (_, k) => `c${k % 4} IS ?`).join(` ${op} `);
const chainq = (n: number, t: string) => Array.from({ length: n }, (_, k) => `${t}.c${k % 4} IS ?`).join(" AND ");

/** [文, sqlite3 3.45.1 が通す最小の深さ, 見積もりが上に外れてよい幅 (既定は 2)]。 */
const SQLITE: [string, number, number?][] = [
  [`SELECT 1 FROM a99 WHERE ${chain(98)}`, 99],
  [`SELECT 1 FROM a99 WHERE ${chain(99)}`, 100],
  [`SELECT 1 FROM a99 WHERE ${chain(100)}`, 101],
  [`SELECT 1 FROM a99 WHERE ${chain(60, "OR")}`, 61],
  ["SELECT 1 + 2 * 3 - 4", 4],
  ["SELECT json_array(substr(typeof(c0),1,1) || CASE typeof(c0) WHEN 'real' THEN quote(c0) WHEN 'blob' THEN hex(c0) ELSE c0 END) FROM a99", 5],
  ["SELECT 1 FROM a99 WHERE (c0, c1) > (?, ?)", 2],
  ["SELECT 1 FROM a99 WHERE c0 IN (SELECT value FROM json_each(?))", 3],
  ["SELECT (CAST(? AS INTEGER)+0)", 3],
  ["SELECT EXISTS (SELECT 1 FROM __cap_on)", 3],
  ["SELECT 1 FROM a99 WHERE ((c0 IS ? AND c1 IS ?) AND (c2 IS ? AND c3 IS ?))", 4],
  ["SELECT NOT 1 = 2", 3],
  ["SELECT -1", 2],
  ["SELECT 1 IS NOT NULL", 2],
  ["SELECT 1 IN (1, 2)", 2],
  ["SELECT 1 IN (1)", 3],
  ["SELECT (SELECT max(c0) FROM a99) + 1", 6],
  ["SELECT 1 FROM a99 WHERE c0 BETWEEN 1 AND 2 + 3", 3],
  ["SELECT 1 FROM a99 WHERE EXISTS (SELECT 1 FROM a99 WHERE c0 = (SELECT 1 + 1))", 11],
  ["CREATE TRIGGER t AFTER INSERT ON a99 WHEN EXISTS (SELECT 1 FROM __cap_on) BEGIN INSERT INTO __cap(tbl, old, new) VALUES ('a99', NULL, json_array(json_array(new.c0), json_array(new.c1))); END", 4],
  ["SELECT 1 FROM a99 LIMIT 1 OFFSET 2", 2],
  ["SELECT 1 FROM a99 WHERE c0 LIKE 'a' ESCAPE 'b'", 2],
  ["SELECT a99.c0 FROM a99", 2],
  // 型つきの読みに包んだ文 (src/value.ts の typedReadSql)。CTE の本体は、中の文の深さに、包む式の深さ (3) と、FROM の副問い合わせ
  // の 1 を足して数える (2026-11-14、段 3)。SQLite は、中の文の深さのまま確かめる。
  [typedReadSql(`SELECT 1 FROM a99 WHERE ${chain(98)}`, 1), 99, 4],
  [typedReadSql(`SELECT 1 FROM a99 WHERE ${chain(60, "OR")}`, 1), 61, 4],
  [typedReadSql("SELECT c0, c1 FROM a99", 2), 3, 4],
  // CTE の本体は、参照した式の高さが足される。見積もりは、どこで参照されるかを追わずに、文のほかの部分の深さを足すので、多めに出る。
  // FROM と JOIN の副問い合わせは足されない (外の式の中にあれば、その高さが足される)。
  [`WITH r AS (SELECT 1 FROM a99 WHERE ${chain(60)}) SELECT ((SELECT count(*) FROM r) + 1) * 2`, 65, 6],
  [`WITH r AS (SELECT 1 FROM a99 WHERE ${chain(60)}) SELECT * FROM a99 WHERE c0 IN (SELECT 1 FROM r WHERE (1 + (2 + (3 + 4))) > 0)`, 67, 6],
  [`SELECT * FROM (SELECT 1 FROM a99 WHERE ${chain(60)})`, 61],
  [`SELECT (SELECT count(*) FROM (SELECT 1 FROM a99 WHERE ${chain(60)})) + 1`, 64],
  [`SELECT 1 FROM a99 JOIN (SELECT c0 AS x FROM a99 WHERE ${chain(40)}) ON x = c1`, 42],
  [`SELECT 1 FROM a99 JOIN (SELECT c0 AS x FROM a99 WHERE ${chain(40)}) ON x = c1 WHERE ${chain(60)}`, 63],
  [`SELECT 1 FROM (SELECT c0 AS x FROM a99 WHERE ${chain(40)}), (SELECT c1 AS y FROM a99 WHERE ${chain(40)}) WHERE x = y`, 43],
  // 結合の条件は WHERE に AND でつながる。ON は 1 項、USING は列ごと、NATURAL は同じ名前の列ごとに深くなる (段 3 で足した)。
  [`SELECT 1 FROM a99, a99 b WHERE ${chainq(60, "a99")}`, 62],
  [`SELECT 1 FROM a99 JOIN a99 b ON b.c0 = a99.c0 WHERE ${chainq(60, "a99")}`, 63],
  [`SELECT 1 FROM a99 JOIN a99 b ON b.c0 = a99.c0 JOIN a99 c ON c.c1 = b.c1 WHERE ${chainq(60, "a99")}`, 64],
  [`SELECT 1 FROM a99 LEFT JOIN a99 b ON b.c0 = a99.c0 WHERE ${chainq(60, "a99")}`, 63],
  [`SELECT 1 FROM a99 JOIN a99 b USING (c0) WHERE ${chainq(60, "a99")}`, 63],
  [`SELECT 1 FROM a99 JOIN a99 b ON ${chainq(60, "b")}`, 62],
  [`SELECT 1 FROM a99 JOIN a99 b ON ${chainq(60, "b")} WHERE a99.c0 = 1`, 63],
  // NATURAL は、同じ名前の列の数 (ここでは 4) だけ深くなる。見積もりは列の数を知れないので、表の列の上限 (100) を足す。
  [`SELECT 1 FROM a99 NATURAL JOIN a99 b WHERE ${chain(60)}`, 65, 100],
];

const def = (n: number, pk: number, implicitRowid = false): TableDef => {
  const columns = Array.from({ length: n }, (_, i) => `column_${String(i).padStart(2, "0")}`);
  const keys = implicitRowid ? ["rowid"] : columns.slice(0, pk);
  return {
    name: `w${n}`, columns, pk: keys, shardKey: keys.slice(0, 1), implicitRowid, rowidAlias: null, skAffinity: [],
    affinity: Object.fromEntries(columns.map((c) => [c, "INTEGER"])), collated: [], collation: {}, uniques: [], globalIndexes: [],
  } as TableDef;
};

describe("the expression depth estimate", () => {
  it("is never below what SQLite counts, and close to it", () => {
    for (const [sql, want, slack = 2] of SQLITE) {
      const got = expressionDepth(sql);
      expect(got, sql.slice(0, 80)).toBeGreaterThanOrEqual(want);
      expect(got, sql.slice(0, 80)).toBeLessThanOrEqual(want + slack);
    }
  });

  it("keeps the statements D∞ runs for a table shallow, whatever its width or key", () => {
    // 主キーの列を AND でつなぐ条件は、主キーの列の数だけ深くなっていた。釣り合った木に組むので、深さは列の数の対数で増える。
    for (const [n, pk] of [[1, 1], [3, 2], [33, 1], [64, 10], [99, 1], [99, 99], [100, 100]] as const) {
      const d = def(n, pk);
      // 全表の走査は、シャードが実行する形 (型つきの読み) で測る。
      const scan = fullScan(d);
      const depths = [typedReadSql(scan.sql, scan.columns.length), ...imageStatements(d).map((s) => s.sql)].map(expressionDepth);
      expect(Math.max(...depths), `${n} columns, ${pk} in the key`).toBeLessThanOrEqual(20);
      for (const s of imageStatements(d)) expect(builtLimitOf(s.sql, s.params), `${n} columns, ${pk} in the key: ${s.sql.slice(0, 60)}`).toBeNull();
    }
  });

  it("refuses at CREATE TABLE a table whose statements cannot fit, with a reason decided by the table", async () => {
    const db = new Db(new SimCluster({ shards: 2 }));
    // PRIMARY KEY のない 100 列の表は、行を入れ直す文が rowid と 100 列で、束縛の変数が 101 個になる。分割で行を運べない。
    const cols = Array.from({ length: 100 }, (_, i) => `c${i} INTEGER`).join(", ");
    await expect(db.ddl(`CREATE TABLE r(${cols})`)).rejects.toThrow(/^unsupported: the table r is too wide for a shard to scan.*101 parameters/);
    // 主キーのある 100 列の表は作れる。
    await db.ddl(`CREATE TABLE k(c0 INTEGER PRIMARY KEY, ${Array.from({ length: 99 }, (_, i) => `d${i} INTEGER`).join(", ")})`);
    await db.query("INSERT INTO k(c0, d0) VALUES (1, 2)");
    expect((await db.query("SELECT c0, d0, d98 FROM k")).rows).toEqual([{ c0: 1, d0: 2, d98: null }]);
  });
});

// 利用者の文の深さ (計画書の未解決の問題 39、test/user-statement-expression-depth.test.ts が workerd で確かめる)。シャードは、届いた
// 文の深さを測り、上限を超える文を ShardLimit で断る (src/shard-limits.ts)。Worker は、その文を基準経路で実行し直す (Worker の SQLite
// の上限は 1,000 である)。シミュレータも同じ上限を模す (test/sim.ts の checkDoDepth) ので、ここでも見える。
describe("a user statement near the depth limit of the DO SQLite", () => {
  it("answers as SQLite does on 1, 2 and 4 shards, whatever its depth", async () => {
    for (const shards of [1, 2, 4]) {
      const db = new Db(new SimCluster({ shards }));
      const lite = new DatabaseSync(":memory:");
      const ddl = "CREATE TABLE t(tenant_id INTEGER NOT NULL, id INTEGER NOT NULL, a INTEGER, b TEXT, PRIMARY KEY (tenant_id, id))";
      await db.ddl(ddl);
      lite.exec(ddl);
      for (let i = 1; i <= 6; i++) {
        const row = [BigInt(i % 2 + 1), BigInt(i), BigInt(i * 3), `b${i}`];
        await db.query("INSERT INTO t VALUES (?, ?, ?, ?)", row);
        lite.prepare("INSERT INTO t VALUES (?, ?, ?, ?)").run(...(row as never[]));
      }
      // 主キーで 1 行を引く文 (シャードへそのまま送る) と、shard key で絞る文に、条件を n 項つなぐ。整数の引数は、包むと深さを 2 足す。
      for (const n of [40, 90, 96, 97, 98, 99, 100, 101, 120]) {
        const terms = Array.from({ length: n }, (_, k) => (k % 2 ? "a > ?" : "b <> ?")).join(" AND ");
        const params = Array.from({ length: n }, (_, k) => (k % 2 ? -BigInt(k) : `x${k}`));
        for (const [sql, args] of [
          [`SELECT id, a FROM t WHERE tenant_id = ? AND id = ? AND ${terms}`, [2n, 3n, ...params]],
          [`SELECT id, a FROM t WHERE tenant_id = ? AND ${terms} ORDER BY id`, [1n, ...params]],
          [`UPDATE t SET a = a + 1 WHERE tenant_id = ? AND id = ? AND ${terms}`, [2n, 1n, ...params]],
        ] as [string, (bigint | string)[]][]) {
          const want = (() => {
            const st = lite.prepare(sql);
            st.setReadBigInts(true);
            return st.columns().length ? JSON.stringify(st.all(...(args as never[])).map((r) => Object.values(r)), (_k, x) => (typeof x === "bigint" ? Number(x) : x)) : (st.run(...(args as never[])), "ok");
          })();
          const got = await db.query(sql, args).then((r) => (r.columns.length ? JSON.stringify(r.rows.map((x) => Object.values(x))) : "ok"), (e: Error) => `error ${e.message}`);
          expect(got, `${shards} shards, ${n} terms: ${sql.slice(0, 60)}`).toBe(want);
        }
      }
    }
  }, 60_000);

  it("finds a row by a key of 99 columns bound as integers, which the bind wrap makes deeper than 100", async () => {
    const db = new Db(new SimCluster({ shards: 2 }));
    const cols = Array.from({ length: 99 }, (_, i) => `k${i}`);
    await db.ddl(`CREATE TABLE p(${cols.map((c) => `${c} INTEGER NOT NULL`).join(", ")}, v INTEGER, PRIMARY KEY (${cols.join(", ")}))`);
    const values = cols.map((_c, i) => BigInt(i));
    await db.query(`INSERT INTO p(${cols.join(", ")}, v) VALUES (${cols.map(() => "?").join(", ")}, 7)`, values);
    expect((await db.query(`SELECT v FROM p WHERE ${cols.map((c) => `${c} = ?`).join(" AND ")}`, values)).rows).toEqual([{ v: 7 }]);
    await db.query(`UPDATE p SET v = 8 WHERE ${cols.map((c) => `${c} = ?`).join(" AND ")}`, values);
    expect((await db.query(`SELECT v FROM p WHERE ${cols.map((c) => `${c} = ?`).join(" AND ")}`, values)).rows).toEqual([{ v: 8 }]);
  });

  it("keeps a UNIQUE of many columns usable: the span condition that the shard checks rows with is a balanced tree", async () => {
    // 書き込みが UNIQUE の検査で読む行の範囲 (src/client/spans.ts) は、UNIQUE の列を AND でつなぐ。段 2 までは、列の数だけ深くなった。
    const db = new Db(new SimCluster({ shards: 2 }));
    const cols = Array.from({ length: 97 }, (_, i) => `u${i}`);
    await db.ddl(`CREATE TABLE q(tenant_id INTEGER NOT NULL, id INTEGER NOT NULL, ${cols.map((c) => `${c} INTEGER`).join(", ")}, PRIMARY KEY (tenant_id, id), UNIQUE (tenant_id, ${cols.join(", ")}))`);
    await db.transaction(async (tx) => {
      for (let id = 1n; id <= 3n; id++) await tx.query(`INSERT INTO q(tenant_id, id, ${cols.join(", ")}) VALUES (1, ?, ${cols.map(() => "?").join(", ")})`, [id, ...cols.map(() => id)]);
    });
    await expect(db.query(`INSERT INTO q(tenant_id, id, ${cols.join(", ")}) VALUES (1, 9, ${cols.map(() => "?").join(", ")})`, cols.map(() => 2n))).rejects.toThrow(/UNIQUE/);
    expect((await db.query("SELECT count(*) AS n FROM q")).rows).toEqual([{ n: 3 }]);
  });
});
