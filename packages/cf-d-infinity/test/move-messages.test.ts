// 移動の要求と応答が、その移動より後に届くときの規則 (計画書の不変条件 15。docs/design-move-messages.md、モデル
// specs/m5d_move_messages.qnt) の、決まった順の試験。
//
// シャードは、自分が生きた記録を持つ移動の epoch を名指しする要求と応答でだけ、渡した記録と受け取った記録を変える。ほかの epoch には、
// 状態を変えずに答える (親は「渡し終えた」と時計を答え、子は捨てる)。メモリの印は、記録から 1 つの関数で作る。
// 類の 1 から 7 の場面は test/late-pull-*.test.ts にある (M5d の member1Test から member7Test)。ここには、M5d が見つけた 2 つの場面
// (askAgainTest と closeEarlyTest) と、条件を 1 つ外すスイッチの再生を置く。スイッチを入れた再生は、M5d の赤の run の手順をたどり、
// 規則の下の答えにならないことを確かめる (名前に「put back」を入れる。scripts/fault-table.mjs は、これを数えない)。
//
// 場面は、どれも同じ舞台で作る。シャード 2 つ (s0、s1) に表 items を置き、s0 の範囲を、まだ使っていない s2 へ動かす。モデルのシャード 0 が
// s0、1 が s2 である。z は s0 の範囲のグループ、y は s1 のグループ (取引の、もう片方の参加者) である。
import { describe, expect, it } from "vitest";
import { Db } from "../src/client/db";
import { keyString } from "../src/keys";
import { ownerOf, regionsOf, type Interval } from "../src/routing";
import type { Faults } from "../src/types";
import { SimCluster, type Rpc } from "./sim";

const latch = () => {
  let resolve!: () => void;
  const promise = new Promise<void>((r) => (resolve = r));
  return { promise, resolve };
};
const wants = (m: Rpc, g: string) => (m.req as { want: { g: string }[] }).want.some((w) => w.g === g);
const epochOf = (m: Rpc) => (m.req as { epoch?: number }).epoch;
const closed = async (c: SimCluster, tries = 400) => {
  for (let i = 0; i < tries && (await c.moves()).length > 0; i++) await c.sleep(50);
  return (await c.moves()).length === 0;
};
const outcome = (p: Promise<{ rows: unknown }>) => p.then((r) => r.rows, (e: Error) => e.message);
/** 「group not arrived」で断られた要求の数。Worker は競合をやり直すので、文の失敗ではなく、網の失敗の記録で数える。 */
const notArrived = (c: SimCluster) => c.net.failed.filter((f) => /group not arrived/.test(f.message)).length;

/** 舞台。z には行を置かない (行も intent もないグループは、移動で運ばれない)。 */
async function stage(faults: Faults = {}) {
  const c = new SimCluster({ shards: 2, faults });
  await new Db(c).ddl("CREATE TABLE items(id INTEGER PRIMARY KEY, n INTEGER NOT NULL)");
  const { routing } = await c.catalog();
  const [range] = regionsOf(routing, "s0");
  const on = (shard: string, skip = 0) => {
    for (let i = 1; ; i++) if (ownerOf(routing, keyString([BigInt(i)])) === shard && skip-- === 0) return i;
  };
  const [z, kept, y] = [on("s0"), on("s0", 1), on("s1")];
  await new Db(c).query("INSERT INTO items VALUES (?, 1), (?, 1)", [kept, y]);
  return { c, range: range as Interval, z, y, g: keyString([BigInt(z)]) };
}

// ---- 尋ね直し (M5d の m5d_green_return3 の askAgainTest と、m5d_red_ask_once の askOnceTest) ----
//
// 範囲が戻って、もう一度出る (s0 → s2 → s0 → s2)。移動 1 の間に、s2 の文が、行のないグループ z を on-demand で引き取る。要求は遅れる。
// 移動 1 が閉じ、範囲は移動 2 で s0 へ戻り、s0 が z に行を書き、移動 3 で、また s2 へ出る。s2 が移動 3 を受け取っている間に、遅れた pull が
// s0 に届く。s0 は「渡し終えた」と答え、s2 は、移動 1 を受け取り中ではないので、答えを捨てる。待っていた文は、移動 3 で尋ね直す。
// 1 回だけ尋ねて進むと (5808b08 の arriveStep)、z は移動 3 ではまだ届いていないので、文は group not arrived で断られる。断られる理由は
// 移動だけである (計画書の規則 4)。
async function askAgain(faults: Faults, joined = false, stopAtAnswer = false) {
  const { c, range, z, g } = await stage(faults);
  const gates = { list: latch(), pull: latch(), drain3: latch() };
  let [listed, pulled, third] = [false, false, false];
  c.net.gate = (m) => {
    // 移動 1: s2 の drain の最初の listGroups と、s2 の on-demand の pull (グループ z) を止める。
    if (m.from === "s2" && m.method === "listGroups" && !listed) return (listed = true), gates.list.promise;
    if (m.from === "s2" && m.method === "pull" && !pulled && wants(m, g)) return (pulled = true), gates.pull.promise;
    // 移動 3: s2 の drain を止める。z は、移動 3 では、まだ届いていない。drain は、s2 が move-start を適用したところで始まるので、
    // 移動を始める前に、止める印を立てておく。
    if (m.from === "s2" && m.method === "listGroups" && third) return gates.drain3.promise;
    return undefined;
  };
  // 移動 1 (s0 から s2)。s2 で z を書く文が、on-demand の pull を送る (止まる)。やり直さない接続で送り、断りをそのまま見る。
  await c.moveAt("s0", "s2", range, ["s0", "s2"]);
  const waiting = outcome(new Db(c, { retries: 0 }).query("UPDATE items SET n = 9 WHERE id = ? RETURNING n", [z]));
  for (let i = 0; i < 100 && !pulled; i++) await c.sleep(5);
  expect(pulled).toBe(true);
  gates.list.resolve();
  expect(await closed(c)).toBe(true);
  // 移動 2 (s2 から s0)。範囲が s0 へ戻る。s0 が、z に行を書く。
  await c.moveAt("s2", "s0", range, ["s2", "s0"]);
  expect(await closed(c)).toBe(true);
  await new Db(c).query("INSERT INTO items VALUES (?, 7)", [z]);
  // 移動 3 (s0 から s2)。s2 は受け取り中で、z はまだ届いていない。
  third = true;
  const move3 = (await c.moveAt("s0", "s2", range, ["s0", "s2"])).epoch;
  for (let i = 0; i < 100 && (await c.shard("s2").moves({})).incoming.length === 0; i++) await c.sleep(5);
  // joined: 移動 3 の間に、2 つ目の文が s2 に届く。z の引き取りは、移動 1 の止まった pull に合流する (殻は、引き取りをグループの名前で
  // まとめる)。この文は、移動 3 で 1 回目に尋ねたのに、答えは移動 1 のものである。
  const second = joined ? outcome(new Db(c, { retries: 0 }).query("SELECT id FROM items WHERE id = ?", [z])) : null;
  if (joined) await c.sleep(50);
  // 場面の前提: s2 は移動 3 を受け取り中で、z は移動 3 では届いておらず、s2 は移動 3 の pull をまだ送っていない。
  const pullsOfMove3 = () => c.net.log.filter((m) => m.from === "s2" && m.method === "pull" && epochOf(m) === move3 && wants(m, g)).length;
  const before = {
    receiving: (await c.shard("s2").moves({})).incoming,
    arrived: c.backends.get("s2")!.exec(`SELECT epoch FROM __arrived WHERE g = ?`, g),
    pulls: pullsOfMove3(),
  };
  // 移動 1 の遅れた pull を届ける。s0 は「渡し終えた」と答え、s2 は捨てる。
  gates.pull.resolve();
  const first = await waiting;
  const joinedAnswer = second ? await second : null;
  // 文が答えを受けたとき。s2 の drain は止めたままなので、移動 3 の pull は、文が尋ね直したものだけである。
  const atAnswer = {
    handed: c.backends.get("s0")!.exec(`SELECT epoch FROM __moved WHERE g = ? ORDER BY epoch`, g).map((r) => r.epoch),
    refused: notArrived(c), asked: pullsOfMove3(),
    // 移動 3 を、s2 が受け取り終えたか、s0 が渡し終えたか (記録の done)。
    move3: {
      received: c.backends.get("s2")!.exec(`SELECT done FROM __incoming WHERE epoch = ?`, move3)[0]?.done,
      handed: c.backends.get("s0")!.exec(`SELECT done FROM __fenced WHERE epoch = ?`, move3)[0]?.done,
    },
  };
  // stopAtAnswer: 移動 3 の drain を止めたまま、ここで終える (スイッチを入れた場面では、移動 3 は閉じない)。
  if (!stopAtAnswer) {
    gates.drain3.resolve();
    expect(await closed(c)).toBe(true);
    await c.settle();
  }
  return {
    before, first, joinedAnswer, refused: atAnswer.refused, askedAgain: atAnswer.asked, move3AtAnswer: atAnswer.move3,
    // s0 は、移動 1 では z を渡していない (行がなかった)。渡した記録は、あっても移動 3 のものだけである。
    handedInMove1: atAnswer.handed.some((e) => e !== move3),
    owner: c.backends.get("s2")!.exec("SELECT n FROM items WHERE id = ?", z),
    former: c.backends.get("s0")!.exec("SELECT n FROM items WHERE id = ?", z),
    range,
  };
}

describe("a statement that waited for a pull since an earlier move, answered while the shard receives a later move of the same range", () => {
  /** 遅れた pull が届く前。s2 は移動 3 を受け取り中で、z は届いておらず、移動 3 の pull はまだない。 */
  const waitingInMove3 = (r: { range: Interval }) => ({ receiving: [{ ...r.range, from: "s0" }], arrived: [], pulls: 0 });

  it("asks again in the move it now receives, and is answered (m5d_green_return3, askAgainTest)", async () => {
    const r = await askAgain({});
    expect(r.before).toEqual(waitingInMove3(r));
    expect({ first: r.first, refused: r.refused, askedAgain: r.askedAgain, handedInMove1: r.handedInMove1, owner: r.owner, former: r.former }).toEqual({
      first: [{ n: 9 }], refused: 0, askedAgain: 1, handedInMove1: false, owner: [{ n: 9 }], former: [],
    });
  });
  it("asks again when its first ask in the later move joined the pull of the earlier move", async () => {
    // 2 つ目の文は、移動 3 で 2 回尋ねる。1 回目は移動 1 の pull に合流し、その答えは捨てられる。2 つの文の尋ね直しは、1 つの pull になる。
    const r = await askAgain({}, true);
    expect(r.before).toEqual(waitingInMove3(r));
    expect({ first: r.first, second: r.joinedAnswer, refused: r.refused, askedAgain: r.askedAgain, owner: r.owner, former: r.former }).toEqual({
      first: [{ n: 9 }], second: [{ id: expect.any(Number) }], refused: 0, askedAgain: 1, owner: [{ n: 9 }], former: [],
    });
  });
  it("put back (askOnce): the statement is refused with group not arrived, for no reason but the moves (m5d_red_ask_once)", async () => {
    const r = await askAgain({ askOnce: true });
    expect(r.before).toEqual(waitingInMove3(r));
    expect({ first: r.first, refused: r.refused, askedAgain: r.askedAgain }).toEqual({
      first: expect.stringMatching(/^conflict: group not arrived/), refused: 1, askedAgain: 0,
    });
    // 行と印は壊れない (m5d_red_ask_once の m5dData は緑)。断られた文は、行を書いていない。
    expect({ owner: r.owner, former: r.former, handedInMove1: r.handedInMove1 }).toEqual({ owner: [{ n: 7 }], former: [], handedInMove1: false });
  });
});

// ---- 受け取り終える答えは、移動の epoch で引く (M5d の m5d_red_child_stale の closeEarlyTest) ----
//
// 上と同じ場面である。移動 1 の遅れた pull への「渡し終えた」の答えが、s2 が移動 3 を受け取っている間に届く。移動 1 と移動 3 は、同じ
// 区間を動かす。受け取りを区間で引くと (5808b08 の finishIncoming)、移動 1 の答えが、移動 3 の受け取りを終えてしまう。s0 は移動 3 を
// まだ渡し終えておらず、z の行は s0 に残ったままである。s2 は、届いていない z を、行のないグループとして答える。
describe("a late \"finished handing\" of an earlier move, reaching the child while it receives a later move of the same range", () => {
  it("does not finish the later receive: the child still receives move 3, and answers with the row the owner committed", async () => {
    const r = await askAgain({});
    expect({ first: r.first, move3AtAnswer: r.move3AtAnswer }).toEqual({ first: [{ n: 9 }], move3AtAnswer: { received: 0, handed: 0 } });
  });
  it("put back (finishIncomingByInterval): the answer of move 1 finishes the receive of move 3, and the child answers without the row", async () => {
    // 文は、z の行 (n = 7。s0 が確定した) を書き換えるはずだった。s2 は、行はないと答える (ownerHasTruth)。
    const r = await askAgain({ finishIncomingByInterval: true }, false, true);
    expect({ first: r.first, move3AtAnswer: r.move3AtAnswer, owner: r.owner, former: r.former }).toEqual({
      first: [], move3AtAnswer: { received: 1, handed: 0 }, owner: [], former: [{ n: 7 }],
    });
  });
});
