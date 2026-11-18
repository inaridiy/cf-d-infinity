// 分割で移った範囲のうち、親が fence の前に空にしたグループを、古い読みの時刻 T で読んでも、子は「行なし」と答えない (範囲の床)。
//
// 取引が T を取る。別の取引が、移る範囲のグループ (shard key の値) の行を、T より後に、親で全部消す。その後で分割が終わる。
// 取引がそのグループを T で子に読みに行く。T の時点では行があったので、「行なし」は、T より後の削除を見た答えである。
// 読むだけの取引は、確定のときに検証を受けない (Txn.commit)。同じ行を 2 回読んで違う答えを得たまま、あるいは別の取引の変更の
// 半分だけを見たまま、確定してしまう。どちらも、どの直列な実行にも現れない (AGENTS.md の規則 5)。2026-11-14 までの欠陥である。
//
// 行のあるグループには、この穴はなかった。親が時刻 m を発行して運び、子は T < m の読みを ReadTooOld で断る (到着の記録)。
// 空になったグループは運ばれないので、子に到着の記録がない。いまは、子が、範囲の移動を終えるときに受け取った時刻 m を、範囲と
// 一緒に残す (__incoming の終えた行。範囲の床)。その範囲のキーを T < m で読む要求は、到着の記録があってもなくても、断る。
// m は、親が fence の後に発行した時刻で、親がその範囲に確定したどの書き込みよりも大きい。確かめるのは、核の持ち主の確かめ
// (src/shard/kernel.ts の assertOwned) で、読みも、確定の検証も、同じ所を通る。
//
// 古い T が子に届く経路として確かめたのは、取引が接続をまたいで続く場合である (Hrana の baton。Db.dump と Db.restore)。
// 組み立て直した取引は、T を保ったまま、新しい範囲表で送り先を決める。
//
// 計画書の不変条件 8 (範囲の移動と時刻) の、読みの側である。モデルは specs/m5b_live_migration.qnt の m5b_green_floor と、
// 赤の m5b_red_emptied (床がない。欠陥のスイッチ noRangeFloor)、m5b_red_floor_volatile (床を再起動で忘れる)、
// m5b_red_floor_no_clock (床があっても、移動を終えるときに親の時計を渡さない。スイッチ finishWithoutClock、
// test/move-timestamp.test.ts)。
//
// 見つけたのは、docs/design-subslots.md を書くためにコードを読んだときである (「drain と finishMove」の節)。
import { describe, expect, it } from "vitest";
import { split } from "../src/autoscaler";
import { Db } from "../src/client/db";
import { planSplit, slotOf } from "../src/routing";
import type { Faults } from "../src/types";
import { SimCluster } from "./sim";

/** 1 シャードのクラスタに、分割で移る範囲の行と、残る範囲の行を 1 つずつ入れる。 */
async function setup(faults?: Faults) {
  const c = new SimCluster({ shards: 1, faults });
  await new Db(c).ddl("CREATE TABLE t(id INTEGER PRIMARY KEY, n INTEGER NOT NULL)");
  const range = planSplit((await c.catalog()).routing, "s0")!;
  const inRange = (id: number) => {
    const slot = slotOf(JSON.stringify([id]));
    return slot >= range.start && slot < range.end;
  };
  let moving = 1;
  while (!inRange(moving)) moving++;
  let staying = 1;
  while (inRange(staying)) staying++;
  await new Db(c).query("INSERT INTO t VALUES (?, 1), (?, 1)", [moving, staying]);
  return { c, range, moving, staying };
}

/** 取引を次の接続で続ける (Hrana の baton)。T は変わらず、範囲表は新しくなる。 */
async function resumed(c: SimCluster, from: Db): Promise<Db> {
  const next = new Db(c);
  await next.restore(from.dump());
  return next;
}

/** 読みの答え。行か、誤りの文面。 */
const answer = (db: Db, id: number) => db.query("SELECT n FROM t WHERE id = ?", [id]).then((r) => r.rows, (e: Error) => e.message);

// 正しい答えは、T の時点の行か、やり直せる誤りである。子は T の時点の行を持っていないので、断ることになる。
const REFUSED = /^read too old: moved at \d+/;

/** 取引が行を読み、別の接続がその行を消し、範囲が s1 へ移り、取引が別の接続で同じ行を読む。between は、分割の後、読みの前にする。 */
async function readTwice(faults?: Faults, between?: (c: SimCluster) => Promise<void>) {
  const { c, range, moving } = await setup(faults);
  const first = new Db(c);
  await first.query("BEGIN");
  // 取引が行を読む。読む時刻 T が決まる。
  expect(await answer(first, moving)).toEqual([{ n: 1 }]);
  // 別の接続が、T より後に行を消す。グループは空になる。
  await new Db(c).query("DELETE FROM t WHERE id = ?", [moving]);
  // 範囲を s1 へ渡す。運ぶ行がない。
  expect(await split(c, "s0", "s1", { range })).toMatchObject({ rows: 0 });
  await between?.(c);
  const second = await resumed(c, first);
  return { c, range, moving, second, again: await answer(second, moving) };
}

describe("a transaction that reads, at its old read time, a group the parent emptied before a split moved it", () => {
  it("does not see the delete on its second read of the same row", async () => {
    expect((await readTwice()).again).toMatch(REFUSED);
  });

  it("put back (m5b_red_emptied): without the range floor, the second read of the same row says 'no rows'", async () => {
    expect((await readTwice({ noRangeFloor: true })).again).toEqual([]);
  });

  it("does not see half of another transaction", async () => {
    const { c, range, moving, staying } = await setup();
    const first = new Db(c);
    await first.query("BEGIN");
    // 取引が、残る範囲の行を読む。読む時刻 T が決まる。移る範囲の行には、まだ触れていない。
    expect(await answer(first, staying)).toEqual([{ n: 1 }]);
    // 別の取引が、T より後に、残る行を書き換え、移る行を消す。
    await new Db(c).transaction(async (tx) => {
      await tx.query("UPDATE t SET n = 2 WHERE id = ?", [staying]);
      await tx.query("DELETE FROM t WHERE id = ?", [moving]);
    });
    expect(await split(c, "s0", "s1", { range })).toMatchObject({ rows: 0 });
    const second = await resumed(c, first);
    // 残る行は、書き換えの前の値である (親が変更ログから戻す)。移る行も、削除の前でなければならない。
    expect({ staying: await answer(second, staying), moving: await answer(second, moving) })
      .toEqual({ staying: [{ n: 1 }], moving: expect.stringMatching(REFUSED) });
  });

  it("is refused after the child restarted, too (m5b_red_floor_volatile): the floor is read back from storage", async () => {
    const r = await readTwice(undefined, async (c) => c.restart("s1"));
    expect(r.again).toMatch(REFUSED);
  });

  it("is refused by a read of the whole table as well", async () => {
    const count = (db: Db) => db.query("SELECT count(*) AS n FROM t").then((r) => r.rows, (e: Error) => e.message);
    // 全表の読みは、子の受け取った範囲の全部に掛かる。子は、床より前の T では答えない。行を 1 つも運ばなかった移動では、到着の記録が
    // ないので、床がなければ子は T に関わらず答える。この形では、消した行を親が変更ログから戻すので、合計は T の時点の 2 行に合う。
    expect(await count((await readTwice()).second)).toMatch(REFUSED);
    expect(await count((await readTwice({ noRangeFloor: true })).second)).toEqual([{ n: 2 }]);
  });

  it("keeps the move time of the receive when the end of the move is reported again", async () => {
    const { c, range, moving, second } = await readTwice();
    // 範囲の中のキーを古い T で読み、断られた文面から床を読む。
    const floor = async () => Number(/moved at (\d+)/.exec(String(await answer(second, moving)))![1]);
    const m = await floor();
    // 受け取り終えた移動に、もう一度届いても、その受け取りの m は変わらない。小さい m でも大きい m でも同じで、再起動の後も同じである。
    // 段 4 より前は、大きい m なら床を上げた (同じ区間の、ほかの受け取りの行の m も書き換えた)。受け取りの記録は、受け取りごとに、
    // そのときの m を残す (docs/design-refresh-across-move.md の「実装がすること」の 5。範囲が前の持ち主へ戻ると、同じ区間を 2 度受け取る)。
    // どちらの m も、渡した側がその範囲について発行したどの時刻よりも大きいので、初めの m で足りる。
    // 受け取りは、移動の epoch で名指しする (計画書の不変条件 15)。受け取り終えた移動の epoch には、何もしない。
    const received = c.backends.get("s1")!.exec("SELECT epoch, lo, hi, done FROM __incoming");
    expect(received).toEqual([{ epoch: expect.any(Number), lo: range.start, hi: range.end, done: 1 }]);
    const epoch = received[0]!.epoch as number;
    await c.shard("s1").finishIncoming({ epoch, m: m - 1000 });
    expect(await floor()).toBe(m);
    await c.shard("s1").finishIncoming({ epoch, m: m + 7 });
    expect(await floor()).toBe(m);
    c.restart("s1");
    expect(await floor()).toBe(m);
  });

  it("still answers a read at or after the move time: the group is empty there", async () => {
    const { c, moving } = await readTwice();
    // 新しい取引は、移動の後の時刻で読む。子の持つ状態 (行なし) が、そのまま答えになる。
    expect(await answer(new Db(c), moving)).toEqual([]);
    const fresh = new Db(c);
    await fresh.query("BEGIN");
    expect(await answer(fresh, moving)).toEqual([]);
    await fresh.query("INSERT INTO t VALUES (?, 5)", [moving]);
    await fresh.query("COMMIT");
    expect(await answer(new Db(c), moving)).toEqual([{ n: 5 }]);
  });
});
