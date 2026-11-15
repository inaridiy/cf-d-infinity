// 式の木の深さの見積もり (src/sql/depth.ts) と、表を作るときの上限の確かめ (Db.assertReplays、src/shard-limits.ts の builtLimitOf)。
//
// DO の SQLite は、式の木の深さを 100 までに制限している (test/workerd-limits.test.ts)。node:sqlite と sql.js は上限を変えられず、
// シミュレータでは見えないので、見積もりを SQLite の数え方と突き合わせておく。下の SQLITE の値は、sqlite3 3.45.1 の CLI で
// `.limit expr_depth N` を二分して求めた、文が通る最小の N である (2026-11-14)。見積もりは、これより小さくなってはならない。
// 大きく出るのは、SQLite が数えない節 (値の組の中身、BETWEEN の端、COLLATE) を数えるときだけである。
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

/** [文, sqlite3 3.45.1 が通す最小の深さ]。 */
const SQLITE: [string, number][] = [
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
    for (const [sql, want] of SQLITE) {
      const got = expressionDepth(sql);
      expect(got, sql.slice(0, 80)).toBeGreaterThanOrEqual(want);
      expect(got, sql.slice(0, 80)).toBeLessThanOrEqual(want + 2);
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
