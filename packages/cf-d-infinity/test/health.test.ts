// 保存形式の版と、健全性の判定。
import { describe, expect, it } from "vitest";
import { healthProblems } from "../src/autoscaler";
import { Db } from "../src/client/db";
import { spanFaults } from "../src/client/spans";
import { MetaCore } from "../src/meta";
import { STORAGE_FORMAT, type ShardHealth } from "../src/types";
import { quiescentProblems } from "./invariants";
import { SimCluster, SqliteBackend, USERS } from "./sim";

describe("the storage format version", () => {
  it("is stamped on a shard and on the schema object, and survives a restart", async () => {
    const c = new SimCluster({ shards: 1 });
    await c.client().ddl(USERS);
    await new Db(c).query("INSERT INTO users(tenant_id,id,n) VALUES (1,1,0)");
    const b = c.backends.get("s0")!;
    expect(b.exec(`SELECT v FROM __meta WHERE k = 'format'`)).toEqual([{ v: STORAGE_FORMAT }]);
    c.restart("s0");
    expect((await new Db(c).query("SELECT n FROM users WHERE tenant_id = 1")).rows).toEqual([{ n: 0 }]);
    const meta = new SqliteBackend();
    new MetaCore(meta);
    expect(meta.exec(`SELECT v FROM __meta WHERE k = 'format'`)).toEqual([{ v: STORAGE_FORMAT }]);
  });

  it("makes older code refuse to open data written by newer code, instead of rewriting it", async () => {
    const c = new SimCluster({ shards: 1 });
    await c.client().ddl(USERS);
    await new Db(c).query("INSERT INTO users(tenant_id,id,n) VALUES (1,1,0)");
    const b = c.backends.get("s0")!;
    b.exec(`UPDATE __meta SET v = ? WHERE k = 'format'`, STORAGE_FORMAT + 1);
    expect(() => c.restart("s0")).toThrow(/storage format too new: this shard was written by a newer cf-d-infinity \(format 2\)/);
    // 断った後も、印は新しいままである。古いコードが書き戻していない。(再起動で元の接続は使えなくなるので、SQLite を直接読む。)
    expect(b.db.prepare(`SELECT v FROM __meta WHERE k = 'format'`).all().map((r) => ({ ...r }))).toEqual([{ v: STORAGE_FORMAT + 1 }]);

    const meta = new SqliteBackend();
    new MetaCore(meta);
    meta.exec(`UPDATE __meta SET v = 99 WHERE k = 'format'`);
    expect(() => new MetaCore(meta)).toThrow(/storage format too new: this schema object/);
  });

  it("is added to data written before the version existed", () => {
    const b = new SqliteBackend();
    b.exec(`CREATE TABLE __meta(k TEXT PRIMARY KEY, v)`);
    b.exec(`INSERT INTO __meta VALUES ('epoch', 3)`);
    const c = new SimCluster({ shards: 1 });
    void c;
    new MetaCore(b);
    expect(b.exec(`SELECT v FROM __meta WHERE k = 'format'`)).toEqual([{ v: STORAGE_FORMAT }]);
  });
});

describe("shard health", () => {
  const healthy = (id: string, o: Partial<ShardHealth> = {}): ShardHealth => ({
    id, schema: 3, format: 1, bytes: 1000, intents: 0, oldestIntentMs: 0, unapplied: 0, redriveErrors: [], incoming: 0, outgoing: 0, logGenerations: 1, ...o,
  });

  it("reports nothing for a healthy cluster, including one with a transaction in flight", () => {
    expect(healthProblems([healthy("a"), healthy("b", { intents: 2, oldestIntentMs: 40 })])).toEqual([]);
  });

  it("names a committed transaction that cannot be applied, a write that has waited too long, and mixed formats", () => {
    const problems = healthProblems([
      healthy("a", { unapplied: 1, redriveErrors: ["UNIQUE constraint failed: p.code"] }),
      healthy("b", { intents: 3, oldestIntentMs: 45_000 }),
      healthy("c", { redriveErrors: ["group too large to move"] }),
      healthy("d", { format: 2 }),
    ]);
    expect(problems).toEqual([
      "a: 1 committed transaction(s) cannot be applied: UNIQUE constraint failed: p.code",
      "b: 3 write(s) have waited 45 s for their transaction's outcome",
      "c: background work keeps failing: group too large to move",
      "shards run different storage formats: 1, 2 (a deploy is still rolling out, or was rolled back)",
    ]);
  });

  it("a real shard reports a stuck transaction through its health", async () => {
    // 欠陥スイッチで「確定したのに適用できない取引」を作り、健全性の報告に現れることを確かめる。
    spanFaults.rowSpanDespiteUnique = true;
    const c = new SimCluster({ shards: 2, faults: { autoIgnoresUniqueIntents: true }, noSpanCheck: true });
    const db = c.client();
    await db.ddl(`CREATE TABLE p(tenant_id INTEGER NOT NULL, id INTEGER NOT NULL, code TEXT, PRIMARY KEY (tenant_id, id)) SHARD KEY (tenant_id)`);
    await db.ddl(`CREATE UNIQUE INDEX p_code ON p(tenant_id, code)`);
    let release!: () => void;
    const held = new Promise<void>((r) => (release = r));
    c.net.gate = (m) => (m.method === "finalize" ? held : undefined);
    const w = await db.begin();
    for (const t of [1, 2, 3, 4, 5, 6]) await w.query("INSERT INTO p VALUES (?, 5, 'x')", [t]);
    await w.commit();
    for (const t of [1, 2, 3, 4, 5, 6]) await new Db(c, { retries: 0 }).query("INSERT INTO p VALUES (?, 6, 'x')", [t]).catch(() => undefined);
    spanFaults.rowSpanDespiteUnique = false;
    c.net.gate = () => undefined;
    release();
    expect((await quiescentProblems(c)).length).toBeGreaterThan(0);
    const health = await Promise.all(["s0", "s1"].map((id) => c.shard(id).health({})));
    expect(healthProblems(health).some((p) => /cannot be applied: .*UNIQUE|background work keeps failing: .*UNIQUE/.test(p))).toBe(true);
  });
});
