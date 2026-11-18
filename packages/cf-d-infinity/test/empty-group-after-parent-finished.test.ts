// 守り (2026-11-17): 親が範囲を渡し終えた (finishMove に答えた) 後、子が受け取り終える (finishIncoming) 前に、子へ届いた文が、
// 運ばれなかった (行も intent もない) グループを読むか書く。子は答える。「group not arrived」の競合で断らない。
//
// 窓は、ふつうは finishMove の応答の往復だけだが、その間に子が再起動すると、alarm が移動を進め直すまで続く。ここでは応答を止めて窓を
// 開けたままにし、やり直さない接続で読む (既定の 12 回のやり直しも、応答を 200 ms 止めると使い切る)。
//
// いまの規則 (計画書の不変条件 15。docs/design-move-messages.md の規則 2 と 3、モデル M5d の m5d_green_return の windowTest): 親は、渡し終えた
// 移動の pull に、記録も印も変えずに「渡し終えた」と、いまの時計を答える。子は、その移動を受け取り中なので、その時計で受け取り終え、
// 行のないグループを、到着の記録なしで、範囲の床から受け持つ。「渡し終えた」は、断りではなく答えである。
// 2026-11-17 の木 (5808b08) も、ここは通った。親は、終わった fence の下でも空のグループを渡し (渡しの記録を足す)、子は到着の記録を付けて
// 答えた。その渡しは、不変条件 15 に反する。遅れた移動のメッセージの類の直しとして試して取り下げた変更 (89d99c8。親が、終わった移動の
// pull を MoveFinished で断り、子は断りを読み飛ばす) は、ここを断った。空のグループには到着の記録がなく、子はまだ受け取り中なので、所有の
// 確かめ (src/shard/kernel.ts の notOwned) が競合で断る。スイッチ finishedAsRefusal が、その形に戻す (M5d の m5d_red_finished_refusal)。
// 乱択の検査では、生成器 10 (test/history.ts の LateMoves) が、この窓に届いた pull を「window」として数え、「group not arrived」の断りの数を
// 確かめる (MoveChaos.notArrivedMax)。
import { describe, expect, it } from "vitest";
import { Db } from "../src/client/db";
import { keyString } from "../src/keys";
import { REGION_TOKENS } from "../src/routing";
import type { Faults } from "../src/types";
import { SimCluster } from "./sim";

const whole = { start: 0, end: REGION_TOKENS };
const outcome = (p: Promise<{ rows: unknown }>) => p.then((r) => r.rows, (e: Error) => e.message);

async function scene(faults: Faults = {}) {
  const c = new SimCluster({ shards: 1, faults });
  await new Db(c).ddl("CREATE TABLE items(id INTEGER PRIMARY KEY, n INTEGER NOT NULL)");
  await new Db(c).query(`INSERT INTO items(id, n) VALUES ${Array.from({ length: 40 }, (_, i) => `(${i + 1}, ${i + 1})`).join(", ")}`);
  // s1 の finishMove の応答を止める。s0 は渡し終えた印を付けたが、s1 はまだ受け取り中である。
  let release!: () => void;
  const hold = new Promise<void>((r) => (release = r));
  let held = false;
  c.net.reply = (m) => {
    if (m.from === "s1" && m.to === "s0" && m.method === "finishMove" && !held) {
      held = true;
      return hold;
    }
    return undefined;
  };
  await c.moveAt("s0", "s1", whole, ["s0", "s1"]);
  for (let i = 0; i < 400 && !held; i++) await c.sleep(5);
  expect(held).toBe(true);
  const window = { parent: (await c.shard("s0").moves({})).outgoing.length, child: (await c.shard("s1").moves({})).incoming.length };
  // id 1000 の行はない。グループは運ばれていない。
  const g = keyString([1000n]);
  const db = new Db(c, { retries: 0 });
  const read = await outcome(db.query("SELECT n FROM items WHERE id = 1000"));
  // 読みの答えの後。親は、渡した記録を足していない。子は、到着の記録なしで、受け取り終えている。
  const afterRead = {
    handed: c.backends.get("s0")!.exec(`SELECT epoch FROM __moved WHERE g = ?`, g).length,
    arrivals: c.backends.get("s1")!.exec(`SELECT epoch FROM __arrived WHERE g = ?`, g).length,
    receiving: (await c.shard("s1").moves({})).incoming.length,
  };
  const write = await outcome(db.query("INSERT INTO items(id, n) VALUES (1000, 1) RETURNING n"));
  release();
  for (let i = 0; i < 400 && (await c.moves()).length > 0; i++) await c.sleep(50);
  return { window, read, afterRead, write, open: await c.moves() };
}

describe("a statement for a group the parent did not carry, after the parent finished handing and before the child finished receiving", () => {
  it("is answered by the child instead of failing with conflict: group not arrived", async () => {
    expect(await scene()).toEqual({
      window: { parent: 0, child: 1 }, read: [], afterRead: { handed: 0, arrivals: 0, receiving: 0 }, write: [{ n: 1 }], open: [],
    });
  });
  it("put back (finishedAsRefusal): the child skips the answer, keeps receiving, and refuses the statement with group not arrived", async () => {
    // m5d_red_finished_refusal の windowTest。断られる理由は移動だけである (計画書の規則 4)。行と印は壊れず、移動は、子が finishMove の
    // 応答を受けたところで閉じる。
    const refused = expect.stringMatching(/^conflict: group not arrived/);
    expect(await scene({ finishedAsRefusal: true })).toEqual({
      window: { parent: 0, child: 1 }, read: refused, afterRead: { handed: 0, arrivals: 0, receiving: 1 }, write: refused, open: [],
    });
  });
});
