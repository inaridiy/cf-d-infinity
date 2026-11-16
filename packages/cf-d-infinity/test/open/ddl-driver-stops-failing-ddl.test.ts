// 未解決: 行で失敗する DDL を記録した直後に進める側が止まると、取り消されるまでの間、ほかの接続がその DDL を見る。
//
// 段 3 より前の DDL は、Meta が版を記録してから全シャードへ適用させる。片方のシャードの行が CHECK に反する ADD COLUMN では、
// そのシャードが適用に失敗して、取り消しの版を記録する。進める側が、版を記録した後、シャードへ適用させる前に止まると、
// 取り消しは、どれかの要求がそのシャードに版を適用させるまで起きない。その間、Meta の表定義は列を足した形で、ほかの接続は
// それで計画する (4 つの値の INSERT が「5 columns but 4 values」で失敗する)。どこでも効かない文が、効いたように見える。
// 不変条件の候補: 確定していない表定義の変更は、どの計画にも見えない。持ち主は Meta の表定義の遷移 (docs/design-catalog-epoch.md の段 3)。
// 見つけたのは、進める側を各手の前で止める検査 (test/ddl-driver.ts) を、段 3 より前のコードで流したときである (2026-11-16)。
import { describe, expect, it } from "vitest";
import { Db } from "../../src/client/db";
import { outcome, stopsEverywhere, twoShards } from "../ddl-driver";

describe("a schema change whose driver stops before one of its steps", () => {
  it("an ADD COLUMN whose CHECK the rows of one shard violate: takes effect whole or not at all, and the cluster stays usable, wherever the driver stops", async () => {
    const steps = await stopsEverywhere({
      name: "an ADD COLUMN whose CHECK the rows of one shard violate",
      async setup() {
        const { c, db, bad, good } = await twoShards();
        await db.query("INSERT INTO p VALUES (?, 1, 'x', 1), (?, 2, 'y', NULL)", [bad, good]);
        return {
          c,
          run: (d) => d.ddl("ALTER TABLE p ADD COLUMN extra INTEGER CHECK (gone IS NULL)"),
          // s0 の行が CHECK に反するので、文はどこでも効かない。列を足す前の形のまま、どちらのシャードへも書ける。
          async check(c) {
            const other = new Db(c);
            const wrote = await outcome(other.query("INSERT INTO p VALUES (?, 3, 'z', 1), (?, 3, 'z', 1)", [bad, good]));
            const read = await outcome(other.query("SELECT extra FROM p"));
            const cat = await c.catalog();
            return { wrote, extra: cat.tables.p!.columns.includes("extra"), read: /no such column/.test(read) ? "no such column" : read };
          },
        };
      },
      expected: () => ({ wrote: "ok", extra: false, read: "no such column" }),
    });
    expect(steps.length).toBeGreaterThan(3);
  });
});
