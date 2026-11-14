// シャードが確定を断るときの、行ロックと、確かめの順序 (計画書の未解決の問題 28)。
//
// 見直しで、次の 2 つの不揃いが見つかった。どちらも欠陥ではないと判断し、振る舞いは変えていない。この試験は、守られている
// ことを固定する。
//
// 1. 行ロック。commitLocal と prepare は、検証で断るとき (ok: false) は、その取引の行ロックを手放す。版が古い、持ち主でない、
//    という理由で例外を投げて断るときは、手放さない。残ったロックは、Worker が確定の失敗の後で送る unlock が消す
//    (Txn.unlockAll)。Worker が消えて unlock が届かなければ、ロックの期限 (5 秒) で消える。ROLLBACK が届かない取引と同じである。
//    ロックは、消えても検証が守るので、いつ消えても安全である。
// 2. 順序。commitLocal は、持ち主を確かめてから、書き込みの大きさを確かめる。prepare は、大きさを先に確かめる。両方に当たる
//    要求は、どちらの入口でも断られ、何も書かれない。違うのは理由の文面だけである。大きさは Worker も確定の前に確かめるので
//    (Txn.assertWriteSetBudget)、シャードの大きさの確かめに届くのは、Worker を通らない要求だけである。
import { describe, expect, it } from "vitest";
import { split } from "../src/autoscaler";
import { Db } from "../src/client/db";
import { planSplit, slotOf } from "../src/routing";
import { MAX_WRITE_SET_BYTES, type PrepareReq } from "../src/types";
import { SimCluster } from "./sim";

/** 全シャードが持っている行ロックの数。 */
const locks = (c: SimCluster) => [...c.cores.values()].reduce((n, core) => n + (core as unknown as { locks: Map<string, unknown> }).locks.size, 0);
const outcome = (p: Promise<unknown>) => p.then(() => "ok", (e) => (e instanceof Error ? e.message : String(e)));

/** 取引 X が行のロックを持つ。別の接続が列を足す。新しい表定義の autocommit の書き込み W が、その行を待つ。X が COMMIT する。 */
async function refusedCommitWithWaiter(unlockArrives: boolean) {
  const c = new SimCluster({ shards: 1 });
  await new Db(c).ddl("CREATE TABLE t(id INTEGER PRIMARY KEY, n INTEGER NOT NULL)");
  await new Db(c).query("INSERT INTO t VALUES (1, 0)");
  const x = new Db(c, { retries: 0 });
  await x.query("BEGIN");
  await x.query("UPDATE t SET n = 1 WHERE id = 1");
  await c.sleep(5); // X を、後から来る書き込みより古い取引にする (同じ時刻に始まると、ID の順で W が X のロックを奪うことがある)
  await new Db(c).ddl("ALTER TABLE t ADD COLUMN extra INTEGER DEFAULT 5");
  const w = outcome(new Db(c).query("UPDATE t SET n = 2 WHERE id = 1"));
  await c.sleep(20); // W が行を待ち始める
  if (!unlockArrives) c.net.drop = (m) => m.method === "unlock"; // Worker が、確定の失敗の後で消えた
  const t0 = c.runtime.now();
  const commit = await outcome(x.query("COMMIT"));
  const held = locks(c);
  const write = await w;
  const waited = c.runtime.now() - t0;
  await c.settle();
  const row = (await new Db(c).query("SELECT n FROM t WHERE id = 1")).rows[0];
  return { commit, held, write, waited, row, locks: locks(c) };
}

describe("a commit that the shard refuses by throwing (stale schema, not the owner)", () => {
  it("keeps no row lock past the client's unlock: a writer behind the refused transaction goes on at once", async () => {
    const r = await refusedCommitWithWaiter(true);
    expect(r.commit).toMatch(/stale schema/);
    // Worker が、断られた取引のロックを手放した。待っていた書き込みは、ロックの期限 (5 秒) を待たずに通る。
    expect({ held: r.held, write: r.write, row: r.row, locks: r.locks }).toEqual({ held: 0, write: "ok", row: { n: 2 }, locks: 0 });
    expect(r.waited).toBeLessThan(1000);
  });

  it("keeps the row lock until its expiry when the client's unlock never arrives, and the writer then goes on", async () => {
    const r = await refusedCommitWithWaiter(false);
    expect(r.commit).toMatch(/stale schema/);
    // シャードは、例外で断った確定のロックを自分では手放さない。期限で消える。
    expect(r.held).toBe(1);
    expect({ write: r.write, row: r.row }).toEqual({ write: "ok", row: { n: 2 } });
    expect(r.waited).toBeGreaterThan(1000);
    expect(r.waited).toBeLessThan(6000);
  });
});

describe("a write set that is too large, sent to a shard that gave the range away", () => {
  it("is refused by commitLocal and by prepare, on the old owner and on the new one, and nothing is written", async () => {
    const c = new SimCluster({ shards: 1 });
    await new Db(c).ddl("CREATE TABLE docs(id INTEGER PRIMARY KEY, body TEXT)");
    const range = planSplit((await c.catalog()).routing, "s0")!;
    let moving = 1;
    while (!(slotOf(JSON.stringify([moving])) >= range.start && slotOf(JSON.stringify([moving])) < range.end)) moving++;
    await new Db(c).query("INSERT INTO docs VALUES (?, 'a')", [moving]);
    expect(await split(c, "s0", "s1", { range })).toMatchObject({ rows: 1 });
    const { version } = await c.catalog();
    const key = JSON.stringify([moving]);
    const big = "x".repeat(MAX_WRITE_SET_BYTES + 1000);
    const request = async (shard: string, txn: string): Promise<PrepareReq> => ({
      txn, T: await c.shard(shard).now({}), schema: version, anchor: shard, spans: [],
      writes: [{ table: "docs", pk: key, sk: key, before: { id: moving, body: "a" }, after: { id: moving, body: big } }],
    });
    const local = (shard: string, txn: string) => request(shard, txn).then((req) => outcome(c.shard(shard).commitLocal(req)));
    const prepare = (shard: string, txn: string) =>
      request(shard, txn).then((req) => c.shard(shard).prepare(req)).then((r) => (r.ok ? "prepared" : r.reason), (e: Error) => e.message);

    // 渡した側。commitLocal は持ち主を先に確かめ、prepare は大きさを先に確かめる。どちらも断る。
    expect(await local("s0", "x1")).toMatch(/^not owner: s1/);
    expect(await prepare("s0", "x2")).toMatch(/transaction too large/);
    // 受け取った側。持ち主なので、大きさで断る。
    expect(await local("s1", "x3")).toMatch(/transaction too large/);
    expect(await prepare("s1", "x4")).toMatch(/transaction too large/);

    // 何も書かれていない。intent も残っていない。
    const intents = [...c.backends.values()].reduce((n, b) => n + (b.exec(`SELECT count(*) n FROM __intents`)[0]!.n as number), 0);
    expect(intents).toBe(0);
    expect((await new Db(c).query("SELECT body FROM docs WHERE id = ?", [moving])).rows).toEqual([{ body: "a" }]);
  });
});
