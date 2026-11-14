// 未解決: 型のない列が多い表は、CREATE TABLE を通るのに、DO では読むことも書くこともできない。
//
// DO の SQLite は、結果の列を 100 までに制限している (test/workerd-limits.test.ts)。行イメージを読む文と、行を集める走査
// (src/shard/rows.ts の imageList と、型のない列の typeof を一緒に読む走査) は、表の列に、型のない列ごとの typeof の列と、
// 2^53 の確かめの 1 列を足す。型のない列が 50 個ある 51 列の表では、結果が 102 列になり、INSERT も UPDATE も DELETE も SELECT も
// 「too many columns in result set」で失敗する。表を作るときの確かめ (src/client/db.ts の assertReplays) は、これを見ない。
//
// 正しい振る舞いは 2 つのどちらかである。作れた表は読み書きできるか、できない表は CREATE TABLE が断るか (表定義だけで決まる
// 拒否は、AGENTS.md の規則 4 が認めている)。
// 見つけたのは、値の作り直しの段 0 で、シミュレータが結果の列の上限を模すようにしたとき (test/sim.ts の DO_MAX_RESULT_COLUMNS、
// 2026-11-14)。それまでは、シミュレータの node:sqlite が 2,000 列まで受け付けるので、シミュレータの試験では通っていた
// (test/shard-limits.test.ts は、64 列とも型のない表を使っていた)。本物の workerd でも同じ誤りになることを確かめた。
// 足す列は、作り直しの段 2 と段 3 で、imageList と typeof の列と一緒になくなる。
import { describe, expect, it } from "vitest";
import { Db } from "../../src/client/db";
import { SimCluster } from "../sim";

describe("a table with many columns that have no type", () => {
  for (const untyped of [49, 50, 64, 98]) {
    it(`${untyped} untyped columns: either CREATE TABLE refuses the table, or its rows can be written and read`, async () => {
      const db = new Db(new SimCluster({ shards: 2 }));
      const cols = Array.from({ length: untyped }, (_, i) => `c${i}`);
      const created = await db.ddl(`CREATE TABLE u(id INTEGER PRIMARY KEY, ${cols.join(", ")})`).then(() => true, () => false);
      if (!created) return;
      const run = (sql: string) => db.query(sql).then((r) => (r.columns.length ? r.rows : "ok"), (e: Error) => `error ${e.message}`);
      expect(await run("INSERT INTO u(id, c0) VALUES (1, 5), (2, 5.0)")).toBe("ok");
      expect(await run("UPDATE u SET c1 = 6 WHERE id = 1")).toBe("ok");
      expect(await run("SELECT id, c0, c1, typeof(c0) AS t FROM u ORDER BY id")).toEqual([{ id: 1, c0: 5, c1: 6, t: "integer" }, { id: 2, c0: 5, c1: null, t: "real" }]);
      expect(await run("DELETE FROM u WHERE id = 2")).toBe("ok");
    });
  }
});
