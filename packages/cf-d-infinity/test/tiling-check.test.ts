// 全表の読みの区間の検査 (test/sim.ts の checkTiling) そのものの試験。
// 検査は、どの試験にも test/setup.ts から掛かっている。ここでは、検査が全表の読みを本当に確かめていることと、抜けた区間を見つけることを
// 確かめる。抜けは、Worker に、1 つのシャードを除いた範囲表を渡して作る (Meta の範囲表は変えない。シャードはどれも自分の claim に答える)。
import { afterEach, describe, expect, it } from "vitest";
import { Db } from "../src/client/db";
import { allTilingProblems, SimCluster, tilingStats, withOverrides } from "./sim";

const ROWS = 40;

async function cluster() {
  const c = new SimCluster({ shards: 4 });
  const db = new Db(c);
  await db.ddl("CREATE TABLE t(id INTEGER PRIMARY KEY, v INTEGER NOT NULL)");
  await db.query(`INSERT INTO t VALUES ${Array.from({ length: ROWS }, (_v, i) => `(${i + 1}, ${i + 1})`).join(", ")}`);
  return c;
}

describe("the tiling check of whole-table reads", () => {
  afterEach(() => {
    allTilingProblems.length = 0; // ここで見つけたものは、この試験が確かめた。全体の検査には渡さない
  });

  it("checks whole-table reads that gather rows, push the statement down, aggregate in parts or feed a write, and stays silent", async () => {
    const c = await cluster();
    const db = new Db(c);
    const before = tilingStats.checked;
    expect((await db.query("SELECT count(*) AS n FROM t")).rows).toEqual([{ n: ROWS }]);
    expect((await db.query("SELECT id FROM t WHERE v > 30 ORDER BY id")).values.length).toBe(10);
    await db.transaction(async (tx) => {
      expect((await tx.query("SELECT sum(v) AS s FROM t")).rows).toEqual([{ s: (ROWS * (ROWS + 1)) / 2 }]);
    });
    // 主キーで絞れない UPDATE と DELETE は、基準経路で行を集める (書き込みの側の全表の読み)。
    expect((await db.query("UPDATE t SET v = v + 1 WHERE v > 0")).changes).toBe(ROWS);
    await db.transaction(async (tx) => {
      expect((await tx.query("DELETE FROM t WHERE v > 40")).changes).toBe(1);
    });
    expect(tilingStats.checked - before).toBeGreaterThanOrEqual(5);
    expect(allTilingProblems).toEqual([]);
  });

  it("reports a whole-table read that did not ask one shard of the snapshot it named", async () => {
    const c = await cluster();
    // Worker にだけ、s3 の項目を除いた範囲表を見せる。epoch は本物のままなので、検査は Meta の範囲表と比べる。
    const db = new Db(withOverrides(c, {
      catalog: async () => {
        const cat = await c.catalog();
        return { ...cat, routing: { ...cat.routing, ranges: cat.routing.ranges.filter((x) => x.shard !== "s3") } };
      },
    }));
    const n = (await db.query("SELECT count(*) AS n FROM t")).rows[0]!.n as number;
    expect(n).toBeLessThan(ROWS);
    expect(allTilingProblems).toEqual([expect.stringMatching(/table t, routing at epoch \d+: did not ask s3 \(\[\d+, \d+\)\)$/)]);
  });
});
