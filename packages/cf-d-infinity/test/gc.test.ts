// 変更ログの世代と GC。保持窓で記憶が頭打ちになり、窓の外を必要とする読みは黙って間違えずに失敗する。
import { describe, expect, it } from "vitest";
import { Db } from "../src/client/db";
import { keyString } from "../src/keys";
import { ownerOf } from "../src/routing";
import type { Faults } from "../src/types";
import { logRows as rowsOf, SimCluster, type SimOptions, USERS } from "./sim";

const RETAIN = 1000;
const GEN = 200;
const setup = async (o: SimOptions = {}) => {
  const c = new SimCluster({ shards: 2, logRetainMs: RETAIN, logGenMs: GEN, ...o });
  const db = new Db(c);
  await db.ddl(USERS);
  return { c, db };
};
const count = (c: SimCluster, id: string, sql: string) =>
  Number((c.backends.get(id)!.exec(sql)[0] as { n: number }).n);
const logRows = (c: SimCluster, id: string) => rowsOf(c.backends.get(id)!).length;
const gens = (c: SimCluster, id: string) =>
  count(c, id, `SELECT count(*) n FROM sqlite_master WHERE type = 'table' AND name GLOB '__log_g*'`);
/** 指定したシャードに載る tenant を返す。 */
const tenantOn = async (c: SimCluster, shard: string) => {
  const { routing } = await c.catalog();
  for (let t = 1; ; t++) if (ownerOf(routing, keyString([t])) === shard) return t;
};
const getN = async (q: Pick<Db, "query">, t: number, id = 1) =>
  (await q.query("SELECT n FROM users WHERE tenant_id = ? AND id = ?", [t, id])).rows[0]?.n ?? null;
const outcome = (p: Promise<unknown>) => p.then(() => "committed", (e: Error) => e.message);

describe("change log retention", () => {
  it("keeps the log bounded by the retention window, across restarts", async () => {
    const { c, db } = await setup();
    await db.query("INSERT INTO users(tenant_id,id,n) VALUES (1,1,0)");
    for (let i = 0; i < 300; i++) {
      c.time += 50;
      await db.query("UPDATE users SET n = n + 1 WHERE tenant_id = 1 AND id = 1");
    }
    const owner = c.shardIds.find((id) => logRows(c, id) > 0)!;
    // 50 ms ごとに 1 commit、窓 1,000 ms と世代 1 つ分の余り。
    expect(logRows(c, owner)).toBeLessThanOrEqual((RETAIN + 2 * GEN) / 50 + 1);
    expect(gens(c, owner)).toBeLessThanOrEqual(RETAIN / GEN + 2);
    c.restart(owner);
    expect((await new Db(c).query("SELECT n FROM users WHERE tenant_id = 1 AND id = 1")).rows[0]!.n).toBe(300);
    c.time += 50;
    await new Db(c).query("UPDATE users SET n = n + 1 WHERE tenant_id = 1 AND id = 1");
    expect((await new Db(c).query("SELECT n FROM users WHERE tenant_id = 1 AND id = 1")).rows[0]!.n).toBe(301);
  });

  it("fails a snapshot read that needs a dropped generation instead of returning a newer value", async () => {
    const { c, db } = await setup();
    await db.query("INSERT INTO users(tenant_id,id,n) VALUES (1,1,0),(1,2,0)");
    const seen: unknown[] = [];
    let attempt = 0;
    await db.transaction(async (tx) => {
      attempt++;
      const a = (await tx.query("SELECT n FROM users WHERE tenant_id = 1 AND id = 1")).rows[0]!.n;
      if (attempt === 1) {
        for (let i = 0; i < 60; i++) {
          c.time += 50;
          await new Db(c).query("UPDATE users SET n = n + 1 WHERE tenant_id = 1 AND id = 2");
        }
      }
      const b = (await tx.query("SELECT n FROM users WHERE tenant_id = 1 AND id = 2")).rows[0]!.n;
      seen.push([attempt, a, b]);
    });
    // 1 回目は 0 を読むか失敗するかのどちらかで、途中の値を読んではならない。
    for (const [n, , b] of seen as [number, number, number][]) if (n === 1) expect(b).toBe(0);
    expect(seen.at(-1)).toEqual([attempt, 0, attempt === 1 ? 0 : 60]);
    expect(attempt).toBeGreaterThan(1);
  });

  it("aborts a transaction whose read is older than the window", async () => {
    const { c, db } = await setup();
    await db.query("INSERT INTO users(tenant_id,id,n) VALUES (1,1,0),(1,2,0)");
    let attempt = 0;
    await db.transaction(async (tx) => {
      attempt++;
      const n = (await tx.query("SELECT n FROM users WHERE tenant_id = 1 AND id = 1")).rows[0]!.n as number;
      if (attempt === 1) {
        for (let i = 0; i < 60; i++) {
          c.time += 50;
          await new Db(c).query("UPDATE users SET n = n + 1 WHERE tenant_id = 1 AND id = 2");
        }
      }
      await tx.query("UPDATE users SET n = ? WHERE tenant_id = 1 AND id = 2", [n + 1000]);
    });
    expect(attempt).toBeGreaterThan(1);
    expect((await db.query("SELECT n FROM users WHERE tenant_id = 1 AND id = 2")).rows[0]!.n).toBe(1000);
  });
});

// specs/m8_recent_index.qnt の m8_red_drop。変更ログの世代を DROP するときは、消した commit の最大まで logLowWater (永続) を上げる。
// 直近 write の索引はメモリにしかなく、再起動で残った世代から作り直すので、消した commit は索引にも残らない。
// モデルの反例の順で流す: キー k に c1 で commit する。c1 の世代を DROP する。再起動して索引を作り直す。c1 より前の T の書き込みを検証する。
// 実装では、取引 R が c1 より前の T で k を読み、読んだ値をもとに k を書く (書き込みは Worker に溜まる)。別の接続が k に c1 で書く。
// 同じシャードへの書き込みが続いて、c1 の世代が保持窓を出て DROP される。シャードが再起動する。R が確定を求め、シャードが検証する。
// R の文は c1 より前に実行しておく。DROP の後に T で実行すると、検証の前に、文の時点の読み (deltaAfter) が同じ low-water で断る。
describe("dropping a log generation raises the conflict window (m8_red_drop)", () => {
  const scenario = async (faults: Faults) => {
    const { c, db } = await setup({ faults });
    await db.query("INSERT INTO users(tenant_id,id,n) VALUES (1,1,0),(1,2,0)");
    const owner = c.shardIds.find((id) => logRows(c, id) > 0)!;
    const r = await db.begin();
    const n = (await getN(r, 1)) as number; // R の T はここで決まる
    await r.query("UPDATE users SET n = ? WHERE tenant_id = 1 AND id = 1", [n + 1]);
    const c1 = (await new Db(c).query("UPDATE users SET n = 100 WHERE tenant_id = 1 AND id = 1")).ts!;
    for (let i = 0; i < 60; i++) {
      c.time += 50;
      await new Db(c).query("UPDATE users SET n = n + 1 WHERE tenant_id = 1 AND id = 2");
    }
    const dropped = rowsOf(c.backends.get(owner)!).every((row) => (row.commit_ts as number) > c1);
    const low = (c.backends.get(owner)!.exec("SELECT v FROM __meta WHERE k = 'log_low_water'")[0]?.v as number | undefined) ?? 0;
    c.restart(owner);
    const out = await outcome(r.commit());
    return { T: r.T!, c1, dropped, low, out, n: await getN(new Db(c), 1) };
  };

  it("put back: without raising it, the restarted shard admits a write that never saw the dropped commit", async () => {
    const s = await scenario({ dropNoLowWater: true });
    expect(s.T).toBeLessThan(s.c1);
    expect(s.dropped).toBe(true);
    expect(s.low).toBe(0);
    expect(s.out).toBe("committed");
    // R は 0 を読んで 1 を書いた。c1 の 100 は、R の前にも後にも並ばないまま上書きされた (lost update)。
    expect(s.n).toBe(1);
  });

  it("refuses the commit because its read is older than the dropped generation", async () => {
    const s = await scenario({});
    expect(s.T).toBeLessThan(s.c1);
    expect(s.dropped).toBe(true);
    expect(s.low).toBeGreaterThanOrEqual(s.c1);
    expect(s.out).toBe("conflict: T older than conflict window");
    expect(s.n).toBe(100);
  });
});

describe("transaction record retention", () => {
  it("drops decided records after the retention window and keeps recent ones", async () => {
    const { c, db } = await setup({ txnRetainMs: 2000 });
    const tenants = Array.from({ length: 8 }, (_, i) => i + 1);
    for (const t of tenants) await db.query("INSERT INTO users(tenant_id,id,n) VALUES (?,1,0)", [t]);
    await db.transaction(async (tx) => {
      for (const t of tenants) await tx.query("UPDATE users SET n = n + 1 WHERE tenant_id = ? AND id = 1", [t]);
    });
    await Promise.all(c.background);
    const total = () => c.shardIds.reduce((a, id) => a + count(c, id, `SELECT count(*) n FROM __txn`), 0);
    expect(total()).toBeGreaterThan(0);
    c.time += 500;
    for (const t of tenants) await db.query("UPDATE users SET n = n + 1 WHERE tenant_id = ? AND id = 1", [t]);
    expect(total()).toBeGreaterThan(0);
    c.time += 2000;
    for (const t of tenants) await db.query("UPDATE users SET n = n + 1 WHERE tenant_id = ? AND id = 1", [t]);
    expect(total()).toBe(0);
    for (const t of tenants) expect((await db.query("SELECT n FROM users WHERE tenant_id = ? AND id = 1", [t])).rows[0]!.n).toBe(3);
  });

  it("refuses to commit a cross-shard transaction older than half the record retention", async () => {
    // tombstone を消した後に同じ取引が確定しないための検査 (specs/m10_txn_record_gc.qnt)。
    const { c, db } = await setup({ txnRetainMs: 2000, logRetainMs: 60_000 });
    const tenants = Array.from({ length: 8 }, (_, i) => i + 1);
    for (const t of tenants) await db.query("INSERT INTO users(tenant_id,id,n) VALUES (?,1,0)", [t]);
    let attempt = 0;
    await db.transaction(async (tx) => {
      attempt++;
      await tx.query("SELECT n FROM users WHERE tenant_id = 1 AND id = 1");
      if (attempt === 1) c.time += 1500;
      for (const t of tenants) await tx.query("UPDATE users SET n = n + 1 WHERE tenant_id = ? AND id = 1", [t]);
    });
    expect(attempt).toBe(2);
    for (const t of tenants) expect((await db.query("SELECT n FROM users WHERE tenant_id = ? AND id = 1", [t])).rows[0]!.n).toBe(1);
  });
});

// specs/m10_txn_record_gc.qnt の m10_red_gc_undone。anchor が消してよいのは、全参加者へ決着を届け終えた (done = 1) 記録だけである。
// モデルの反例の順で流す: 取引 x の COMMIT が anchor に届き、参加者に intent が置かれる。anchor が committed と決める。
// 参加者への phase 2 は届かない。保持時間 R が過ぎて、anchor が記録を GC する。読み手が参加者の intent を見て anchor に照会する。
// 記録がなく in-flight でもないので、anchor は tombstone を書き、読み手は intent を捨てる。確定した x の書き込みが、参加者でだけ失われる。
// 実装の anchor は参加者でもあり、自分の分は phase 2 の最初に RPC を通らずに適用する。
describe("the anchor keeps a committed record until every participant applied it (m10_red_gc_undone)", () => {
  const scenario = async (faults: Faults) => {
    const { c, db } = await setup({ txnRetainMs: 2000, logRetainMs: 60_000, faults });
    const tenant = { s0: await tenantOn(c, "s0"), s1: await tenantOn(c, "s1") } as Record<string, number>;
    for (const t of Object.values(tenant)) await db.query("INSERT INTO users(tenant_id,id,n) VALUES (?,1,0)", [t]);
    c.net.drop = (m) => m.method === "finalize";
    const x = await db.begin();
    for (const t of Object.values(tenant)) await x.query("UPDATE users SET n = 1 WHERE tenant_id = ? AND id = 1", [t]);
    await x.commit();
    await c.settle();
    c.net.drop = () => false;
    const commit = c.net.log.find((m) => m.method === "commit" && m.from === "client")!;
    const txn = (commit.req as { txn: string }).txn;
    const anchor = commit.to;
    const participant = anchor === "s0" ? "s1" : "s0";
    const record = () => c.backends.get(anchor)!.exec("SELECT status FROM __txn WHERE txn = ?", txn);
    const before = record();
    // 保持時間が過ぎる。anchor の次の書き込みが変更ログの新しい世代を作り、そこで GC が走る。alarm は発火させない。
    c.time += 2500;
    await db.query("INSERT INTO users(tenant_id,id,n) VALUES (?,2,0)", [tenant[anchor]!]);
    const afterGc = record();
    const pending = count(c, participant, `SELECT count(*) n FROM __intents`);
    // 読み手が参加者の行を読む。intent を見つけて anchor に照会する。
    const n = { anchor: await getN(db, tenant[anchor]!), participant: await getN(db, tenant[participant]!) };
    return { before, afterGc, pending, after: record(), n };
  };

  it("put back: collecting the undelivered record makes the participant drop a committed write", async () => {
    const s = await scenario({ gcUndone: true });
    expect(s.before).toEqual([{ status: "committed" }]);
    expect(s.afterGc).toEqual([]);
    expect(s.pending).toBe(1);
    // 照会で tombstone が書かれ、参加者は intent を捨てた。anchor には x の書き込みがある。
    expect(s.after).toEqual([{ status: "aborted" }]);
    expect(s.n).toEqual({ anchor: 1, participant: 0 });
  });

  it("keeps the record, so the participant applies the write when a reader asks", async () => {
    const s = await scenario({});
    expect(s.before).toEqual([{ status: "committed" }]);
    expect(s.afterGc).toEqual([{ status: "committed" }]);
    expect(s.pending).toBe(1);
    expect(s.after).toEqual([{ status: "committed" }]);
    expect(s.n).toEqual({ anchor: 1, participant: 1 });
  });
});

describe("orphaned intents", () => {
  it("are resolved by the participant's own alarm, without a reader", async () => {
    // 本番の黒箱検査で、anchor が再起動して決着を送り損ねた intent が読み手が来るまで残り、変更ログの GC を止めた。
    const { c, db } = await setup();
    const tenants = Array.from({ length: 8 }, (_, i) => i + 1);
    for (const t of tenants) await db.query("INSERT INTO users(tenant_id,id,n) VALUES (?,1,0)", [t]);
    c.net.drop = (m) => m.method === "finalize" && m.from !== m.to;
    await db.transaction(async (tx) => {
      for (const t of tenants) await tx.query("UPDATE users SET n = n + 1 WHERE tenant_id = ? AND id = 1", [t]);
    });
    await c.settle();
    const intents = () => c.shardIds.reduce((a, id) => a + count(c, id, `SELECT count(*) n FROM __intents`), 0);
    expect(intents()).toBeGreaterThan(0);
    c.net.drop = () => false;
    // anchor の alarm は発火させず、参加者の alarm だけで片付くことを確かめる。
    const anchors = new Set(c.shardIds.filter((id) => count(c, id, `SELECT count(*) n FROM __txn WHERE done = 0`) > 0));
    expect(anchors.size).toBe(1);
    c.time += 3000;
    for (let i = 0; i < 3 && intents() > 0; i++) {
      for (const id of anchors) c.alarms.delete(id);
      await c.fireAlarms();
    }
    expect(intents()).toBe(0);
    for (const t of tenants) {
      expect((await db.query("SELECT n FROM users WHERE tenant_id = ? AND id = 1", [t])).rows[0]!.n).toBe(1);
    }
  });
});
