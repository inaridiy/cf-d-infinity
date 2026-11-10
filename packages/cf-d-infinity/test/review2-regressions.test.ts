// 2 回目の全体レビュー (2026-11) で再現した欠陥の回帰テスト。確定した取引が適用できなくなる類は committed-applies.test.ts、
// DDL の失敗は schema-failure.test.ts にある。ここはそれ以外を置く。
import { describe, expect, it } from "vitest";
import { Db } from "../src/client/db";
import { physicalToTs } from "../src/hlc";
import { ownerOf } from "../src/routing";
import { quiescentProblems } from "./invariants";
import { SimCluster, USERS } from "./sim";

const tenantOn = async (c: SimCluster, shard: string, skip = 0) => {
  const { routing } = await c.catalog();
  for (let t = 1, n = 0; ; t++) if (ownerOf(routing, JSON.stringify([t])) === shard && n++ === skip) return t;
};

describe("read refresh after the shard dropped its recent-write index", () => {
  // 直近の書き込みの索引は、項目が増えすぎると丸ごと捨てる。捨てた後は「書き込みがなかった」とは言えない。
  // 取引の読みの時刻を進める確認 (refresh) がそれを無視すると、別の取引の半分だけを見た読みが通る。
  it("does not let a transaction see half of another transaction", async () => {
    const c = new SimCluster({ shards: 2, recentMax: 300 });
    const db = c.client();
    await db.ddl(`CREATE TABLE t(id INTEGER PRIMARY KEY, n INTEGER NOT NULL)`);
    const { routing } = await c.catalog();
    const on = (s: string, from: number) => { for (let t = from; ; t++) if (ownerOf(routing, JSON.stringify([t])) === s) return t; };
    const [A, B] = [on("s0", 1), on("s1", 1)];
    await db.query("INSERT INTO t VALUES (?, 0)", [A]);
    await db.query("INSERT INTO t VALUES (?, 0)", [B]);
    c.time += 10;
    const x = await new Db(c, { retries: 0 }).begin();
    const a = (await x.query("SELECT n FROM t WHERE id = ?", [A])).rows[0]!.n;
    c.time += 10;
    await new Db(c).transaction(async (w) => {
      await w.query("UPDATE t SET n = 1 WHERE id = ?", [A]);
      await w.query("UPDATE t SET n = 1 WHERE id = ?", [B]);
    });
    await c.settle();
    const core = c.cores.get("s0") as unknown as { recentLowWater: number };
    for (let next = 1000; core.recentLowWater === 0; c.time += 1) {
      const ids: number[] = [];
      while (ids.length < 45) { next = on("s0", next); ids.push(next++); }
      await new Db(c).query(`INSERT INTO t VALUES ${ids.map(() => "(?, 0)").join(", ")}`, ids);
    }
    // 読めないか、両方とも前の値か、両方とも後の値でなければならない。
    const b = await x.query("SELECT n FROM t WHERE id = ?", [B]).then((r) => r.rows[0]!.n, (e: Error) => e.message);
    expect([[0, 0], [1, 1]].some((ok) => ok[0] === a && ok[1] === b) || typeof b === "string").toBe(true);
    expect([a, b]).not.toEqual([0, 1]);
  }, 60_000);
});

describe("a session token that is not from this database", () => {
  it("is refused when it is far ahead of the shard's clock, and the clock does not move", async () => {
    const c = new SimCluster({ shards: 2 });
    await c.client().ddl(USERS);
    const [a, b] = [await tenantOn(c, "s0"), await tenantOn(c, "s1")];
    await new Db(c).query("INSERT INTO users(tenant_id, id, n) VALUES (?, 1, 0)", [a]);
    const before = await Promise.all(["s0", "s1"].map((id) => c.shard(id).now({})));
    for (const token of [Number.MAX_SAFE_INTEGER, physicalToTs(c.time + 365 * 86_400_000)]) {
      await expect(new Db(c, { token, retries: 0 }).query("SELECT 1 FROM users WHERE tenant_id = ? AND id = 1", [a])).rejects.toThrow(/ahead of shard/);
      await expect(new Db(c, { token, retries: 0 }).query("SELECT count(*) FROM users")).rejects.toThrow(/ahead of shard/);
      await expect(new Db(c, { token, retries: 0 }).query("INSERT INTO users(tenant_id, id, n) VALUES (?, 9, 0)", [b])).rejects.toThrow(/ahead of shard/);
    }
    const after = await Promise.all(["s0", "s1"].map((id) => c.shard(id).now({})));
    // 2 回目の now() の分だけ進む。先の時刻へ飛んでいない。
    after.forEach((t, i) => expect(t - before[i]!).toBeLessThan(physicalToTs(1000)));
    // 続けて普通に書ける。
    await new Db(c).query("UPDATE users SET n = n + 1 WHERE tenant_id = ? AND id = 1", [a]);
    expect((await new Db(c).query("SELECT n FROM users WHERE tenant_id = ? AND id = 1", [a])).rows).toEqual([{ n: 1 }]);
    expect(await quiescentProblems(c)).toEqual([]);
  });

  it("is ignored when it is not a timestamp at all (a D1 bookmark, NaN, a negative number)", async () => {
    for (const token of [Number("00000085-0000024c-00004c6d-8e61117bf38d7adb71b934ebbf891683"), -5, 1.5, "12" as unknown as number]) {
      const c = new SimCluster({ shards: 2 });
      await c.client().ddl(USERS);
      const [A, B] = [await tenantOn(c, "s0"), await tenantOn(c, "s1")];
      for (const t of [A, B]) await new Db(c).query("INSERT INTO users(tenant_id,id,n) VALUES (?,1,0)", [t]);
      let release!: () => void;
      const held = new Promise<void>((r) => (release = r));
      c.net.gate = (m) => (m.method === "finalize" && m.to === "s1" ? held : undefined);
      const w = await new Db(c).begin();
      await w.query("SELECT n FROM users WHERE tenant_id = ? AND id = 2", [A]); // s0 を anchor にする
      for (const t of [A, B]) await w.query("UPDATE users SET n = 1 WHERE tenant_id = ? AND id = 1", [t]);
      await w.commit(); // 確定を返した。s1 にはまだ intent しかない
      const rows = (await new Db(c, { token }).query("SELECT n FROM users ORDER BY tenant_id")).rows.map((r) => r.n);
      c.net.gate = () => undefined;
      release();
      await c.settle();
      expect(rows).toEqual([1, 1]);
    }
  });
});

describe("a shard that moved many groups away", () => {
  it("still starts", async () => {
    const c = new SimCluster({ shards: 1 });
    await c.client().ddl(USERS);
    // 分割で 15 万グループを送り出した後の状態を、表へ直接作る。
    c.backends.get("s0")!.exec(
      `WITH RECURSIVE n(i) AS (SELECT 1 UNION ALL SELECT i + 1 FROM n WHERE i < 150000)
       INSERT INTO __moved(g, m, dest, acked) SELECT '[' || i || ']', 1000 + i, 's9', 1 FROM n`,
    );
    expect(() => c.restart("s0")).not.toThrow();
    expect((await new Db(c).query("SELECT count(*) AS n FROM users")).rows).toEqual([{ n: 0 }]);
  });
});
