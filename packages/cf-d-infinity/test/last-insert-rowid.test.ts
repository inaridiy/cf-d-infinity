// 直した (計画書の未解決の問題 46): 文の結果の lastInsertRowid が、文を実行した経路で変わる。
//
// 規則 (docs/sql-language.md、test/inserted-rowid.ts): 文が最後に入れた行の rowid。行を入れなかった文は null。REPLACE は入れたことに
// なり、UPSERT の DO UPDATE と、OR IGNORE が入れなかった行は、ならない。rowid が行のキーでない表の行は数えない。
// 直す前は、経路ごとに別の数え方をしていた。
//   - 基準経路 (Txn.wasmWrite) は Worker の SQLite の last_insert_rowid() を読む。UPDATE と DELETE には、捕捉の印の
//     `INSERT INTO __cap_on VALUES (1)` の rowid 1 が返る。TEXT の主キーの表には、その SQLite が振った隠れた rowid が返る。
//     利用者が明示した rowid 0 は null になる (`last === 0n ? null : last`)。
//   - シャードへ送る経路 (Txn.write、Db.autoWrite) は、計画が VALUES の最後の行の rowid を返す。DO UPDATE で更新しただけの行も
//     「入れた」ことになる。
// 見つけたのは、差分の検査に lastInsertRowid の比較を足したとき (2026-11-16。test/typed-diff.test.ts と
// test/placement-differential.test.ts。直す前に、どちらも上のすべての形で落ちた)。
//
// 直し方 (2026-11-16): lastInsertRowid は 1 つの関数 (src/client/db.ts の lastInsertRowid) だけが決める。材料は、文を実行した SQLite
// の捕捉が記録した、入れた行である (INSERT の trigger の記録、RETURNING で捕捉した INSERT の行。シャードの応答の ExecRes.inserted)。
// 宛先ごとに分けた INSERT は、計画が持つ VALUES の位置で並べる (valuesOrder)。計画が持っていた lastRowid は消した。
import { DatabaseSync } from "node:sqlite";
import { describe, expect, it } from "vitest";
import { Db } from "../src/client/db";
import { insertedRowids } from "./inserted-rowid";
import { SimCluster } from "./sim";

const SCHEMA = [
  "CREATE TABLE t(id INTEGER PRIMARY KEY, u INTEGER, v INTEGER)",
  "CREATE TABLE k(name TEXT PRIMARY KEY, v INTEGER)",
];
const STATEMENTS = [
  "INSERT INTO t VALUES (1, 10, 1), (2, 20, 2), (3, 30, 3), (4, 40, 4)",
  "UPDATE t SET v = v + 1 WHERE id BETWEEN 2 AND 3",
  "UPDATE t SET v = v + 1 WHERE id = 2",
  "DELETE FROM t WHERE id = 4",
  "DELETE FROM t WHERE v > 100",
  "INSERT INTO t VALUES (0, 0, 0)",
  "INSERT INTO t VALUES (2, 21, 9) ON CONFLICT(id) DO UPDATE SET v = excluded.v",
  "INSERT INTO t VALUES (7, 70, 7) ON CONFLICT(id) DO UPDATE SET v = excluded.v",
  "INSERT OR IGNORE INTO t VALUES (1, 11, 1)",
  "INSERT OR IGNORE INTO t VALUES (8, 80, 8), (1, 11, 1)",
  "INSERT OR REPLACE INTO t VALUES (3, 31, 3)",
  "INSERT INTO t(u, v) VALUES (90, 9)",
  "INSERT INTO k VALUES ('a', 1)",
  "INSERT INTO t SELECT id + 100, u, v FROM t WHERE id <= 2 ORDER BY id",
  "SELECT count(*) FROM t",
];

describe("lastInsertRowid", () => {
  for (const [what, opts] of [["the planner's paths", {}], ["the reference path only", { reference: "scans" as const }]] as const) {
    for (const shards of [1, 2]) {
      it(`is the rowid of the last row the statement inserted, on ${what}, ${shards} shard(s)`, async () => {
        const c = new SimCluster({ shards });
        const db = new Db(c, opts);
        const lite = new DatabaseSync(":memory:");
        for (const s of SCHEMA) {
          await db.ddl(s);
          lite.exec(s);
        }
        const inserted = insertedRowids(lite);
        const got: string[] = [];
        const want: string[] = [];
        for (const sql of STATEMENTS) {
          inserted.start();
          lite.prepare(sql).all();
          want.push(`${sql} -> ${inserted.last()}`);
          got.push(`${sql} -> ${(await db.query(sql)).lastInsertRowid}`);
        }
        expect(got).toEqual(want);
      });
    }
  }
});
