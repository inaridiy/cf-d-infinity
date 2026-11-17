// 分割を進める側 (Autoscaler の split) が、どの手の前で止まっても、移る範囲の行が読めて書け、移動が進める側なしで終わる
// (docs/design-catalog-epoch.md の「止まったときに誰が終えるか」と決めたこと 4。不変条件 4 と 8、計画書の未解決の問題 17)。
//
// 手は、止めずに 1 回流したときに、進める側が Meta とシャードへ送った呼び出しの列から取る (test/ddl-driver.ts の driver。
// 表定義と移動の一覧を読む呼び出しは数えない)。手の名前と数は実装で変わるので、列の番号で止める。止めた後で、
//   1. 移る行と残る行が、最新の範囲表の接続からも、分割の前の範囲表を持ったままの接続からも、読めて書ける。
//   2. 進める側を再開せずに、子が自分で移動を終える (応答の後の仕事と、子が予約した alarm だけで。シミュレータの alarm は、仮想の時計で
//      発火する)。Meta の列に開いた移動が残らず、
//      親も子も移動の途中でない。
//   3. 表定義の変更が通る。
//   4. 全部の行が、全表の読みで数えられる。
//   5. 進める側を再開しても (同じ分割をもう一度呼ぶ)、通る。移動の記録は 1 組 (move-start と move-end) だけである。
// 段 4 から、進める側の手は 2 つ (Meta の startMove と、子の drain) で、移動の残りの手 (全グループの引き取り、親の finishMove、
// finishIncoming、Meta の endMove) は子が自分で進める。そこで、子の側の手が途中で止まる場合も確かめる。受け取りの途中で子が再起動する
// (応答の後の仕事が消える)、受け取り終えた後で move-end を記録させる手が届かない、その手の前で子が再起動する、の 3 つである。どれも、
// 子が予約した alarm で移動が終わる。
//
// この試験は、段 4 より前のコードで書いた (規則 2。そのときは test/open/ に置いた)。段 4 より前のコードでは、2 は、子が受け取り始めた
// 後のどの手で止めても落ちた (子は drain しか進めず、finishMove、finishIncoming、分割の枠を返す手は Autoscaler だけが打った)。1 は、
// 親の fence の後、範囲表の切り替えの前で止めると落ちた (問題 17)。受け取りの途中で再起動した子は、alarm を予約しなかった。
import { describe, expect, it } from "vitest";
import { split } from "../src/autoscaler";
import { fold } from "../src/catalog";
import { Db } from "../src/client/db";
import { readEpochs } from "../src/meta";
import { planSplit, slotOf } from "../src/routing";
import { driver, outcome } from "./ddl-driver";
import { SimCluster } from "./sim";

/** 手に数えない、読むだけの呼び出し。 */
const FREE = ["catalog", "splits", "moves", "s0.moves", "s1.moves"];

async function seeded() {
  const c = new SimCluster({ shards: 1 });
  await new Db(c).ddl("CREATE TABLE items(id INTEGER PRIMARY KEY, n INTEGER NOT NULL)");
  const ids = Array.from({ length: 40 }, (_, i) => i + 1);
  await new Db(c).query(`INSERT INTO items(id, n) VALUES ${ids.map((i) => `(${i}, ${i})`).join(", ")}`);
  const range = planSplit((await c.catalog()).routing, "s0")!;
  const inRange = (id: number) => slotOf(JSON.stringify([id])) >= range.start && slotOf(JSON.stringify([id])) < range.end;
  // 分割の前の範囲表を持ったままの接続。
  const stale = new Db(c);
  await stale.query("SELECT n FROM items WHERE id = 1");
  return { c, range, stale, moved: ids.find(inRange)!, stays: ids.find((id) => !inRange(id))! };
}

/** 止めた後の確かめ。答えを 1 つの object にまとめる。 */
async function check(s: Awaited<ReturnType<typeof seeded>>) {
  const { c, range, stale, moved, stays } = s;
  const rw = async (db: Db, id: number, n: number) => ({
    read: await outcome(db.query("SELECT n FROM items WHERE id = ?", [id])),
    write: await outcome(db.query("UPDATE items SET n = ? WHERE id = ?", [n, id])),
  });
  const rows = {
    moved: await rw(new Db(c, { retries: 5 }), moved, 1000),
    stays: await rw(new Db(c, { retries: 5 }), stays, 2000),
    movedStale: await rw(stale, moved, 1001),
    staysStale: await rw(stale, stays, 2001),
  };
  // 進める側なしで、子が移動を終える。応答の後の仕事と、子が予約した alarm (シミュレータでは仮想の時計で 5 秒ごとに発火する) だけで
  // 進むのを、仮想の時刻で 30 秒まで待つ。試験は alarm を自分で発火させない。
  const closed = () => fold(readEpochs(c.metaBackend)).moves.length === 0;
  for (let waited = 0; waited < 30_000 && !closed(); waited += 500) await c.sleep(500);
  await c.settle();
  const open = fold(readEpochs(c.metaBackend)).moves;
  const shards = await Promise.all(["s0", "s1"].map((id) => c.shard(id).moves({})));
  const t0 = c.time;
  const ddl = await outcome(new Db(c).ddl("CREATE TABLE other(id INTEGER PRIMARY KEY)"));
  const ddlWaited = c.time - t0;
  const count = await new Db(c).query("SELECT count(*) AS n FROM items").then((r) => r.rows, (e: Error) => e.message);
  const resumed = await outcome(split(c, "s0", "s1", { range }));
  const log = readEpochs(c.metaBackend).filter((x) => x.rec.kind === "move-start" || x.rec.kind === "move-end").map((x) => x.rec.kind);
  return { rows, open, shards, ddl, ddlFast: ddlWaited < 15_000, count, resumed, log };
}

const ok = { read: "ok", write: "ok" };
const expected = {
  rows: { moved: ok, stays: ok, movedStale: ok, staysStale: ok },
  open: [],
  shards: [{ outgoing: [], incoming: [] }, { outgoing: [], incoming: [] }],
  ddl: "ok", ddlFast: true, count: [{ n: 40 }], resumed: "ok", log: ["move-start", "move-end"],
};

describe("a split whose driver stops before any of its steps", () => {
  it("finishes without the driver, and the moving range stays readable and writable", async () => {
    const dry = await seeded();
    const free = driver(dry.c, null, FREE);
    expect(await outcome(split(free.cluster, "s0", "s1", { range: dry.range }))).toBe("ok");
    const steps = free.calls;
    if (process.env.SHOW_STEPS) console.log(steps.join(" "));
    expect(steps.length).toBeGreaterThan(1);
    for (let i = 0; i <= steps.length; i++) {
      const at = { i, step: steps[i] ?? "(after the last step)" };
      const s = await seeded();
      const d = driver(s.c, i, FREE);
      const ran = await outcome(split(d.cluster, "s0", "s1", { range: s.range }));
      // 止めた手まで、止めずに流したときと同じ列である (シミュレータは決定的)。
      expect({ ...at, calls: d.calls }).toEqual({ ...at, calls: steps.slice(0, i) });
      expect({ ...at, ran: /driver stopped before/.test(ran) ? "stopped" : ran }).toEqual({ ...at, ran: i < steps.length ? "stopped" : "ok" });
      expect.soft({ ...at, ...(await check(s)) }).toEqual({ ...at, ...expected });
    }
  });

  it("finishes by the child's alarm when the child restarts while it receives the rows", async () => {
    const s = await seeded();
    const { c } = s;
    // 子が最初に親から行を引き取ろうとしたところで、子が再起動する。進める側の drain も、子の応答の後の仕事も、そこで消える。
    let restarted = false;
    c.net.gate = (m) => {
      if (restarted || m.from !== "s1" || m.method !== "pull") return undefined;
      restarted = true;
      c.restart("s1");
      return undefined;
    };
    const ran = await outcome(split(c, "s0", "s1", { range: s.range }));
    c.net.gate = () => undefined;
    expect({ restarted, ran: ran === "ok" ? "ok" : "failed" }).toEqual({ restarted: true, ran: "failed" });
    // 子は、起動のときに受け取り中の範囲を見て、alarm を予約している。
    expect(c.alarms.has("s1")).toBe(true);
    expect(await check(s)).toEqual(expected);
  });

  for (const restart of [false, true]) {
    it(`finishes by the child's alarm when move-end cannot be recorded after the child received everything${restart ? ", and the child restarts" : ""}`, async () => {
      const s = await seeded();
      const { c } = s;
      // 子が受け取り終えた後の、Meta に move-end を記録させる手が、1 度だけ届かない。restart なら、その手の前で子が再起動する。
      const real = c.meta.endMove.bind(c.meta);
      let refused = 0;
      c.meta.endMove = async (epoch: number) => {
        if (refused++ > 0) return real(epoch);
        if (restart) c.restart("s1");
        throw new Error("meta unreachable");
      };
      const ran = await outcome(split(c, "s0", "s1", { range: s.range }));
      // 再起動すると、進める側の要求は、Meta の誤りを待たずに、再起動で失敗する (シミュレータは、再起動した instance に届いていた要求を失敗させる)。
      expect({ refused, ran: restart && /^fenced instance/.test(ran) ? "fenced instance" : ran }).toEqual({ refused: 1, ran: restart ? "fenced instance" : "meta unreachable" });
      // 子は受け取り終えている。移動は Meta で開いたままで、表定義の遷移は開けない。
      expect(await Promise.all(["s0", "s1"].map((id) => c.shard(id).moves({})))).toEqual(expected.shards);
      expect((await c.moves()).length).toBe(1);
      expect(c.alarms.has("s1")).toBe(true);
      expect(await check(s)).toEqual(expected);
    });
  }
});
