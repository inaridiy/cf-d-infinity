// 範囲が前の持ち主へ戻る (s0 から s1、s1 から s0、s0 から s1)。どの移動の後も、全部の行が読めて書ける。受け取ったシャードは、受け取りごとに
// 記録を残し、2 度目の受け取りが 1 度目の記録を書き換えない (docs/design-refresh-across-move.md の「受け取りの記録を残す期間」と
// 「実装がすること」の 5、specs/m23b_refresh_two_moves.qnt の M23b が段 4 に求めること)。
//
// 段 4 より前のコードでは、前の持ち主は、送り出した範囲の要求を、移動を終えた後も `__fenced` の終わった行で断り続ける。戻した範囲には
// 誰も答えず、3 つ目の移動は、親の fence が「もう s1 へ移した」と断る。
// 段 4 で所有をスナップショットで引くようにすると、戻った範囲に答えられる。そこで、受け取りの記録が受け取りごとでないと、次の 2 つが
// 表に出る。
//   - `finishIncoming` の 2 つ目の UPDATE が、同じ区間の、前の受け取りの終わった行の m を、いまの受け取りの m に書き換える。
//   - `__arrived` が、同じグループの 2 度目の受け取りを `INSERT OR IGNORE` で捨て、`receiveStep` は 2 度目の行を入れない
//     (`this.arrived.has`)。行が消える。
// 送り出した側の記録 (`__moved`) も同じで、同じグループを 2 度渡すと、2 度目を列挙しない (ack 済みの印が残る)。
import { describe, expect, it } from "vitest";
import { split } from "../src/autoscaler";
import { Db } from "../src/client/db";
import { keyString } from "../src/keys";
import { ownerOf, REGION_TOKENS, regionsOf } from "../src/routing";
import { SimCluster } from "./sim";

const outcome = (p: Promise<unknown>) => p.then(() => "ok", (e: Error) => e.message);
const whole = { start: 0, end: REGION_TOKENS };
const ids = Array.from({ length: 40 }, (_, i) => i + 1);

async function seeded() {
  const c = new SimCluster({ shards: 1 });
  await new Db(c).ddl("CREATE TABLE items(id INTEGER PRIMARY KEY, n INTEGER NOT NULL)");
  await new Db(c).query(`INSERT INTO items(id, n) VALUES ${ids.map((i) => `(${i}, ${i})`).join(", ")}`);
  return c;
}

/** 全部の行を、主キーの読みと全表の読みで確かめ、1 行を書き換える。 */
async function census(c: SimCluster, bump: number) {
  const db = new Db(c, { retries: 5 });
  const byKey = await Promise.all(ids.map((id) => db.query("SELECT n FROM items WHERE id = ?", [id]).then((r) => (r.rows[0] as { n: number } | undefined)?.n ?? null, (e: Error) => e.message)));
  const wide = await db.query("SELECT count(*) AS c, sum(n) AS s FROM items").then((r) => r.rows, (e: Error) => e.message);
  const write = await outcome(db.query("UPDATE items SET n = n + ? WHERE id = 1", [bump]));
  return { missing: byKey.filter((n) => typeof n !== "number").length, wide, write };
}

describe("a range that returns to a former owner", () => {
  it("keeps every row readable and writable after each move", async () => {
    const c = await seeded();
    const moves: [string, string][] = [["s0", "s1"], ["s1", "s0"], ["s0", "s1"]];
    const out: unknown[] = [];
    // 移動のたびに、1 行に移動の番号を足す。
    for (const [i, [from, to]] of moves.entries()) {
      const moved = await outcome(split(c, from, to, { range: whole }));
      out.push({ from, to, moved, ...(await census(c, i + 1)) });
    }
    const s = ids.reduce((a, b) => a + b, 0);
    expect(out).toEqual([
      { from: "s0", to: "s1", moved: "ok", missing: 0, wide: [{ c: 40, s }], write: "ok" },
      { from: "s1", to: "s0", moved: "ok", missing: 0, wide: [{ c: 40, s: s + 1 }], write: "ok" },
      { from: "s0", to: "s1", moved: "ok", missing: 0, wide: [{ c: 40, s: s + 3 }], write: "ok" },
    ]);
  });

  it("keeps one receive record per receive: the second receive of a range does not rewrite the first", async () => {
    const c = await seeded();
    for (const [from, to] of [["s0", "s1"], ["s1", "s0"], ["s0", "s1"]] as const) expect(await outcome(split(c, from, to, { range: whole }))).toBe("ok");
    const db = c.backends.get("s1")!.db;
    // s1 は、同じ区間を s0 から 2 度受け取った。受け取りごとに 1 行あり、m は受け取ったときの m のままである (2 つの m は違う)。
    const incoming = db.prepare(`SELECT lo, hi, from_id, done, m FROM __incoming ORDER BY rowid`).all() as { from_id: string; done: number; m: number }[];
    expect(incoming.map((r) => [r.from_id, r.done])).toEqual([["s0", 1], ["s0", 1]]);
    expect(new Set(incoming.map((r) => r.m)).size).toBe(2);
    expect(incoming[0]!.m).toBeLessThan(incoming[1]!.m);
    // 到着の記録も受け取りごとにある。どのグループも、s1 に 2 度着いた。
    const arrived = db.prepare(`SELECT g, count(*) AS n FROM __arrived GROUP BY g`).all() as { g: string; n: number }[];
    expect(arrived.length).toBe(ids.length);
    expect(arrived.filter((r) => r.n !== 2)).toEqual([]);
  });
});

// 送り出した側の記録 (__moved、__moved_txn) も移動ごとである。2 シャードで、s0 の全部の範囲を s2 へ動かし、戻す。s1 は動かない (2 相の
// 確定の相手である)。
describe("a range that returns to a former owner, seen from the side that handed it over", () => {
  async function two() {
    const c = new SimCluster({ shards: 2 });
    await new Db(c).ddl("CREATE TABLE items(id INTEGER PRIMARY KEY, n INTEGER NOT NULL)");
    const { routing } = await c.catalog();
    const [r0] = regionsOf(routing, "s0");
    const on = (shard: string, skip = 0) => {
      for (let i = 1; ; i++) if (ownerOf(routing, keyString([BigInt(i)])) === shard && skip-- === 0) return i;
    };
    const [x, z, y, w] = [on("s0"), on("s0", 1), on("s1"), on("s1", 1)];
    await new Db(c).query("INSERT INTO items VALUES (?, 1), (?, 1), (?, 1), (?, 1)", [x, z, y, w]);
    return { c, range: r0!, x, z, y, w };
  }
  const read = async (c: SimCluster, id: number) => (await new Db(c).query("SELECT n FROM items WHERE id = ?", [id])).rows;

  for (const restart of [false, true]) {
    it(`applies a transaction's write to a group that came back empty${restart ? ", after the shard restarted" : ""}`, async () => {
      const { c, range, x, y } = await two();
      expect(await outcome(split(c, "s0", "s2", { range }))).toBe("ok");
      // x のグループは、s2 で空になる。範囲が s0 へ戻るとき、行のないグループは運ばれない。s0 の、x を渡した印は、範囲を受け取り直したときに
      // 外れる (再起動の後は、起動のときに外れる)。外れないと、s0 は x の新しい intent を、渡したグループのものとして適用しない。
      await new Db(c).query("DELETE FROM items WHERE id = ?", [x]);
      expect(await outcome(split(c, "s2", "s0", { range }))).toBe("ok");
      if (restart) c.restart("s0");
      // 2 シャードの取引 (x は s0、y は s1) で、x を入れ直す。
      const tx = await new Db(c).begin();
      await tx.query("INSERT INTO items VALUES (?, 7)", [x]);
      await tx.query("UPDATE items SET n = 8 WHERE id = ?", [y]);
      await tx.commit();
      await c.settle();
      expect({ x: await read(c, x), y: await read(c, y) }).toEqual({ x: [{ n: 7 }], y: [{ n: 8 }] });
    });
  }

  it("applies a committed write whose phase 2 arrives after its intent went away and came back with the range", async () => {
    const { c, range, z, y, w } = await two();
    // 2 シャードの取引 (z は s0、y は s1) が確定を返し、s0 への phase 2 (finalize) は、まだ届いていない。s1 の行 w も読み、s1 を anchor に
    // する (anchor は、書かずに読んだ範囲の多い参加者である。anchor の phase 2 は RPC を通らないので、止められない)。
    let release!: () => void;
    const held = new Promise<void>((r) => (release = r));
    c.net.gate = (m) => (m.method === "finalize" ? held : undefined);
    const tx = await new Db(c).begin();
    await tx.query("SELECT n FROM items WHERE id = ?", [w]);
    await tx.query("UPDATE items SET n = 5 WHERE id = ?", [z]);
    await tx.query("UPDATE items SET n = 5 WHERE id = ?", [y]);
    await tx.commit();
    expect(c.backends.get("s0")!.exec("SELECT count(*) AS n FROM __intents")).toEqual([{ n: 1 }]);
    // z の intent は、範囲と一緒に s2 へ行き、s0 へ戻る。
    expect(await outcome(split(c, "s0", "s2", { range }))).toBe("ok");
    expect(await outcome(split(c, "s2", "s0", { range }))).toBe("ok");
    c.net.gate = () => undefined;
    release();
    await c.settle();
    // 決着は、いまも渡したままの移動の記録だけをたどって転送する。戻った intent は s0 が適用し、s0 と s2 は互いに転送し合わない。
    const finalizes = c.net.log.filter((m) => m.method === "finalize").length;
    expect({ z: await read(c, z), y: await read(c, y), fewFinalizes: finalizes < 10 }).toEqual({ z: [{ n: 5 }], y: [{ n: 5 }], fewFinalizes: true });
  });
});
