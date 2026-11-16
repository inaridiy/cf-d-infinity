// M21 (specs/m21_catalog_epoch.qnt) の段 4 の赤を、決まった順で再生する (docs/design-catalog-epoch.md の「モデルの赤と、欠陥のスイッチの
// 対応」、docs/model-coverage.md)。どの場面も、直したコードで正しく終わることと、欠陥のスイッチを入れると、モデルの反例と同じ不変条件が
// 破れることを確かめる。m21_red_fence_first (いまの手順そのもの) の再生は test/fenced-before-switch.test.ts にある。
//
// 場面は 1 シャード (s0) の表 items で、s0 の範囲の後ろ半分を s1 へ移す。子 s1 が自分で進める受け取りは、最初の手 (親のグループの一覧)
// で止めておく (holdDrain)。移動を開いたまま、場面の手を打つためである。
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

// 移動が開いている間に、表定義の遷移を開く (Meta が DDL_WAITS_MOVE を確かめない)。受け取り中の子は、その記録を適用できないので、
// 最新の epoch で計画した要求を、移動が終わるまで断る (servable が破れる。m15_red_no_slot の後継)。
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

  it("put back (ddlDuringMove): the prepare is recorded mid-move, and the receiving child refuses the newest plans", async () => {
    const r = await scenario({ ddlDuringMove: true });
    expect(r.ddl).toMatch(/waiting for a shard split on s0 to finish/);
    expect(r.read).toBe("conflict: schema change is waiting for a shard split on s1 to finish");
  });
});

// 表定義の遷移が開いている間に、移動を開く (Meta が MOVE_WAITS_DDL を確かめない)。遷移の終わり (ここでは期限切れの abort) が、
// 移動の途中に記録され、受け取り中の子は、それを適用できない (servable が破れる。m15_red_no_based_on の後継)。
describe("m21_red_move_during_ddl: a move does not open while a schema transition is open", () => {
  const scenario = async (faults: Faults) => {
    const { c, range, moved } = await cluster(faults);
    // DDL を進める側は、prepare を記録した直後に止まった (どのシャードも prepare を適用していない)。
    await c.prepare(CHECK, {}, (await c.catalog()).schema);
    const drain = hold(c, "listGroups");
    const splitting = outcome(split(c, "s0", "s1", { range }));
    const first = await Promise.race([splitting, drain.reached.then(() => "the child started receiving")]);
    // 遷移の期限が過ぎ、Meta が abort を記録する (次に Meta が呼ばれたとき)。
    await c.sleep(6_000);
    const got = await read(c, moved);
    drain.release();
    const resumed = first === "the child started receiving" ? await splitting : await outcome(split(c, "s0", "s1", { range }));
    await c.settle();
    return { first, read: got, resumed, after: await read(c, moved) };
  };

  it("waits for the transition: the split is refused until the lease lapses, and the moved row stays readable", async () => {
    const { moved } = await cluster({});
    expect(await scenario({})).toEqual({
      first: "split busy: schema busy: ALTER TABLE items ADD COLUMN extra INTEGER CHECK (extra IS NULL OR extra > 0) is in progress",
      read: [{ n: moved }], resumed: "ok", after: [{ n: moved }],
    });
  });

  it("put back (moveDuringDdl): the move opens mid-transition, its abort lands mid-move, and the receiving child refuses the newest plans", async () => {
    const { moved } = await cluster({});
    expect(await scenario({ moveDuringDdl: true })).toEqual({
      first: "the child started receiving", read: "conflict: schema change is waiting for a shard split on s1 to finish", resumed: "ok", after: [{ n: moved }],
    });
  });
});

// 子が受け取り終える前に、move-end を記録させる (子が END_AFTER_DRAIN を守らない)。その直後に開いた表定義の遷移を、受け取り中の子が
// 適用できない (servable が破れる。m15_red_early_release の後継)。
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

  it("put back (endBeforeDrained): the move closes while the child receives, a DDL opens, and the child refuses the newest plans", async () => {
    const { moved } = await cluster({});
    const r = await scenario({ endBeforeDrained: true });
    expect({ ...r, ddl: r.ddl.replace(/ on s\d /, " on ? ") }).toEqual({
      open: 0, receiving: 1, ddl: "conflict: schema change is waiting for a shard split on ? to finish",
      read: "conflict: schema change is waiting for a shard split on s1 to finish", after: [{ n: moved }],
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
