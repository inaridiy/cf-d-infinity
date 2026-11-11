// 未解決: 範囲を受け取ったシャードが、その範囲について元の持ち主が発行した時刻より小さい時刻を発行する。
//
// 見つけたのは test/history.test.ts の seed 146 と 219 (行ロックを取る取引、分割、再起動の掛け合わせ) である。
// 取引は確定の時刻の順に並ぶ、というのが全体の前提なので、同じ行について後から起きた書き込みが、先に起きた読みより
// 小さい時刻を持つと、その読みは「書き込みの後なのに、書き込みを見ていない」ことになる。
//
// 仕組み。分割では、行のあるグループ (shard key の値) は、渡す側が時刻 m を発行して運び、受け取る側は m まで時計を進める。
// 行のないグループは運ばれないので、受け取る側の時計は進まない。渡す側の時計が先に進んでいると (再起動の後は、保存してある
// 上限まで約 1 秒進む。Durable Object の間の時計のずれでも同じである)、受け取る側は、渡す側が「行はない」と答えた時刻より
// 小さい時刻で、その行を書ける。
import { describe, expect, it } from "vitest";
import { split } from "../../src/autoscaler";
import { Db } from "../../src/client/db";
import { planSplit, slotOf } from "../../src/routing";
import { SimCluster } from "../sim";

describe("a shard that receives a range", () => {
  it("does not commit a row at a timestamp below one the old owner issued for that row", async () => {
    const c = new SimCluster({ shards: 1 });
    await c.client().ddl("CREATE TABLE t(id INTEGER PRIMARY KEY, n INTEGER NOT NULL)");
    const range = planSplit((await c.catalog()).routing, "s0")!;
    // 移る範囲にある id と、残る範囲にある id を 1 つずつ選ぶ。移る範囲には行を入れない。
    const inRange = (id: number) => {
      const slot = slotOf(JSON.stringify([id]));
      return slot >= range.start && slot < range.end;
    };
    let absent = 1;
    while (!inRange(absent)) absent++;
    let staying = 1;
    while (inRange(staying)) staying++;
    await new Db(c).query("INSERT INTO t VALUES (?, 1)", [staying]);

    // 持ち主の時計を先へ進める。再起動すると、時計は保存してある上限から再開する。
    c.restart("s0");
    const read = await new Db(c).query("SELECT n FROM t WHERE id = ?", [absent]);
    expect(read.rows).toEqual([]);

    // 範囲を s1 へ渡す。運ぶ行がないので、s1 は s0 の時刻を何も受け取らない。
    expect(await split(c, "s0", "s1", { range })).not.toBeNull();
    // s0 が「行はない」と答えた時刻より後でなければ、その読みは、書き込みの後なのに書き込みを見ていないことになる。
    const write = await new Db(c).query("INSERT INTO t VALUES (?, 1)", [absent]);
    expect(write.ts!).toBeGreaterThan(read.ts!);
  });
});
