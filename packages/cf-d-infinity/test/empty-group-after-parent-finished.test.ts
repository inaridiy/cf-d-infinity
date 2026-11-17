// 守り (2026-11-17): 親が範囲を渡し終えた (finishMove に答えた) 後、子が受け取り終える (finishIncoming) 前に、子へ届いた文が、
// 運ばれなかった (行も intent もない) グループを読むか書く。子は答える。「group not arrived」の競合で断らない。
//
// 窓は、ふつうは finishMove の応答の往復だけだが、その間に子が再起動すると、alarm が移動を進め直すまで続く。ここでは応答を止めて窓を
// 開けたままにし、やり直さない接続で読む (既定の 12 回のやり直しも、応答を 200 ms 止めると使い切る)。
// 2026-11-17 の木 (5808b08) では通る。親は、終わった fence の下でも空のグループを渡し (渡しの記録を足し、親の時計を運ぶ)、子は到着の記録を
// 付けて答える (この渡しは、計画書の不変条件 15 に反する。ただし子はまだ受け取り中で、答えは正しい)。遅れた移動のメッセージの類 (類の見直し (2026-11-17))
// の直しとして試して取り下げた変更 (親が、終わった移動の pull を MoveFinished で断り、子は断りを読み飛ばす) は、ここを断った。空のグループには
// 到着の記録がなく、子はまだ受け取り中なので、所有の確かめ (src/shard/kernel.ts の notOwned) が競合で断る。この類の直しは、ここを通したまま
// でなければならない。案は、親の断りが finishMove と同じく親の時計を運び、子がその場で受け取り終えることである (類の見直しの試作)。
// 乱択の検査では、生成器 10 (test/history.ts の LateMoves) が、この窓に届いた pull を「window」として数え、「group not arrived」の断りの数を
// 確かめる (MoveChaos.notArrivedMax)。
import { describe, expect, it } from "vitest";
import { Db } from "../src/client/db";
import { REGION_TOKENS } from "../src/routing";
import { SimCluster } from "./sim";

const whole = { start: 0, end: REGION_TOKENS };
const outcome = (p: Promise<{ rows: unknown }>) => p.then((r) => r.rows, (e: Error) => e.message);

describe("a statement for a group the parent did not carry, after the parent finished handing and before the child finished receiving", () => {
  it("is answered by the child instead of failing with conflict: group not arrived", async () => {
    const c = new SimCluster({ shards: 1 });
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
    const db = new Db(c, { retries: 0 });
    const read = await outcome(db.query("SELECT n FROM items WHERE id = 1000"));
    const write = await outcome(db.query("INSERT INTO items(id, n) VALUES (1000, 1) RETURNING n"));
    release();
    for (let i = 0; i < 400 && (await c.moves()).length > 0; i++) await c.sleep(50);
    expect({ window, read, write, open: await c.moves() }).toEqual({ window: { parent: 0, child: 1 }, read: [], write: [{ n: 1 }], open: [] });
  });
});
