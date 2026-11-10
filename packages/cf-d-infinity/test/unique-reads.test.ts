// 書き込みが、UNIQUE の検査で別の行を読む場合の試験。範囲が名指しした 1 行だけだと、その別の行の確定済みで適用待ちの変更が
// 決着されず、誤って UNIQUE 違反になるか、OR IGNORE が黙って何もしない。範囲を作る関数 (src/client/spans.ts) が、
// UNIQUE のある表への書き込みを shard key の値の単位に広げる。
import { describe, expect, it } from "vitest";
import { Db } from "../src/client/db";
import { ownerOf } from "../src/routing";
import { quiescentProblems } from "./invariants";
import { SimCluster } from "./sim";

const outcome = async <T>(p: Promise<T>) => p.then((v) => ({ ok: v as unknown }), (e: Error) => ({ err: e.message }));

describe("a statement that reads another row through a local UNIQUE index", () => {
  // The span of a single-row INSERT / pk UPDATE is that primary key. The UNIQUE check reads the row that holds the
  // value, which has another primary key, so a committed-but-unapplied change of that row is not settled first.
  const setup = async () => {
    const c = new SimCluster({ shards: 2 });
    const db = c.client();
    await db.ddl(`CREATE TABLE p(tenant_id INTEGER NOT NULL, id INTEGER NOT NULL, code TEXT, PRIMARY KEY (tenant_id, id), UNIQUE (tenant_id, code)) SHARD KEY (tenant_id)`);
    const { routing } = await c.catalog();
    const on = (s: string) => { for (let t = 1; ; t++) if (ownerOf(routing, JSON.stringify([t])) === s) return t; };
    const [A, B] = [on("s1"), on("s0")];
    for (const t of [A, B]) await db.query("INSERT INTO p VALUES (?, 1, 'x')", [t]);
    await db.query("INSERT INTO p VALUES (?, 2, 'y')", [A]);
    // X deletes the holder of 'x' on both shards; s0 is the anchor; the finalize to s1 is delayed. X is acknowledged.
    let release!: () => void;
    const held = new Promise<void>((r) => (release = r));
    c.net.gate = (m) => (m.method === "finalize" && m.to === "s1" ? held : undefined);
    const x = await new Db(c).begin();
    await x.query("SELECT code FROM p WHERE tenant_id = ?", [B]);
    for (const t of [A, B]) await x.query("DELETE FROM p WHERE tenant_id = ? AND id = 1", [t]);
    await x.commit();
    expect(c.net.log.some((m) => m.method === "prepare" && m.from === "s0" && m.to === "s1")).toBe(true);
    const done = async () => {
      c.net.gate = () => undefined;
      release();
      await c.settle();
    };
    return { c, A, done };
  };

  it("INSERT of a value freed by an acknowledged DELETE succeeds", async () => {
    const { c, A, done } = await setup();
    const ins = await outcome(new Db(c, { retries: 3 }).query("INSERT INTO p VALUES (?, 3, 'x')", [A]));
    await done();
    expect(ins).toHaveProperty("ok");
  });

  it("UPDATE to a value freed by an acknowledged DELETE succeeds", async () => {
    const { c, A, done } = await setup();
    const upd = await outcome(new Db(c, { retries: 3 }).query("UPDATE p SET code = 'x' WHERE tenant_id = ? AND id = 2", [A]));
    await done();
    expect(upd).toHaveProperty("ok");
  });

  it("INSERT OR IGNORE of a value freed by an acknowledged DELETE inserts the row", async () => {
    const { c, A, done } = await setup();
    const ins = await outcome(new Db(c, { retries: 3 }).query("INSERT OR IGNORE INTO p VALUES (?, 3, 'x')", [A]).then((r) => r.changes));
    await done();
    const rows = await new Db(c).query("SELECT id, code FROM p WHERE tenant_id = ? ORDER BY id", [A]).then((r) => r.rows);
    expect(ins).toEqual({ ok: 1 });
    expect(rows).toEqual([{ id: 2, code: "y" }, { id: 3, code: "x" }]);
  });

  it("the same inside a transaction", async () => {
    const { c, A, done } = await setup();
    const db = new Db(c, { retries: 3 });
    const ins = await outcome(db.transaction((tx) => tx.query("INSERT OR IGNORE INTO p VALUES (?, 3, 'x')", [A]).then((r) => r.changes)));
    await done();
    expect(ins).toEqual({ ok: 1 });
  });
});

describe("INSERT ... VALUES with `x IN table`", () => {
  // 右辺の表は FROM に現れないので、プランナは読むことを知らない。行を受け取るシャードだけで実行すると、別のシャードにある行が欠ける。
  // SQLite のコンパイル結果と突き合わせて、知らない表を読む文は断る。
  it("is refused instead of reading only the rows on the shard that receives the row", async () => {
    const c = new SimCluster({ shards: 2 });
    const db = c.client();
    await db.ddl("CREATE TABLE allowed(id INTEGER PRIMARY KEY)");
    await db.ddl("CREATE TABLE t(id INTEGER PRIMARY KEY, ok INTEGER)");
    const { routing } = await c.catalog();
    const on = (s: string) => { for (let t = 1; ; t++) if (ownerOf(routing, JSON.stringify([t])) === s) return t; };
    const [a, b] = [on("s0"), on("s1")];
    await db.query("INSERT INTO allowed VALUES (?)", [a]);
    await expect(db.query("INSERT INTO t VALUES (?, ? IN allowed)", [b, a])).rejects.toThrow(/unsupported: the statement reads allowed/);
    // 同じことを、サブクエリで書けば通り、正しい値が入る。
    await db.query("INSERT INTO t VALUES (?, (SELECT count(*) FROM allowed WHERE id = ?))", [b, a]);
    expect((await db.query("SELECT ok FROM t WHERE id = ?", [b])).rows).toEqual([{ ok: 1 }]);
  });
});
