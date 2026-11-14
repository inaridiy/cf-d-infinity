// 未解決: 分割で移った範囲のうち、親が fence の前に空にしたグループを、古い読みの時刻 T で読むと、子は「行なし」と答える。
//
// 取引が T を取る。別の取引が、移る範囲のグループ (shard key の値) の行を、T より後に、親で全部消す。その後で分割が終わる。
// 取引がそのグループを T で子に読みに行くと、子は行を返さない。T の時点では行があったので、取引は T より後の削除を見ている。
// 読むだけの取引は、確定のときに検証を受けない (Txn.commit)。同じ行を 2 回読んで違う答えを得たまま、あるいは別の取引の変更の
// 半分だけを見たまま、確定する。どちらも、どの直列な実行にも現れない (AGENTS.md の規則 5)。
//
// 行のあるグループには、この穴はない。親が時刻 m を発行して運び、子は T < m の読みを ReadTooOld で断る (assertOwned)。
// 空になったグループは運ばれないので、子に到着の記録がない。finishIncoming は親の時計を受け取るが (不変条件 8 の書き込みの側)、
// 受け取った範囲の記録を消すので、その範囲のキーを T < m で読む要求を見分けるものが、子に残らない。
//
// 古い T が子に届く経路として確かめたのは、取引が接続をまたいで続く場合である (Hrana の baton。Db.dump と Db.restore)。
// 組み立て直した取引は、T を保ったまま、新しい範囲表で送り先を決める。次の 2 つは、別の守りが効いて起きなかった。
//   同じ接続のままの取引: 古い範囲表で親へ送り、親が fence で断る (NotOwner)。
//   書き込みのある取引:   下の 2 つの形に書き込みを足すと、確定の検証が、親で読んだ範囲を NotOwner か「span changed after T」で断る。
// 確かめていない経路もある (分割の後に始まり、時計の遅れた別のシャードから T を取る取引)。
//
// 子が断ることもある。子に確定があり、T が子の ddl_floor (子が表定義を適用したときに、子の時計で発行した時刻) より小さいときである
// (deltaAfter)。別の目的の守りが偶然効いているだけである。子にまだ確定がなければ、deltaAfter は床を見ずに返るので、どれだけ古い
// T にも「行なし」と答える。子に確定があっても、生まれたばかりの子の時計は親より遅れていることがあり、分割の前に親が発行した T が
// ddl_floor 以上になる。下の形で、分割の後に子へ 1 行書いても答えは「行なし」のままで、T の後に時計を 5 秒進めてから分割し、
// 子へ 1 行書くと ReadTooOld になった。
//
// 計画書の不変条件 8 (範囲の移動と時刻) の、読みの側である。モデル specs/m5b_live_migration.qnt の readConsistent が、実装では
// 破れている。モデルの finishRange は、到着なしで受け持つグループを、一度も書かれていないグループに限っている (hist == initVers)。
// 行を消して空になったグループは、モデルにない。
//
// 見つけたのは、docs/design-subslots.md を書くためにコードを読んだときである (「drain と finishMove」の節)。走らせて確かめたのが
// この試験である (2026-11-14)。直し方の案は、同じ節の「範囲の床」である (finishIncoming が範囲と m を残し、その範囲を T < m で
// 読む要求を ReadTooOld で断る)。
import { describe, expect, it } from "vitest";
import { split } from "../../src/autoscaler";
import { Db } from "../../src/client/db";
import { planSplit, slotOf } from "../../src/routing";
import { SimCluster } from "../sim";

/** 1 シャードのクラスタに、分割で移る範囲の行と、残る範囲の行を 1 つずつ入れる。 */
async function setup() {
  const c = new SimCluster({ shards: 1 });
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

// 正しい答えは、T の時点の行か、やり直せる誤りである。子は T の時点の行を持っていないので、直した後は断ることになる。
const asOfT = [[{ n: 1 }], expect.stringMatching(/^(read too old|conflict|not owner):/)];

describe("a transaction that reads, at its old read time, a group the parent emptied before a split moved it", () => {
  it("does not see the delete on its second read of the same row", async () => {
    const { c, range, moving } = await setup();
    const first = new Db(c);
    await first.query("BEGIN");
    // 取引が行を読む。読む時刻 T が決まる。
    expect(await answer(first, moving)).toEqual([{ n: 1 }]);
    // 別の接続が、T より後に行を消す。グループは空になる。
    await new Db(c).query("DELETE FROM t WHERE id = ?", [moving]);
    // 範囲を s1 へ渡す。運ぶ行がない。
    expect(await split(c, "s0", "s1", { range })).toMatchObject({ rows: 0 });
    const second = await resumed(c, first);
    expect(await answer(second, moving)).toBeOneOf(asOfT);
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
      .toEqual({ staying: [{ n: 1 }], moving: expect.toBeOneOf(asOfT) });
  });
});
