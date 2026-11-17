// M21 (specs/m21_catalog_epoch.qnt) の段 4 の赤を、決まった順で再生する (docs/design-catalog-epoch.md の「モデルの赤と、欠陥のスイッチの
// 対応」、docs/model-coverage.md)。どの場面も、直したコードで正しく終わることと、欠陥のスイッチを入れると、モデルの反例と同じ不変条件が
// 破れることを確かめる。m21_red_fence_first (いまの手順そのもの) の再生は test/fenced-before-switch.test.ts にある。
//
// 場面は 1 シャード (s0) の表 items で、s0 の範囲の後ろ半分を s1 へ移す。子 s1 が自分で進める受け取りは、最初の手 (親のグループの一覧)
// で止めておく (holdDrain)。移動を開いたまま、場面の手を打つためである。
//
// 2026-11-17 に、表定義の epoch を commit の記録でだけ進める形にした (docs/design-catalog-epoch.md の「決めたこと 6 を改める」、M24)。
// prepare と abort は、どのものの epoch も進めないので、要求は prepare の適用を待たない。段 4 の 3 つの再生のうち、m21_red_ddl_during_move と
// m21_red_end_early は、この形では servable (最新の計画の要求に答える) を破らない (specs/m24b_m21_commit_only.qnt が緑で確かめた)。
// 2 つの再生は、欠陥のスイッチを入れても読みに答えることと、残る害 (移動の途中のシャードが prepare を適用できず、DDL が、移動の終わりを
// 待たずに失敗する) を確かめる形に改めた。m21_red_move_during_ddl は、この形でも servable を破る。遷移の commit が移動の途中に記録され、
// 受け取り中の子がそれを適用できないときである。再生は、その形に改めた。
import { describe, expect, it } from "vitest";
import { split } from "../src/autoscaler";
import { Db } from "../src/client/db";
import { planSplit, slotOf } from "../src/routing";
import type { Faults } from "../src/types";
import { outcome } from "./ddl-driver";
import { allWriteEscapes, SimCluster } from "./sim";

/** 行で失敗し得る DDL (mode trial)。M21 の CHECK の場面である。 */
const CHECK = "ALTER TABLE items ADD COLUMN extra INTEGER CHECK (extra IS NULL OR extra > 0)";

/** 場面のクラスタ。欠陥のスイッチは、表を作った後で入る (Meta とシャードは faults の object を持ち続けるので、後から書き足せば効く)。 */
async function cluster(on: Faults) {
  const faults: Faults = {};
  const c = new SimCluster({ shards: 1, faults });
  await new Db(c).ddl("CREATE TABLE items(id INTEGER PRIMARY KEY, n INTEGER NOT NULL)");
  const ids = Array.from({ length: 40 }, (_, i) => i + 1);
  await new Db(c).query(`INSERT INTO items(id, n) VALUES ${ids.map((i) => `(${i}, ${i})`).join(", ")}`);
  const range = planSplit((await c.catalog()).routing, "s0")!;
  const moved = ids.find((id) => slotOf(JSON.stringify([id])) >= range.start && slotOf(JSON.stringify([id])) < range.end)!;
  Object.assign(faults, on);
  return { c, range, moved };
}

/** 子 s1 から親 s0 への method の要求を、release まで止める。止まった時点で reached が解ける。 */
function hold(c: SimCluster, method: string): { reached: Promise<void>; release: () => void } {
  let release!: () => void;
  const held = new Promise<void>((r) => (release = r));
  let hit!: () => void;
  const reached = new Promise<void>((r) => (hit = r));
  const before = c.net.gate;
  c.net.gate = (m) => {
    if (m.from === "s1" && m.method === method) {
      hit();
      return held;
    }
    return before(m);
  };
  return { reached, release };
}

const read = (c: SimCluster, id: number) =>
  new Db(c, { retries: 2 }).query("SELECT n FROM items WHERE id = ?", [id]).then((r) => r.rows, (e: Error) => e.message);

// 移動が開いている間に、表定義の遷移を開く (Meta が DDL_WAITS_MOVE を確かめない)。移動の途中の親と子は、prepare を適用できない。
// 段 4 までは、prepare が表定義の epoch を進めたので、最新の epoch で計画した要求を、受け取り中の子が、移動が終わるまで断った
// (servable。m15_red_no_slot の後継)。commit だけが epoch を進める形では、prepare は要求を古くしないので、読みには答える。残る害は、
// 遷移が、移動の終わりまで終えられないことである。DDL は、移動を待たずに、移動の途中のシャードの拒否で失敗する (移動していない
// シャードは prepare を適用し、遷移が閉じるまで、表への書き込みを止める)。Meta の条件は、そのために残してある。
describe("m21_red_ddl_during_move: a schema transition does not open while a move is open", () => {
  const scenario = async (faults: Faults) => {
    const { c, range, moved } = await cluster(faults);
    const drain = hold(c, "listGroups");
    await c.moveAt("s0", "s1", range, ["s1"]);
    await drain.reached;
    const ddl = await outcome(new Db(c, { splitWaitMs: 300 }).ddl(CHECK));
    const got = await read(c, moved);
    drain.release();
    await c.settle();
    return { ddl, read: got, after: await outcome(new Db(c).ddl(CHECK)) };
  };

  it("waits for the move: the DDL is not recorded while the child receives, and the moved row stays readable", async () => {
    const { moved } = await cluster({});
    expect(await scenario({})).toEqual({ ddl: "a shard split of s0 is in progress; retry the schema change when it finishes", read: [{ n: moved }], after: "ok" });
  });

  it("put back (ddlDuringMove): the prepare is recorded mid-move and the moving shard cannot apply it, so the DDL fails instead of waiting; reads are still served", async () => {
    const { moved } = await cluster({});
    const r = await scenario({ ddlDuringMove: true });
    expect(r.ddl).toMatch(/^conflict: schema change is waiting for a shard split on s0 to finish/);
    // prepare は、どのものの epoch も進めない。最新の計画の読みは、受け取り中の子に届いて、答えられる (M24 の m24_m21 の緑)。
    expect(r.read).toEqual([{ n: moved }]);
  });
});

// 表定義の遷移が開いている間に、移動を開く (Meta が MOVE_WAITS_DDL を確かめない)。遷移の終わりが、移動の途中に記録され、受け取り中の
// 子は、それを適用できない (servable が破れる。m15_red_no_based_on の後継)。
// 段 4 までの再生は、遷移の終わりを、期限切れの abort にしていた。commit だけが epoch を進める形では、abort は要求を古くしないので、
// 破れない。この形でも破れるのは、commit である (M24 の「移動の途中の prepare」)。移動の前に ok と答えたシャードの分で commit が記録され、
// 受け取り中の子は、それを適用できず、その commit の後の計画の要求を、移動が終わるまで断る。
// 実装では、守りが 2 つある。Meta は、commit のときの範囲表の全シャードの ok を求めるので、移動で範囲表に入った子の ok がなければ、
// commit を記録しない (ALL_ACKS)。だから、モデルの反例は、欠陥のスイッチ commitWithoutAcks を一緒に入れたときに現れる。
describe("m21_red_move_during_ddl: a move does not open while a schema transition is open", () => {
  const scenario = async (faults: Faults) => {
    const { c, range, moved } = await cluster(faults);
    // DDL を進める側は、prepare を記録し、ただ 1 つのシャード s0 の ok を集めた (s0 は prepare を適用し、表への書き込みを止めた)。
    const p = await c.prepare(CHECK, {}, (await c.catalog()).schema);
    const acked = await c.shard("s0").prepared({ epoch: p.epoch! });
    const drain = hold(c, "listGroups");
    const splitting = outcome(split(c, "s0", "s1", { range }));
    const first = await Promise.race([splitting, drain.reached.then(() => "the child started receiving")]);
    // 進める側が、移動の前に集めた ok で、commit を記録させる。
    const commit = await outcome(c.commit(p.epoch!, ["s0"]));
    const got = await read(c, moved);
    drain.release();
    const resumed = first === "the child started receiving" ? await splitting : await outcome(split(c, "s0", "s1", { range }));
    await c.settle();
    return { acked: acked.ok, first, commit, read: got, resumed, after: await read(c, moved) };
  };

  it("waits for the transition: the split is refused while the transition is open, the commit is recorded, and the moved row stays readable", async () => {
    const { moved } = await cluster({});
    expect(await scenario({})).toEqual({
      acked: true, first: "split busy: schema busy: ALTER TABLE items ADD COLUMN extra INTEGER CHECK (extra IS NULL OR extra > 0) is in progress",
      commit: "ok", read: [{ n: moved }], resumed: "ok", after: [{ n: moved }],
    });
  });

  it("put back (moveDuringDdl): the move opens mid-transition, and Meta refuses the commit, because the child that joined the range table did not prepare", async () => {
    const { moved } = await cluster({});
    expect(await scenario({ moveDuringDdl: true })).toEqual({
      acked: true, first: "the child started receiving", commit: expect.stringMatching(/the schema change of epoch \d+ was not prepared on s1; it was not committed/),
      read: [{ n: moved }], resumed: "ok", after: [{ n: moved }],
    });
  });

  it("put back (moveDuringDdl and commitWithoutAcks): the commit lands mid-move, and the receiving child refuses the plans made after it", async () => {
    const { moved } = await cluster({});
    expect(await scenario({ moveDuringDdl: true, commitWithoutAcks: true })).toEqual({
      acked: true, first: "the child started receiving", commit: "ok",
      read: "conflict: schema change is waiting for a shard split on s1 to finish", resumed: "ok", after: [{ n: moved }],
    });
  });
});

// 子が受け取り終える前に、move-end を記録させる (子が END_AFTER_DRAIN を守らない)。その直後に開いた表定義の遷移を、受け取り中の子が
// 適用できない (m15_red_early_release の後継)。段 4 までは、prepare が表定義の epoch を進めたので、最新の計画の要求を、子が断った
// (servable)。commit だけが epoch を進める形では、読みには答える。残る害は、m21_red_ddl_during_move と同じで、移動が閉じたことに
// なっているのに、DDL が、受け取り中の子の拒否で失敗することである。
describe("m21_red_end_early: the child records move-end only after it received everything", () => {
  const scenario = async (faults: Faults) => {
    const { c, range, moved } = await cluster(faults);
    const drain = hold(c, "listGroups");
    await c.moveAt("s0", "s1", range, ["s1"]);
    await drain.reached;
    const open = (await c.moves()).length;
    const receiving = (await c.shard("s1").moves({})).incoming.length;
    const ddl = await outcome(new Db(c, { splitWaitMs: 300 }).ddl(CHECK));
    const got = await read(c, moved);
    drain.release();
    await c.settle();
    return { open, receiving, ddl, read: got, after: await read(c, moved) };
  };

  it("keeps the move open while the child receives, so the DDL waits and the moved row stays readable", async () => {
    const { moved } = await cluster({});
    expect(await scenario({})).toEqual({
      open: 1, receiving: 1, ddl: "a shard split of s0 is in progress; retry the schema change when it finishes", read: [{ n: moved }], after: [{ n: moved }],
    });
  });

  it("put back (endBeforeDrained): the move closes while the child receives, a DDL opens and fails on the child that still receives; reads are still served", async () => {
    const { moved } = await cluster({});
    const r = await scenario({ endBeforeDrained: true });
    expect({ ...r, ddl: r.ddl.replace(/ on s\d /, " on ? ") }).toEqual({
      open: 0, receiving: 1, ddl: "conflict: schema change is waiting for a shard split on ? to finish",
      // prepare は、どのものの epoch も進めない。最新の計画の読みは、受け取り中の子に届いて、答えられる。
      read: [{ n: moved }], after: [{ n: moved }],
    });
  });
});

// 移動の要求 (listGroups、pull、finishMove) が move-start の epoch を運ばない。親は、move-start を適用する前 (fence の前) に行を渡し、
// その後も、古い範囲表の書き込みを受ける。子へ渡した行には届かない (moveKeepsWrites と readConsistent が破れる)。
describe("m21_red_pull_unfenced: a parent applies the move-start before it hands rows over", () => {
  const scenario = async (faults: Faults) => {
    const { c, range, moved } = await cluster(faults);
    // 分割の前の範囲表を持ったままの接続。
    const stale = new Db(c);
    await stale.query("SELECT n FROM items WHERE id = ?", [moved]);
    // 子が行を受け取った後の ack を止める (親は、ack まで行を持つ)。
    const ack = hold(c, "ack");
    await c.moveAt("s0", "s1", range, ["s1"]);
    await ack.reached;
    const write = await outcome(stale.query("UPDATE items SET n = 1000 WHERE id = ?", [moved]));
    const got = await read(c, moved);
    ack.release();
    await c.settle();
    return { write, read: got, after: await read(c, moved) };
  };

  it("fences the parent first, so a write planned on the old range table reaches the child", async () => {
    expect(await scenario({})).toEqual({ write: "ok", read: [{ n: 1000 }], after: [{ n: 1000 }] });
  });

  it("put back (pullWithoutEpoch): the parent accepts the write after it handed the row over, and the write is lost", async () => {
    const { moved } = await cluster({});
    const from = allWriteEscapes.length;
    expect(await scenario({ pullWithoutEpoch: true })).toEqual({ write: "ok", read: [{ n: moved }], after: [{ n: moved }] });
    // シミュレータの書き込みの検査も、渡した後の行を親に残す書き込みとして見つける。見つけたことを確かめてから、試験の後の検査から外す。
    const found = allWriteEscapes.splice(from);
    expect(found.map((w) => [w.shard, w.problem.replace(/token \d+/, "token ?")])).toEqual([["s0", expect.stringMatching(/^the row would stay on s0, which does not own token \?/)]]);
  });
});
