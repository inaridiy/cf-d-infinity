// 2026-11 の設計レビューで見つかった 3 件の欠陥の再現。
// 欠陥スイッチを入れると壊れ、外すと直ることを確かめる (取引 ID の件は、ID の作り方そのものを検査する)。
import { describe, expect, it, vi } from "vitest";
import { split } from "../src/autoscaler";
import { Db } from "../src/client/db";
import { ownerOf } from "../src/routing";
import type { Faults } from "../src/types";
import { quiescentProblems } from "./invariants";
import { SimCluster, USERS } from "./sim";

async function tenantOn(c: SimCluster, shard: string): Promise<number> {
  const { routing } = await c.catalog();
  for (let t = 1; ; t++) if (ownerOf(routing, JSON.stringify([t])) === shard) return t;
}

describe("a UNIQUE value held by another transaction's intent", () => {
  // 2 シャードの取引を commit した直後は、anchor でない側に intent だけが残る。
  // そこへ同じ UNIQUE の値を autocommit で INSERT できると、後から届く phase 2 が UNIQUE 違反で永久に適用できない。
  const run = async (faults: Faults) => {
    const c = new SimCluster({ shards: 2, faults });
    const db = c.client();
    await db.ddl(`CREATE TABLE p(tenant_id INTEGER NOT NULL, id INTEGER NOT NULL, code TEXT, PRIMARY KEY (tenant_id, id)) SHARD KEY (tenant_id)`);
    await db.ddl(`CREATE UNIQUE INDEX p_code ON p(tenant_id, code)`);
    const tenants = [await tenantOn(c, "s0"), await tenantOn(c, "s1")];
    let release!: () => void;
    const held = new Promise<void>((r) => (release = r));
    c.net.gate = (m) => (m.method === "finalize" ? held : undefined);
    const w = await db.begin();
    for (const t of tenants) await w.query("INSERT INTO p VALUES (?, 5, 'x')", [t]);
    await w.commit();
    const duplicate = await Promise.all(tenants.map((t) =>
      new Db(c, { retries: 0 }).query("INSERT INTO p VALUES (?, 6, 'x')", [t]).then(() => "accepted", (e: Error) => e.message)));
    c.net.gate = () => undefined;
    release();
    await c.settle();
    for (let i = 0; i < 3; i++) await c.fireAlarms();
    const committed = await Promise.all(tenants.map((t) =>
      new Db(c).query("SELECT id FROM p WHERE tenant_id = ? AND id = 5", [t]).then((r) => r.rows.length, (e: Error) => e.message)));
    return { duplicate, committed, problems: await quiescentProblems(c) };
  };

  it("is refused to an autocommit insert, so the committed transaction can always be applied", async () => {
    const r = await run({});
    expect(r.duplicate.filter((d) => d === "accepted")).toEqual([]);
    expect(r.duplicate.some((d) => /unique pending/.test(d))).toBe(true);
    expect(r.committed).toEqual([1, 1]);
    expect(r.problems).toEqual([]);
  });

  it("without the check, the committed transaction is stuck forever (the bug)", async () => {
    const r = await run({ autoIgnoresUniqueIntents: true });
    expect(r.duplicate).toContain("accepted");
    // 終了時の検査が、この欠陥を 3 通りに報告する: 残った intent、適用されない確定済みの取引、失敗し続ける再駆動。
    expect(r.problems.some((p) => /intents remain/.test(p))).toBe(true);
    expect(r.problems.some((p) => /never fully applied/.test(p))).toBe(true);
    expect(r.problems.some((p) => /redrive keeps failing: .*UNIQUE/.test(p))).toBe(true);
    expect(r.committed.some((x) => x !== 1)).toBe(true);
  });
});

describe("transaction ids", () => {
  // anchor は同じ ID の記録があればその決着を返す。ID が衝突すると、後の取引は何も書かずに「確定」と応答される。
  it("use the whole UUID: two transactions whose UUIDs share the first 8 digits both take effect", async () => {
    const c = new SimCluster({ shards: 2 });
    await c.client().ddl(USERS);
    const [A, B] = [await tenantOn(c, "s0"), await tenantOn(c, "s1")];
    for (const t of [A, B]) await new Db(c).query("INSERT INTO users(tenant_id,id,n) VALUES (?,1,0)", [t]);
    const uuids = ["deadbeef-0000-4000-8000-000000000001", "deadbeef-0000-4000-8000-000000000002"];
    const spy = vi.spyOn(crypto, "randomUUID").mockImplementation(() => uuids.shift() as ReturnType<typeof crypto.randomUUID>);
    try {
      for (const n of [1, 2]) {
        const tx = await new Db(c).begin();
        for (const t of [A, B]) await tx.query("UPDATE users SET n = ? WHERE tenant_id = ? AND id = 1", [n, t]);
        await tx.commit();
        await c.settle();
        c.time += 60_000;
      }
    } finally {
      spy.mockRestore();
    }
    expect((await new Db(c).query("SELECT n FROM users ORDER BY tenant_id")).rows.map((r) => r.n)).toEqual([2, 2]);
  });
});

describe("an autocommit read of several shards that does not include the anchor", () => {
  // 取引は commit して応答まで返ったが、phase 2 がまだ参加者に届いていない。anchor の時計は 40 ms 進んでいる。
  // 別の接続が参加者ともう 1 つのシャードを 1 文で読む。開始前に確定した書き込みなので、必ず見えなければならない。
  const stale = async (faults: Faults) => {
    let seenStale = 0;
    let tried = 0;
    for (let round = 0; round < 8; round++) {
      const drift = new Map<string, number>();
      const c = new SimCluster({ shards: 3, faults, skewMs: (id) => drift.get(id) ?? 0 });
      await c.client().ddl(USERS);
      const [A, B, C] = (await Promise.all(["s0", "s1", "s2"].map((s) => tenantOn(c, s)))) as [number, number, number];
      for (const t of [A, B, C]) {
        await new Db(c).query("INSERT INTO users(tenant_id,id,n) VALUES (?,1,0)", [t]);
        c.time += 1;
      }
      drift.set("s0", 40);
      let release!: () => void;
      const held = new Promise<void>((r) => (release = r));
      c.net.gate = (m) => (m.method === "finalize" ? held : undefined);
      const w = await new Db(c).begin();
      await w.query("UPDATE users SET n = 1 WHERE tenant_id = ? AND id = 1", [B]);
      await w.query("UPDATE users SET n = 1 WHERE tenant_id = ? AND id = 1", [A]);
      await w.commit();
      const anchorIsAhead = c.net.log.some((m) => m.method === "prepare" && m.from === "s0");
      c.time += 5;
      const r = await new Db(c).query("SELECT tenant_id, n FROM users WHERE tenant_id IN (?, ?) ORDER BY tenant_id", [B, C]);
      if (anchorIsAhead) {
        tried++;
        if (r.rows.find((x) => x.tenant_id === B)?.n === 0) seenStale++;
      }
      c.net.gate = () => undefined;
      release();
      await c.settle();
    }
    return { tried, seenStale };
  };

  it("sees a write that was acknowledged before the read started", async () => {
    const r = await stale({});
    expect(r.tried).toBeGreaterThan(0);
    expect(r.seenStale).toBe(0);
  });

  it("without re-picking the timestamp, it returns the old value (the bug)", async () => {
    const r = await stale({ noRealtimeBump: true });
    expect(r.seenStale).toBeGreaterThan(0);
  });
});

describe("a schema change while a committed transaction is waiting to be applied", () => {
  // 取引は確定したが、phase 2 がまだ参加者に届いていない。そこへ別の接続が表を DROP する。
  // intent の行は DROP の前の表の形なので、DROP を先に適用すると、後から届く適用が永久に失敗する。
  const run = async (faults: Faults) => {
    const c = new SimCluster({ shards: 2, faults });
    await c.client().ddl(USERS);
    await c.client().ddl(`CREATE TABLE notes(tenant_id INTEGER NOT NULL, id INTEGER NOT NULL, body TEXT, PRIMARY KEY (tenant_id, id)) SHARD KEY (tenant_id)`);
    const tenants = [await tenantOn(c, "s0"), await tenantOn(c, "s1")];
    let release!: () => void;
    const held = new Promise<void>((r) => (release = r));
    c.net.gate = (m) => (m.method === "finalize" ? held : undefined);
    const w = await new Db(c).begin();
    for (const t of tenants) await w.query("INSERT INTO notes VALUES (?, 1, 'x')", [t]);
    for (const t of tenants) await w.query("INSERT INTO users(tenant_id,id,n) VALUES (?,1,7)", [t]);
    await w.commit();
    const drop = await new Db(c).ddl("DROP TABLE notes").then(() => "dropped", (e: Error) => e.message);
    c.net.gate = () => undefined;
    release();
    const problems = await quiescentProblems(c);
    const users = await new Db(c).query("SELECT count(*) AS n FROM users WHERE n = 7").then((r) => r.rows[0]!.n, (e: Error) => e.message);
    return { drop, problems, users };
  };

  it("applies the transaction first, then the schema change", async () => {
    const r = await run({});
    expect(r.drop).toBe("dropped");
    expect(r.problems).toEqual([]);
    // 同じ取引が別の表に書いた行は、両方のシャードに残っている。
    expect(r.users).toBe(2);
  });

  it("without settling intents first, the committed transaction is stuck forever (the bug)", async () => {
    const r = await run({ ddlIgnoresIntents: true });
    expect(r.problems.some((p) => /intents remain|never fully applied|redrive keeps failing/.test(p))).toBe(true);
    // 同じ取引が別の表に書いた行も読めない。読み手が intent を決着させようとして、同じ失敗に当たる。
    expect(r.users).toMatch(/no such table: notes/);
  });
});

describe("a connection whose range table is from before a split", () => {
  // 取引の中の文はやり直さないので、古い範囲表のまま「not owner」を返す。そのとき範囲表を捨てておかないと、
  // 利用者が取引をやり直しても、同じ接続では同じ誤りが続く。
  it("drops it when a statement inside a transaction fails, so retrying the transaction works", async () => {
    const c = new SimCluster({ shards: 2 });
    await c.client().ddl(USERS);
    for (let t = 1; t <= 40; t++) await new Db(c).query("INSERT INTO users(tenant_id,id,n) VALUES (?,1,?)", [t, t]);
    const db = new Db(c);
    await db.query("SELECT count(*) FROM users");
    await split(c, "s0", "s2");
    const { routing } = await c.catalog();
    let moved = 1;
    while (ownerOf(routing, JSON.stringify([moved])) !== "s2") moved++;

    await db.query("BEGIN");
    await expect(db.query("SELECT n FROM users WHERE tenant_id = ?", [moved])).rejects.toThrow(/not owner/);
    if (db.inTransaction) await db.query("ROLLBACK");

    await db.query("BEGIN");
    expect((await db.query("SELECT n FROM users WHERE tenant_id = ?", [moved])).rows).toEqual([{ n: moved }]);
    await db.query("COMMIT");
  });
});
