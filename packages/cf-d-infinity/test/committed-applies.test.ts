// 確定を返した取引は、必ず適用できなければならない。適用が失敗し続けると、その行は読めず、変更ログは消せず、DDL も止まる。
// ここは、確定した後で初めて失敗していた原因を 1 つずつ確かめる。生成列、部分 UNIQUE index、照合順序と BLOB の UNIQUE、
// マルチバイト文字の大きさ、変更ログの世代の GC である。
import { describe, expect, it } from "vitest";
import { Db } from "../src/client/db";
import { ownerOf } from "../src/routing";
import { quiescentProblems } from "./invariants";
import { LOG_GEN_MS } from "../src/shard/core";
import { MAX_WRITE_SET_BYTES } from "../src/types";
import { SimCluster, USERS } from "./sim";

async function tenants(c: SimCluster): Promise<[number, number]> {
  const { routing } = await c.catalog();
  const on = (s: string) => { for (let t = 1; ; t++) if (ownerOf(routing, JSON.stringify([t])) === s) return t; };
  return [on("s0"), on("s1")];
}

describe("a transaction acknowledged as committed can always be applied", () => {
  for (const kind of ["STORED", "VIRTUAL"]) {
    it(`(1) table with a ${kind} generated column, two-shard transaction`, async () => {
      const c = new SimCluster({ shards: 2 });
      const db = c.client();
      await db.ddl(`CREATE TABLE g(id INTEGER PRIMARY KEY, a INTEGER, b INTEGER GENERATED ALWAYS AS (a * 2) ${kind})`);
      const [A, B] = await tenants(c);
      const tx = await new Db(c).begin();
      await tx.query("INSERT INTO g(id, a) VALUES (?, 1)", [A]);
      await tx.query("INSERT INTO g(id, a) VALUES (?, 1)", [B]);
      await tx.commit(); // resolves: the client is told the transaction committed
      await c.settle();
      const read = await new Db(c, { retries: 2 }).query("SELECT id, a, b FROM g ORDER BY id").then((r) => r.rows, (e: Error) => e.message);
      const problems = await quiescentProblems(c);
      expect(problems).toEqual([]);
      expect(read).toEqual([A, B].sort((x, y) => x - y).map((id) => ({ id, a: 1, b: 2 })));
    });
  }

  const pending = async (name: string, table: string, index: string, first: string, second: string) => {
    const c = new SimCluster({ shards: 2 });
    const db = c.client();
    await db.ddl(table);
    await db.ddl(index);
    const ts = await tenants(c);
    let release!: () => void;
    const held = new Promise<void>((r) => (release = r));
    c.net.gate = (m) => (m.method === "finalize" ? held : undefined);
    const w = await db.begin();
    for (const t of ts) await w.query(first, [t]);
    await w.commit(); // acknowledged; phase 2 is still on its way to the non-anchor shard
    const dup = await Promise.all(ts.map((t) => new Db(c, { retries: 0 }).query(second, [t]).then(() => "accepted", (e: Error) => e.message)));
    c.net.gate = () => undefined;
    release();
    await c.settle();
    for (let i = 0; i < 3; i++) await c.fireAlarms();
    const problems = await quiescentProblems(c);
    expect(dup.filter((d) => d === "accepted")).toEqual([]);
    expect(problems).toEqual([]);
  };
  const T = (col: string) => `CREATE TABLE p(tenant_id INTEGER NOT NULL, id INTEGER NOT NULL, code ${col}, deleted INTEGER, PRIMARY KEY (tenant_id, id)) SHARD KEY (tenant_id)`;

  it("(2) partial UNIQUE index (the soft-delete pattern)", () =>
    pending("partial unique", T("TEXT"), "CREATE UNIQUE INDEX p_code ON p(tenant_id, code) WHERE deleted IS NULL",
      "INSERT INTO p VALUES (?, 5, 'x', NULL)", "INSERT INTO p VALUES (?, 6, 'x', NULL)"));
  it("(3) UNIQUE on a NOCASE column, values differing in case", () =>
    pending("nocase unique", T("TEXT COLLATE NOCASE"), "CREATE UNIQUE INDEX p_code ON p(tenant_id, code)",
      "INSERT INTO p VALUES (?, 5, 'x', NULL)", "INSERT INTO p VALUES (?, 6, 'X', NULL)"));
  it("(4) UNIQUE on a BLOB column", () =>
    pending("blob unique", T("BLOB"), "CREATE UNIQUE INDEX p_code ON p(tenant_id, code)",
      "INSERT INTO p VALUES (?, 5, x'0102', NULL)", "INSERT INTO p VALUES (?, 6, x'0102', NULL)"));

  it("(5) text that is small in characters but large in bytes is refused before commit", async () => {
    const c = new SimCluster({ shards: 2 });
    await c.client().ddl(`CREATE TABLE docs(tenant_id INTEGER NOT NULL, id INTEGER NOT NULL, body TEXT, PRIMARY KEY (tenant_id, id)) SHARD KEY (tenant_id)`);
    const [A, B] = await tenants(c);
    // 380,000 文字は UTF-8 で 1.14 MB になる。2 行で、変更ログの 1 行 (上限 2 MB) に収まらない。
    const cjk = "あ".repeat(380_000);
    expect(2 * cjk.length).toBeLessThan(MAX_WRITE_SET_BYTES);
    const tx = await new Db(c).begin();
    await tx.query("INSERT INTO docs VALUES (?, 1, 'small')", [A]);
    await tx.query("INSERT INTO docs VALUES (?, 1, ?)", [B, cjk]);
    await tx.query("INSERT INTO docs VALUES (?, 2, ?)", [B, cjk]);
    await expect(tx.commit()).rejects.toThrow(/transaction too large/);
    await c.settle();
    expect(await quiescentProblems(c)).toEqual([]);
    expect((await new Db(c).query("SELECT count(*) AS n FROM docs")).rows).toEqual([{ n: 0 }]);
  });

  it("(6) phase 2 that arrives after the shard moved to a later log generation is still applied", async () => {
    const c = new SimCluster({ shards: 2 });
    c.time = 50 * LOG_GEN_MS + 110_000; // 変更ログの世代が替わる 10 秒前
    await c.client().ddl(USERS);
    const { routing } = await c.catalog();
    const on = (s: string, skip: number) => { for (let t = 1, n = 0; ; t++) if (ownerOf(routing, JSON.stringify([t])) === s && n++ === skip) return t; };
    const [a, a2, b1, b2] = [on("s0", 0), on("s0", 1), on("s1", 0), on("s1", 1)];
    let release!: () => void;
    const held = new Promise<void>((r) => (release = r));
    c.net.gate = (m) => (m.method === "finalize" ? held : undefined);
    const tx = await new Db(c).begin();
    await tx.query("INSERT INTO users(tenant_id, id, name) VALUES (?, 1, 'x')", [a]);
    await tx.query("INSERT INTO users(tenant_id, id, name) VALUES (?, 1, 'x')", [b1]);
    await tx.commit();
    // 次の世代が始まり、関係のない行が書かれる。その後で、遅れていた phase 2 が古い世代の時刻で届く。
    c.time += 20_000;
    await new Db(c).query("INSERT INTO users(tenant_id, id, name) VALUES (?, 1, 'other')", [a2]);
    await new Db(c).query("INSERT INTO users(tenant_id, id, name) VALUES (?, 1, 'other')", [b2]);
    c.net.gate = () => undefined;
    release();
    await c.settle();
    expect(await quiescentProblems(c)).toEqual([]);
    expect((await new Db(c).query("SELECT count(*) AS n FROM users WHERE name = 'x'")).rows).toEqual([{ n: 2 }]);
  });

  it("a table with a generated column reads the same through the Worker's SQLite, and exports without the column", async () => {
    const c = new SimCluster({ shards: 2 });
    const db = c.client();
    await db.ddl(`CREATE TABLE g(id INTEGER PRIMARY KEY, a INTEGER, b INTEGER GENERATED ALWAYS AS (a * 2) STORED)`);
    for (let i = 1; i <= 8; i++) await db.query("INSERT INTO g(id, a) VALUES (?, ?)", [i, i]);
    // 複数シャードの集約は、行を Worker の SQLite に集めてから実行する。
    expect((await db.query("SELECT sum(b) AS s, count(DISTINCT b) AS n FROM g")).rows).toEqual([{ s: 72, n: 8 }]);
    await db.transaction(async (tx) => {
      await tx.query("UPDATE g SET a = a + 10 WHERE id IN (1, 2, 3, 4, 5, 6, 7, 8)");
    });
    expect((await db.query("SELECT b FROM g WHERE id = 3")).rows).toEqual([{ b: 26 }]);
    const page = await c.shard("s0").exportRows({ table: "g", after: null, limit: 10 });
    expect(page.columns).toEqual(["id", "a"]);
  });
});
