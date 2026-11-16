// 前の移動の遅れた ack が、範囲が戻った後の同じグループの、まだ子に届いていない渡しを消さない (docs/design-catalog-epoch.md の「段 4 の
// 結果」の「受け取りの記録を受け取りごとに」と「検査」)。
//
// 親は、渡したグループの行を、子の ack を受けるまで持つ。子が受け取る前に落ちても、子は同じグループを引き取り直せる。段 4 から、範囲は前の
// 持ち主へ戻れるので、同じ親が同じグループを何度も渡す。渡した記録 (__moved) と piece は、その移動の move-start の epoch を持ち、親の ack
// (src/shard/kernel.ts の ack) は、いまの渡しと同じ epoch の piece の ack だけを数える (`known.epoch !== p.epoch`)。
// この守りを外すと、前の移動の ack が、いまの移動の、まだ子に届いていない渡しを済んだものにし、親は行を消す。子は、そのグループを
// 引き取り直さない (親の listGroups が、ack 済みのグループを挙げない)。段 4 の作業では、この守りを外しても、どの試験も落ちなかった。
//
// 台本: 1 シャード (s0) の全部の範囲を、s0 から s1、s1 から s0、s0 から s1 へ動かす。3 つ目の移動で、s1 の最初の pull の応答を止める
// (s0 は、40 個のグループを渡した記録を持ち、ack を待つ)。そこへ、1 つ目の移動の ack (網の記録にある要求) が、もう一度 s0 に届く。
// 重複した ack は、網の再送でも、drain が ack を送り直すのでも起きる。s1 を再起動して、止めた応答を捨てさせる。s1 は、起動のときに予約した
// alarm で、移動を続きから進める。
import { describe, expect, it } from "vitest";
import { split } from "../src/autoscaler";
import { Db } from "../src/client/db";
import { readEpochs } from "../src/meta";
import { REGION_TOKENS } from "../src/routing";
import type { Piece } from "../src/types";
import { SimCluster } from "./sim";

const whole = { start: 0, end: REGION_TOKENS };
const ids = Array.from({ length: 40 }, (_, i) => i + 1);
const outcome = (p: Promise<unknown>) => p.then(() => "ok", (e: Error) => e.message);

describe("a late ack of an earlier move", () => {
  it("does not complete the hand-over of a group that the range brought back, before the child received it", async () => {
    const c = new SimCluster({ shards: 1 });
    await new Db(c).ddl("CREATE TABLE items(id INTEGER PRIMARY KEY, n INTEGER NOT NULL)");
    await new Db(c).query(`INSERT INTO items(id, n) VALUES ${ids.map((i) => `(${i}, ${i})`).join(", ")}`);
    const moveEpoch = (from: string, to: string) => readEpochs(c.metaBackend).findLast((x) => x.rec.kind === "move-start" && x.rec.from === from && x.rec.to === to)!.epoch;

    // 移動 1 と 2。移動 1 の、s1 から s0 への ack を取っておく。
    expect(await outcome(split(c, "s0", "s1", { range: whole }))).toBe("ok");
    const first = moveEpoch("s0", "s1");
    const late = c.net.log.find((m) => m.method === "ack" && m.from === "s1" && m.to === "s0" && (m.req as { pieces: Piece[] }).pieces[0]?.epoch === first);
    expect(late).toBeDefined();
    expect(await outcome(split(c, "s1", "s0", { range: whole }))).toBe("ok");

    // 移動 3。s1 の最初の pull の応答を止める。
    let release!: () => void;
    const held = new Promise<void>((r) => (release = r));
    let pulled!: () => void;
    const reached = new Promise<void>((r) => (pulled = r));
    let once = false;
    c.net.reply = (m) => {
      if (once || m.method !== "pull" || m.from !== "s1") return undefined;
      once = true;
      pulled();
      return held;
    };
    const third = outcome(split(c, "s0", "s1", { range: whole }));
    await reached;
    const handing = c.backends.get("s0")!.exec(`SELECT count(*) AS n FROM __moved WHERE epoch = ? AND acked = 0`, moveEpoch("s0", "s1"));
    expect(handing).toEqual([{ n: ids.length }]);

    // 移動 1 の ack が、もう一度 s0 に届く。s1 を再起動し、止めた pull の応答を捨てさせる。
    await c.shard("s0").ack(late!.req as { pieces: Piece[] });
    c.restart("s1");
    c.net.reply = () => undefined;
    release();
    expect(await third).not.toBe("ok");

    // s1 の alarm (5 秒ごと) が、移動を続きから進める。進める側は再開しない。
    for (let waited = 0; waited < 60_000 && (await c.moves()).length > 0; waited += 500) await c.sleep(500);
    await c.settle();
    expect(await c.moves()).toEqual([]);
    const db = new Db(c, { retries: 5 });
    const byKey = await Promise.all(ids.map((id) => db.query("SELECT n FROM items WHERE id = ?", [id]).then((r) => (r.rows[0] as { n: number } | undefined)?.n ?? null)));
    const wide = (await db.query("SELECT count(*) AS c, sum(n) AS s FROM items")).rows;
    expect({ missing: ids.filter((_id, i) => byKey[i] !== ids[i]), wide }).toEqual({ missing: [], wide: [{ c: ids.length, s: ids.reduce((a, b) => a + b, 0) }] });
  });
});
