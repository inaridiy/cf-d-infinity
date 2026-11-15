// 型のない列が多い表を、読み書きできること (段 0 に見つけた欠陥。値の作り直しの段 3 で直り、test/open/ から移した)。
//
// 段 2 までは、型のない列が多い表は、CREATE TABLE を通るのに、DO では読むことも書くこともできなかった。
//
// DO の SQLite は、結果の列を 100 までに制限している (test/workerd-limits.test.ts)。行イメージを読む文と、行を集める走査
// (src/shard/rows.ts の imageList と、型のない列の typeof を一緒に読む走査) は、表の列に、型のない列ごとの typeof の列と、
// 2^53 の確かめの 1 列を足す。列の数と、型のない列の数と、1 を足して 100 を超える表では、INSERT も UPDATE も DELETE も SELECT も
// 「too many columns in result set」で失敗する (PRIMARY KEY のない表は、rowid の列がもう 1 つ加わる)。いちばん小さい例は、
// 主キーの 1 列と型のない 50 列の表で、結果が 102 列になる。表を作るときの確かめ (src/client/db.ts の assertReplays) は、これを見ない。
// 式の木の深さの上限で書けなかった表 (test/wide-table-expression-depth.test.ts。段 2 で直った) と同じ穴である。表を作るときの確かめも
// シミュレータも、DO の SQLite のこの 2 つの上限を知らなかった。
//
// 正しい振る舞いは 2 つのどちらかである。作れた表は読み書きできるか、できない表は CREATE TABLE が断るか (表定義だけで決まる
// 拒否は、AGENTS.md の規則 4 が認めている)。
// 見つけたのは、値の作り直しの段 0 で、シミュレータが結果の列の上限を模すようにしたとき (test/sim.ts の DO_MAX_RESULT_COLUMNS、
// 2026-11-14)。それまでは、シミュレータの node:sqlite が 2,000 列まで受け付けるので、シミュレータの試験では通っていた
// (test/shard-limits.test.ts は、64 列とも型のない表を使っていた)。本物の workerd でも同じ誤りになることを確かめた。
// 足す列は、作り直しの段 2 と段 3 で、imageList と typeof の列と一緒になくなる。
// 段 2 (2026-11-14) の後: 行イメージはタプル (1 列) になり、捕捉と行の読みは列を足さなくなった。INSERT、UPDATE、DELETE は通る。
// 残ったのは行を集める走査 (段 2 までの src/sql/plan.ts の scanSql、Scan.typed) で、型のない列ごとの typeof の列を足したので、型の
// ない列が 50 以上の表では、複数のシャードから行を集める SELECT が「too many columns in result set」で失敗した。段 3 で、走査は
// 型つきの読み (列を足さずに、列ごとに型の印を付ける) に替わった。
import { describe, expect, it } from "vitest";
import { Db } from "../src/client/db";
import { SimCluster } from "./sim";

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
