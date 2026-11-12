// 変更ログの世代と GC。保持窓で記憶が頭打ちになり、窓の外を必要とする読みは黙って間違えずに失敗する。
import { describe, expect, it } from "vitest";
import { Db } from "../src/client/db";
import { logRows as rowsOf, SimCluster, USERS } from "./sim";

const RETAIN = 1000;
const GEN = 200;
const setup = async (o: { txnRetainMs?: number; logRetainMs?: number } = {}) => {
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
