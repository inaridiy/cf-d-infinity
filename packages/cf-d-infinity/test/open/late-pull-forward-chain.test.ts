// 未解決 (2026-11-17、遅れた移動のメッセージの類の表 (test/history.ts の LateRow) の 4 と 5。遅れた移動のメッセージの類): 範囲が前へ進む鎖 (s0 から s2、s2 から s3。どちらも、親の範囲の
// 上半分を空のシャードへ渡す、本番の分割の形) で、移動 1 の遅れた pull が s0 に届くと、s0 は、移動 1 で運ばなかった (行も intent もなかった)
// グループを、終わった移動 1 の fence で s2 へ渡し直す。s2 は、移動 1 を受け取り終えているのに、その応答を到着として受け取り、そのグループの
// 「渡した」印 (移動 2 で s3 へ渡したもの) を外す。
//   4  移動 2 が閉じた後に届く。s2 は、その後でそのグループを書いた取引の phase 2 を、適用も転送もせずに受け取ったと答える。s3 に intent が残る。
//   5  移動 2 で s3 がグループを引き取り、ack が s2 に届く前に届く。ack は印のないグループを数えず、s2 は自分の行を消さない。行が s2 と s3 の
//      両方に残り、s3 の drain は、s2 が挙げ続けるグループを引き取り直して終わらない (drain does not converge)。移動 2 は閉じない。
//
// 台本: z は移動 2 の区間のグループで、移動 1 のときに行がない。s2 で z を読む文が送る on-demand の pull を止め、移動 1 を閉じる。s2 で z に
// 行を入れ、z (s2) と y (s1) を書く取引 Y を確定する (s2 への phase 2 は止める)。移動 2 を進め、止めた pull を届ける (4 は移動 2 が閉じた後、
// 5 は s3 の ack を止めている間)。その後で、Y の phase 2 を s2 へ届ける。見つけたのは 類の見直し (2026-11-17)の A1 と A2 で、遅れた pull を届けない
// 同じ台本 (A0) は通る。乱択の検査では、生成器 10 (test/move-chains.test.ts と test/move-returns.test.ts の「generator 10」を OPEN=1 で流す) が
// 「situation 4」と「situation 5」として数え、メモリの印と記録から作り直す印の比べ (test/history.ts の marksProblems) が、4 の外れた印を見つける。
//
// 不変条件 (計画書の不変条件 15): シャードは、生きた記録 (親なら終わっていない fence、子なら受け取り中の __incoming) を持つ移動の epoch を
// 名指しする要求と応答でだけ、渡しと受け取りの記録 (__moved、__moved_txn、__arrived) を変える。メモリの印 (moved、arrived) は、その記録から
// 導く。ここでは、親 s0 が終わった fence の pull で渡しの記録を足し、子 s2 が受け取り終えた移動の応答で到着の記録を足し、別の移動の印を外した。
// 持ち主は、シャードの移動の手順 (src/shard/kernel.ts の pullPieces、fetchStep、receiveStep、ack)。
import { describe, expect, it } from "vitest";
import { Db } from "../../src/client/db";
import { keyString } from "../../src/keys";
import { applyMove, ownerOf, planSplit, slotOf, type Interval } from "../../src/routing";
import { strandedIntents } from "../history";
import { SimCluster, type Rpc } from "../sim";

const latch = () => {
  let resolve!: () => void;
  const promise = new Promise<void>((r) => (resolve = r));
  return { promise, resolve };
};
const wants = (m: Rpc, g: string) => (m.req as { want: { g: string }[] }).want.some((w) => w.g === g);
const kernelOf = (c: SimCluster, id: string) =>
  (c.cores.get(id) as unknown as { k: { moved: Map<string, { to: string; acked: boolean; epoch: number }> } }).k;
const closed = async (c: SimCluster, tries = 400) => {
  for (let i = 0; i < tries && (await c.moves()).length > 0; i++) await c.sleep(50);
  return (await c.moves()).length === 0;
};

/**
 * 台本。when は、移動 1 の止めた pull を届ける時である。
 *   afterAck   移動 2 が閉じた後 (表の 4)。
 *   beforeAck  s3 が z を引き取り、その ack が s2 に届く前 (表の 5)。
 */
async function forward(when: "afterAck" | "beforeAck") {
  const c = new SimCluster({ shards: 2 });
  await new Db(c).ddl("CREATE TABLE items(id INTEGER PRIMARY KEY, n INTEGER NOT NULL)");
  const { routing } = await c.catalog();
  const r1 = planSplit(routing, "s0")!;
  const r2 = planSplit(applyMove(routing, { ...r1, to: "s2" }), "s2")!;
  const inside = (i: number, r: Interval) => {
    const t = slotOf(keyString([BigInt(i)]));
    return t >= r.start && t < r.end;
  };
  const pick = (pred: (i: number) => boolean, skip = 0) => {
    for (let i = 1; ; i++) if (pred(i) && skip-- === 0) return i;
  };
  const on = (i: number, shard: string) => ownerOf(routing, keyString([BigInt(i)])) === shard;
  const z = pick((i) => inside(i, r2));
  const [y, w] = [pick((i) => on(i, "s1")), pick((i) => on(i, "s1"), 1)];
  const kept = pick((i) => on(i, "s0") && !inside(i, r1));
  await new Db(c).query("INSERT INTO items VALUES (?, 1), (?, 1), (?, 1)", [kept, y, w]);
  const g = keyString([BigInt(z)]);

  const gates = { list: latch(), pull: latch(), p2: latch(), ack: latch() };
  const never = new Promise<void>(() => {});
  let [listed, pulled, acked, holdS3] = [false, false, false, false];
  c.net.gate = (m) => {
    if (m.from === "s2" && m.to === "s0" && m.method === "listGroups" && !listed) return (listed = true), gates.list.promise;
    if (m.from === "s2" && m.to === "s0" && m.method === "pull" && !pulled && wants(m, g)) return (pulled = true), gates.pull.promise;
    if (m.method === "finalize" && m.from === "s1" && m.to === "s2") return gates.p2.promise;
    if (when === "beforeAck" && m.from === "s3" && m.to === "s2" && m.method === "ack" && !acked) return (acked = true), gates.ack.promise;
    // 読み手のやり直しが、s3 の intent を anchor に尋ねて決着させないようにする (取り残された intent を、そのまま見る)。
    if (holdS3 && m.from === "client" && m.to === "s3" && (m.method === "exec" || m.method === "execAuto")) return never;
    return undefined;
  };

  // 移動 1 (s0 から s2)。s2 で z を読む文の on-demand の pull を止め、移動 1 を閉じる。
  await c.moveAt("s0", "s2", r1, ["s0", "s2"]);
  void new Db(c).query("SELECT n FROM items WHERE id = ?", [z]).catch(() => undefined);
  for (let i = 0; i < 100 && !pulled; i++) await c.sleep(5);
  expect(pulled).toBe(true);
  gates.list.resolve();
  expect(await closed(c)).toBe(true);

  // s2 が z を持つ。行を入れ、取引 Y (z は s2、y は s1。anchor は s1) を確定させる。s2 への phase 2 は止まる。
  await new Db(c).query("INSERT INTO items VALUES (?, 1)", [z]);
  const tx = await new Db(c).begin();
  await tx.query("SELECT n FROM items WHERE id = ?", [w]);
  await tx.query("UPDATE items SET n = 5 WHERE id = ?", [z]);
  await tx.query("UPDATE items SET n = 5 WHERE id = ?", [y]);
  expect(await tx.commit().then(() => "ok", (e: Error) => e.message)).toBe("ok");

  // 移動 2 (s2 から s3)。
  holdS3 = true;
  const { epoch: move2 } = await c.moveAt("s2", "s3", r2, ["s2", "s3"]);
  if (when === "beforeAck") {
    for (let i = 0; i < 400 && !acked; i++) await c.sleep(5);
    expect(acked).toBe(true);
    gates.pull.resolve();
    await c.sleep(200);
    gates.ack.resolve();
  } else {
    expect(await closed(c)).toBe(true);
    gates.pull.resolve();
    await c.sleep(200);
  }
  const mark = kernelOf(c, "s2").moved.get(g);
  const handedAgain = c.backends.get("s0")!.exec(`SELECT epoch FROM __moved WHERE g = ?`, g);

  // Y の phase 2 を s2 へ届ける。anchor (s1) が届け終えた印を付けるまで待つ。
  const done = () => c.backends.get("s1")!.exec("SELECT txn FROM __txn WHERE status = 'committed' AND done = 1").length;
  const base = done();
  gates.p2.resolve();
  for (let i = 0; i < 400 && done() === base; i++) await c.sleep(5);
  const moveClosed = await closed(c, 600);
  holdS3 = false;
  return {
    move2, handedAgain, delivered: done() > base, moveClosed,
    mark: mark ? { to: mark.to, epoch: mark.epoch, acked: mark.acked } : null,
    stranded: strandedIntents(c).map((s) => s.replace(/txn \S+/, "txn Y")),
    atS3: c.backends.get("s3")!.exec("SELECT n FROM items WHERE id = ?", z),
    atS2: c.backends.get("s2")!.exec("SELECT n FROM items WHERE id = ?", z),
  };
}

describe("a late pull of the first move of a forward chain, delivered after the second move closed (row 4)", () => {
  it("is not answered by handing the group again: the child keeps the mark of the second move and forwards phase 2 to the new owner", async () => {
    const r = await forward("afterAck");
    expect({ handedAgain: r.handedAgain, mark: r.mark, delivered: r.delivered, stranded: r.stranded, atS3: r.atS3 }).toEqual({
      handedAgain: [], mark: { to: "s3", epoch: r.move2, acked: true }, delivered: true, stranded: [], atS3: [{ n: 5 }],
    });
  });
});

describe("a late pull of the first move of a forward chain, delivered between the second move's pull and its ack (row 5)", () => {
  it("is not answered by handing the group again: the second move closes, and the group's rows are on the new owner only", async () => {
    const r = await forward("beforeAck");
    expect({ handedAgain: r.handedAgain, moveClosed: r.moveClosed, atS2: r.atS2, stranded: r.stranded, atS3: r.atS3 }).toEqual({
      handedAgain: [], moveClosed: true, atS2: [], stranded: [], atS3: [{ n: 5 }],
    });
  });
});
