// 入口の受け入れの規則。文の形と値だけで決まる理由で断るもの。行がどのシャードにあるかには依らない。
// 断るときは `unsupported:` で始まるエラーを返し、状態は変えない。
import { DatabaseSync } from "node:sqlite";
import { describe, expect, it } from "vitest";
import { handlePipeline, type PipelineReq } from "../src/client/hrana";
import { quiescentProblems } from "./invariants";
import { SimCluster } from "./sim";

const refusal = (p: Promise<unknown>) => p.then(() => "ok", (e: Error) => e.message);

describe("NULL in a declared primary key (invariant 6: one identity per row)", () => {
  // SQLite は、INTEGER でない主キーの列に NULL を複数入れられる。主キーの値の文字列では、それらの行を区別できない。
  // 行イメージの適用は主キーで行を名指しするので、受け付けると、別の行を書き換える。
  it("is refused on INSERT and on UPDATE, and leaves the table as it was", async () => {
    const c = new SimCluster({ shards: 2 });
    const db = c.client();
    await db.query("CREATE TABLE k(id TEXT PRIMARY KEY, v)");
    await db.query("INSERT INTO k VALUES ('a', 1)");
    expect(await refusal(db.query("INSERT INTO k VALUES (NULL, 1)"))).toMatch(/^unsupported: NULL in the primary key column id of k/);
    expect(await refusal(db.query("INSERT INTO k VALUES ('b', 2), (NULL, 3)"))).toMatch(/^unsupported: NULL in the primary key column id of k/);
    expect(await refusal(db.query("UPDATE k SET id = NULL WHERE id = 'a'"))).toMatch(/^unsupported: NULL in the primary key column id of k/);
    expect(await refusal(db.query("UPDATE k SET id = NULL WHERE v = 1"))).toMatch(/^unsupported: NULL in the primary key column id of k/);
    expect((await db.query("SELECT id, v FROM k ORDER BY id")).rows).toEqual([{ id: "a", v: 1 }]);
    expect(await quiescentProblems(c)).toEqual([]);
  });

  it("is refused inside a transaction without ending the transaction", async () => {
    const db = new SimCluster({ shards: 2 }).client();
    await db.query("CREATE TABLE k(a TEXT, b TEXT, v, PRIMARY KEY (a, b))");
    await db.query("BEGIN");
    await db.query("INSERT INTO k VALUES ('x', 'y', 1)");
    expect(await refusal(db.query("INSERT INTO k VALUES ('x', NULL, 2)"))).toMatch(/^unsupported: NULL in the primary key column b of k/);
    await db.query("COMMIT");
    expect((await db.query("SELECT a, b, v FROM k")).rows).toEqual([{ a: "x", b: "y", v: 1 }]);
  });

  it("does not touch tables whose key cannot be NULL: INTEGER PRIMARY KEY takes a rowid, a table without a key has one", async () => {
    const db = new SimCluster({ shards: 2 }).client();
    const lite = new DatabaseSync(":memory:");
    for (const s of ["CREATE TABLE n(id INTEGER PRIMARY KEY, v)", "INSERT INTO n VALUES (NULL, 1)", "INSERT INTO n(v) VALUES (2)",
      "CREATE TABLE r(a, b)", "INSERT INTO r VALUES (NULL, NULL)", "INSERT INTO r VALUES (NULL, NULL)"]) {
      await db.query(s);
      lite.exec(s);
    }
    expect((await db.query("SELECT count(*) AS c, count(id) AS ids FROM n")).rows).toEqual(lite.prepare("SELECT count(*) AS c, count(id) AS ids FROM n").all().map((x) => ({ ...x })));
    expect((await db.query("SELECT count(*) AS c FROM r")).rows).toEqual([{ c: 2 }]);
  });
});

describe("the schema read inside a statement that runs on one shard (invariant 5: internal tables are not addressable)", () => {
  // Worker の SQLite には利用者の表しかないが、`pragma_table_info('名前')` や `sqlite_master` は、表がなくてもコンパイルできる。
  // その文をシャードへ送ると、同じ式がシャードの内部の表について答える。
  const setup = async () => {
    const c = new SimCluster({ shards: 2 });
    const db = c.client();
    await db.ddl("CREATE TABLE t(tenant_id INTEGER NOT NULL, id INTEGER NOT NULL, n INTEGER, tags TEXT, PRIMARY KEY (tenant_id, id)) SHARD KEY (tenant_id)");
    await db.query("INSERT INTO t VALUES (1, 1, 0, '[\"a\",\"b\"]')");
    return { c, db };
  };
  const REFUSED = /^unsupported: a statement that runs on one shard cannot read sqlite_master or a PRAGMA function/;

  it("in a read, is refused or answered from the user's schema, whatever name the schema table goes by", async () => {
    const { db } = await setup();
    const lite = new DatabaseSync(":memory:");
    lite.exec("CREATE TABLE t(tenant_id INTEGER NOT NULL, id INTEGER NOT NULL, n INTEGER, tags TEXT, PRIMARY KEY (tenant_id, id))");
    lite.exec("INSERT INTO t VALUES (1, 1, 0, '[\"a\",\"b\"]')");
    const outcomes: string[] = [];
    for (const inner of [
      "SELECT count(*) FROM pragma_table_info('__txn')",
      "SELECT count(*) FROM sqlite_master WHERE name LIKE '\\_\\_%' ESCAPE '\\'",
      "SELECT count(*) FROM sqlite_schema",
      "SELECT count(*) FROM main.sqlite_master",
      "SELECT count(*) FROM \"pragma_table_list\"",
    ]) {
      const sql = `SELECT n, (${inner}) AS x FROM t WHERE tenant_id = 1 AND id = 1`;
      const ours = await db.query(sql).then((r) => r.rows, (e: Error) => e.message);
      // 断るか、利用者の表しかない SQLite と同じ答えを返す。シャードの内部の表を数えた答えは、どちらでもない。
      if (typeof ours === "string") expect(ours, inner).toMatch(REFUSED);
      else expect(ours, inner).toEqual(lite.prepare(sql).all().map((r) => ({ ...r })));
      outcomes.push(typeof ours === "string" ? "refused" : "answered");
    }
    // プランナが FROM の名前で気付く形は Worker で答え、気付かない形 (PRAGMA の関数) は、シャードへ送る前の確認が断る。
    expect(outcomes).toContain("refused");
  });

  it("is refused in a write, and the row is not written", async () => {
    const { c, db } = await setup();
    expect(await refusal(db.query("UPDATE t SET n = (SELECT count(*) FROM sqlite_master) WHERE tenant_id = 1 AND id = 1"))).toMatch(REFUSED);
    expect(await refusal(db.query("DELETE FROM t WHERE tenant_id = 1 AND id = (SELECT count(*) FROM pragma_table_info('__intents'))"))).toMatch(REFUSED);
    await db.query("BEGIN");
    expect(await refusal(db.query("UPDATE t SET n = (SELECT count(*) FROM sqlite_master) WHERE tenant_id = 1 AND id = 1"))).toMatch(REFUSED);
    await db.query("COMMIT");
    expect((await db.query("SELECT n FROM t WHERE tenant_id = 1 AND id = 1")).rows).toEqual([{ n: 0 }]);
    expect(await quiescentProblems(c)).toEqual([]);
  });

  it("still answers a schema query that is a statement of its own, from the user's schema only", async () => {
    const { db } = await setup();
    expect((await db.query("SELECT name FROM sqlite_master WHERE type = 'table' ORDER BY name")).rows).toEqual([{ name: "t" }]);
    expect((await db.query("SELECT count(*) AS c FROM pragma_table_info('t')")).rows).toEqual([{ c: 4 }]);
    expect((await db.query("SELECT count(*) AS c FROM pragma_table_info('__txn')")).rows).toEqual([{ c: 0 }]);
  });

  it("does not refuse other table-valued functions, or a string that merely mentions the schema table", async () => {
    const { db } = await setup();
    expect((await db.query("SELECT j.value AS tag FROM t, json_each(t.tags) AS j WHERE t.tenant_id = 1 AND t.id = 1 ORDER BY tag")).rows)
      .toEqual([{ tag: "a" }, { tag: "b" }]);
    await db.query("UPDATE t SET tags = 'see pragma_table_info and sqlite_master' WHERE tenant_id = 1 AND id = 1");
    expect((await db.query("SELECT tags FROM t WHERE tenant_id = 1 AND id = 1")).rows).toEqual([{ tags: "see pragma_table_info and sqlite_master" }]);
  });
});

describe("an integer that JavaScript cannot hold exactly, arriving over Hrana", () => {
  // Hrana は整数を 10 進の文字列で運ぶ。2^53 を超える値を数値にすると、黙って隣の値になる。
  const run = async (c: SimCluster, sql: string, args: { type: "integer"; value: string }[]) => {
    const req = { baton: null, requests: [{ type: "execute", stmt: { sql, args } }] } as unknown as PipelineReq;
    const [r] = (await handlePipeline(req, async () => c.client())).results as { type: string; error?: { message: string } }[];
    return r!.type === "ok" ? "ok" : r!.error!.message;
  };

  it("is refused instead of being rounded to a neighbouring value", async () => {
    const c = new SimCluster({ shards: 2 });
    await c.client().query("CREATE TABLE big(id INTEGER PRIMARY KEY, v INTEGER)");
    expect(await run(c, "INSERT INTO big VALUES (?, ?)", [{ type: "integer", value: "9007199254740993" }, { type: "integer", value: "1" }]))
      .toMatch(/^unsupported: the integer 9007199254740993 cannot be stored exactly/);
    expect(await run(c, "INSERT INTO big VALUES (?, ?)", [{ type: "integer", value: "1" }, { type: "integer", value: "-9007199254740993" }]))
      .toMatch(/^unsupported: the integer -9007199254740993 cannot be stored exactly/);
    // 範囲の端は通る。
    expect(await run(c, "INSERT INTO big VALUES (?, ?)", [{ type: "integer", value: "9007199254740991" }, { type: "integer", value: "-9007199254740991" }])).toBe("ok");
    expect((await c.client().query("SELECT id, v FROM big")).rows).toEqual([{ id: 9007199254740991, v: -9007199254740991 }]);
  });
});
