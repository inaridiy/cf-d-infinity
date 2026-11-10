// シャード側の上限。結果の大きさは送り返す前に、取引の大きさは確定する前に断る。
// どちらも、後で断ると手遅れになる。前者は数える前にメモリが尽き、後者は確定した取引が適用できなくなる。
import { describe, expect, it } from "vitest";
import { split } from "../src/autoscaler";
import { Db } from "../src/client/db";
import { ownerOf } from "../src/routing";
import { GROUP_MAX_BYTES } from "../src/shard/core";
import { MAX_WRITE_SET_BYTES } from "../src/types";
import { quiescentProblems } from "./invariants";
import { DO_MAX_BOUND_PARAMS, DO_MAX_VALUE_BYTES, SimCluster, SqliteBackend } from "./sim";

const DOCS = `CREATE TABLE docs(tenant_id INTEGER NOT NULL, id INTEGER NOT NULL, body TEXT, PRIMARY KEY (tenant_id, id)) SHARD KEY (tenant_id)`;
async function tenantOn(c: SimCluster, shard: string): Promise<number> {
  const { routing } = await c.catalog();
  for (let t = 1; ; t++) if (ownerOf(routing, JSON.stringify([t])) === shard) return t;
}
const text = (bytes: number, ch = "x") => ch.repeat(bytes);
const count = async (c: SimCluster, where = "1") => (await new Db(c).query(`SELECT count(*) AS n FROM docs WHERE ${where}`)).rows[0]!.n;

describe("the size of a result", () => {
  it("is cut off by the shard at the row budget, before the rows are sent", async () => {
    const c = new SimCluster({ shards: 2, noSpanCheck: true });
    await c.client().ddl(DOCS);
    for (let t = 1; t <= 40; t++) await new Db(c).query("INSERT INTO docs VALUES (?, 1, 'a')", [t]);
    let sent = 0;
    for (const b of c.backends.values()) {
      const iterate = b.iterate.bind(b);
      b.iterate = (sql, ...params) => {
        const r = iterate(sql, ...params);
        if (!/FROM "?docs/.test(sql)) return r;
        return { columns: r.columns, rows: (function* () { for (const row of r.rows) { sent++; yield row; } })() };
      };
    }
    await expect(new Db(c, { limits: { rows: 5 } }).query("SELECT * FROM docs")).rejects.toThrow(/more than 5 rows from one shard/);
    // 各シャードは上限を 1 行超えたところで読むのをやめている。40 行を全部は読まない。
    expect(sent).toBeLessThanOrEqual(2 * 6);
    expect((await new Db(c, { limits: { rows: 40 } }).query("SELECT * FROM docs")).rows).toHaveLength(40);
  });

  it("is cut off at the byte budget too", async () => {
    const c = new SimCluster({ shards: 2 });
    await c.client().ddl(DOCS);
    for (let t = 1; t <= 12; t++) await new Db(c).query("INSERT INTO docs VALUES (?, 1, ?)", [t, text(100_000)]);
    await expect(new Db(c, { limits: { bytes: 1_000_000 } }).query("SELECT * FROM docs")).rejects.toThrow(/bytes from one shard/);
    expect((await new Db(c).query("SELECT tenant_id FROM docs")).rows).toHaveLength(12);
  });

  it("a snapshot read that is too old stops reading the change log once it knows", async () => {
    const c = new SimCluster({ shards: 1 });
    const db = c.client();
    await db.ddl(DOCS);
    for (let i = 1; i <= 300; i++) await new Db(c).query("INSERT INTO docs VALUES (1, ?, 'a')", [i]);
    const cat = await c.catalog();
    const old = await c.shard("s0").now({});
    for (let i = 1; i <= 300; i++) await new Db(c).query("UPDATE docs SET body = 'b' WHERE tenant_id = 1 AND id = ?", [i]);
    const b = c.backends.get("s0")!;
    const iterate = b.iterate.bind(b);
    let logRows = 0;
    b.iterate = (sql, ...params) => {
      const r = iterate(sql, ...params);
      if (!/__log_g/.test(sql)) return r;
      return { columns: r.columns, rows: (function* () { for (const row of r.rows) { logRows++; yield row; } })() };
    };
    await expect(c.shard("s0").exec({
      sql: "SELECT count(*) FROM docs", params: [], spans: [{ kind: "table", table: "docs" }], T: old, minTs: 0, schema: cat.version,
    })).rejects.toThrow(/delta exceeds K/);
    // 300 件の変更のうち、上限 (50 行) を超えたと分かるところまでしか読まない。
    expect(logRows).toBeLessThan(80);
  });
});

describe("the size of a transaction", () => {
  const big = Math.ceil(MAX_WRITE_SET_BYTES * 0.6);

  it("is refused before commit on one shard, and nothing is applied", async () => {
    const c = new SimCluster({ shards: 2 });
    await c.client().ddl(DOCS);
    const tx = await new Db(c).begin();
    await tx.query("INSERT INTO docs VALUES (1, 1, ?)", [text(big)]);
    await tx.query("INSERT INTO docs VALUES (1, 2, ?)", [text(big)]);
    await expect(tx.commit()).rejects.toThrow(/transaction too large/);
    expect(await count(c)).toBe(0);
    // ロックを残していないので、同じ行への次の書き込みは待たされない。
    const t0 = Date.now();
    await new Db(c).query("INSERT INTO docs VALUES (1, 1, 'small')");
    expect(Date.now() - t0).toBeLessThan(1000);
    expect(await quiescentProblems(c)).toEqual([]);
  });

  it("is refused for an autocommit statement, on the direct path and on the trigger path", async () => {
    const c = new SimCluster({ shards: 1 });
    await c.client().ddl(DOCS);
    await new Db(c).query("INSERT INTO docs VALUES (1, 1, ?)", [text(big)]);
    await new Db(c).query("INSERT INTO docs VALUES (1, 2, ?)", [text(big)]);
    // 主キーで 1 行に絞れる UPDATE は高速経路を通る。変更前と変更後で 1 MB を超える。
    await expect(new Db(c).query("UPDATE docs SET body = ? WHERE tenant_id = 1 AND id = 1", [text(big, "y")])).rejects.toThrow(/transaction too large/);
    // 複数行の UPDATE は trigger で捕捉する経路を通る。
    await expect(new Db(c).query("UPDATE docs SET body = 'short' WHERE tenant_id = 1")).rejects.toThrow(/transaction too large/);
    expect((await new Db(c).query("SELECT sum(length(body)) AS n FROM docs")).rows).toEqual([{ n: big * 2 }]);
  });

  it("is refused across shards before any participant keeps an intent", async () => {
    const c = new SimCluster({ shards: 2 });
    await c.client().ddl(DOCS);
    const [A, B] = [await tenantOn(c, "s0"), await tenantOn(c, "s1")];
    const tx = await new Db(c).begin();
    await tx.query("INSERT INTO docs VALUES (?, 1, 'small')", [A]);
    await tx.query("INSERT INTO docs VALUES (?, 1, ?)", [B, text(big)]);
    await tx.query("INSERT INTO docs VALUES (?, 2, ?)", [B, text(big)]);
    await expect(tx.commit()).rejects.toThrow(/transaction too large/);
    expect(await count(c)).toBe(0);
    expect(await quiescentProblems(c)).toEqual([]);
  });

  it("the shard refuses on its own when the client does not check; without that, a committed transaction can never be applied (the bug)", async () => {
    const run = async (noWriteSetLimit: boolean) => {
      const c = new SimCluster({ shards: 2, faults: { noWriteSetLimit } });
      await c.client().ddl(DOCS);
      const [A, B] = [await tenantOn(c, "s0"), await tenantOn(c, "s1")];
      // 変更前の行も変更ログに入る。大きな行を 2 つ書き換えると、ログの 1 行が DO の値の上限 (2 MB) を超える。
      for (const id of [1, 2]) await new Db(c).query("INSERT INTO docs VALUES (?, ?, ?)", [B, id, text(600_000)]);
      const tx = await new Db(c, { limits: { writeSetBytes: Number.MAX_SAFE_INTEGER } }).begin();
      await tx.query("INSERT INTO docs VALUES (?, 1, 'small')", [A]);
      for (const id of [1, 2]) await tx.query("UPDATE docs SET body = ? WHERE tenant_id = ? AND id = ?", [text(600_000, "y"), B, id]);
      const outcome = await tx.commit().then(() => "committed", (e: Error) => e.message);
      return { outcome, problems: await quiescentProblems(c), small: await count(c, `tenant_id = ${A}`) };
    };
    const guarded = await run(false);
    expect(guarded.outcome).toMatch(/transaction too large/);
    expect(guarded.problems).toEqual([]);
    expect(guarded.small).toBe(0);

    const broken = await run(true);
    expect(broken.outcome).toBe("committed");
    expect(broken.problems.some((p) => /never fully applied|intents remain|redrive keeps failing/.test(p))).toBe(true);
  });
});

describe("a shard split", () => {
  it("walks the groups of a table once per pass, even when every row is its own group", async () => {
    // 既定の shard key は主キーの先頭列なので、`id INTEGER PRIMARY KEY` の表は 1 行が 1 グループになる。
    const ROWS = 3000;
    const c = new SimCluster({ shards: 1 });
    await c.client().ddl("CREATE TABLE items(id INTEGER PRIMARY KEY, n INTEGER NOT NULL)");
    for (let i = 1; i <= ROWS; i += 50) {
      await new Db(c).query(`INSERT INTO items(id, n) VALUES ${Array.from({ length: 50 }, (_, k) => `(${i + k}, ${i + k})`).join(", ")}`);
    }
    const parent = c.backends.get("s0")!;
    const iterate = parent.iterate.bind(parent);
    let listed = 0;
    parent.iterate = (sql, ...params) => {
      const r = iterate(sql, ...params);
      if (!/SELECT DISTINCT "id" FROM "items"/.test(sql)) return r;
      return { columns: r.columns, rows: (function* () { for (const row of r.rows) { listed++; yield row; } })() };
    };
    const moved = await split(c, "s0", "s1");
    expect(moved!.groups).toBeGreaterThan(ROWS / 4);
    // 先頭から読み直す作りだと、256 グループごとに全行を読むので、ここは数万になる。
    expect(listed).toBeLessThan(ROWS * 3);
    expect((await new Db(c).query("SELECT count(*) AS n, sum(n) AS s FROM items")).rows).toEqual([{ n: ROWS, s: (ROWS * (ROWS + 1)) / 2 }]);
    expect(await quiescentProblems(c)).toEqual([]);
  }, 60000);

  it("refuses, by name, a group that is too large to move in one message", async () => {
    const c = new SimCluster({ shards: 1 });
    await c.client().ddl(DOCS);
    const { routing } = await c.catalog();
    const range = { start: 0, end: 4096 };
    void routing;
    const rows = Math.ceil(GROUP_MAX_BYTES / 900_000) + 1;
    for (let i = 1; i <= rows; i++) await new Db(c).query("INSERT INTO docs VALUES (7, ?, ?)", [i, text(900_000)]);
    await expect(c.shard("s0").pull({ groups: [JSON.stringify([7])], to: "s1", maxBytes: 1_000_000 }).catch(async (e: Error) => {
      // fence していない範囲の pull は別の理由で断られるので、fence してから試す。
      if (!/unfenced/.test(e.message)) throw e;
      await c.shard("s0").fence({ ...range, to: "s1" });
      return c.shard("s0").pull({ groups: [JSON.stringify([7])], to: "s1", maxBytes: 1_000_000 });
    })).rejects.toThrow(/group too large to move: shard key \[7\]/);
  }, 60000);
});

describe("the simulator's storage", () => {
  it("applies the Durable Object limits that node:sqlite does not have", () => {
    const b = new SqliteBackend();
    b.exec("CREATE TABLE t(a)");
    const many = Array.from({ length: DO_MAX_BOUND_PARAMS + 1 }, (_, i) => i);
    expect(() => b.exec(`SELECT ${many.map(() => "?").join(" + ")}`, ...many)).toThrow(/too many SQL variables/);
    expect(() => b.exec("INSERT INTO t VALUES (?)", "x".repeat(DO_MAX_VALUE_BYTES + 1))).toThrow(/too big/);
    expect(() => b.exec("INSERT INTO t VALUES (?)", "x".repeat(1000))).not.toThrow();
  });
});
