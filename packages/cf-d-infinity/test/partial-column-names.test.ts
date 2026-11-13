// 部分集約 (シャードごとに集約して合わせる経路) の結果の列名が、引用符で囲んだ列名のとき SQLite と違う。
// `SELECT "union", count(*) FROM t GROUP BY "union"` の列名は、SQLite では union、D∞ では "union" (引用符つき) だった。
// 列名は選択の項の文面から作っていて、識別子だけの項でも引用符を外していなかった。見つけたのは、乱択の差分の生成器に予約語の
// 名前の列を足したとき (2026-11-13、test/fuzz.test.ts の seed 3)。計画書の「SQLite と同じ答え」(不変条件の表の外の、互換の項目)。
import { DatabaseSync } from "node:sqlite";
import { describe, expect, it } from "vitest";
import { Db } from "../src/client/db";
import { SimCluster } from "./sim";

describe("partial aggregation names its result columns as SQLite does", () => {
  it("drops the quotes of a quoted column name", async () => {
    const ddl = `CREATE TABLE t(id INTEGER PRIMARY KEY, "union" TEXT, "a b" INTEGER)`;
    const lite = new DatabaseSync(":memory:");
    lite.exec(ddl);
    const db = new Db(new SimCluster({ shards: 3 }));
    await db.ddl(ddl);
    for (const sql of [`SELECT "union", count(*) FROM t GROUP BY "union"`, `SELECT "a b", sum(id) FROM t GROUP BY "a b"`, `SELECT [union], max(id) FROM t GROUP BY 1`]) {
      const want = lite.prepare(sql).columns().map((c) => c.name);
      expect((await db.query(sql)).columns).toEqual(want);
    }
  });
});
