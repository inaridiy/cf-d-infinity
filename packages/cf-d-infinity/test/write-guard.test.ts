// シャードの書き込みの守り (src/shard/kernel.ts の claimed) と、シミュレータの書き込みの側の範囲の検査 (test/sim.ts の checkWrites)。
//
// 守りは、シャードが受け入れようとする変更の行のどれもが、そのシャードの持ち物で、文が宣言した範囲の中にあることを確かめ、
// 外れたら書き込みの全体を WriteOutsideClaim で断る。検査は、守りとは別に、Meta の範囲表とシャードの移動の記録から持ち主を決めて
// 確かめ、守りを外しても (欠陥のスイッチ ignoreWriteClaim) 同じに報告する。
//
// 1 つ目の組は、未解決の問題 35 の形 (test/open/multi-row-insert-after-split.test.ts) を、守りを外した場合と掛けた場合で流す。
// 2 つ目の組は、利用者の文を実行する経路のそれぞれ (autocommit の高速経路と trigger の経路、取引の下書き、悲観的な DML) と、
// 取引の変更を受け取る経路 (commitLocal、prepare) で、守りが断ることを、シャードへ直に要求を送って確かめる。
import { afterEach, describe, expect, it } from "vitest";
import { split } from "../src/autoscaler";
import { Db } from "../src/client/db";
import { keyString } from "../src/keys";
import { ownerOf, planSplit, regionsOf, tokenOf } from "../src/routing";
import { tupleOfRow } from "../src/shard/rows";
import type { Change, Span } from "../src/types";
import { isWriteOutsideClaim } from "../src/types";
import { rawRows } from "./ddl-harness";
import { allWriteEscapes, SimCluster } from "./sim";

afterEach(() => {
  allWriteEscapes.length = 0; // ここで見つけたものは、この試験が確かめた。全体の検査には渡さない
});

/** 問題 35 の場面。分割の前の範囲表を覚えた Db と、2 回の分割で s0 から生まれた s1 と s2、それぞれが持つ主キー a と b。 */
async function staleInsertScene(c: SimCluster) {
  const db = new Db(c);
  await db.ddl("CREATE TABLE t(id INTEGER PRIMARY KEY, v INTEGER NOT NULL)");
  await db.query("SELECT count(*) FROM t");
  const half = planSplit((await c.catalog()).routing, "s0")!;
  await split(c, "s0", "s1", { range: half });
  const quarter = planSplit((await c.catalog()).routing, "s0")!;
  await split(c, "s0", "s2", { range: quarter });
  const { routing } = await c.catalog();
  const on = (shard: string) => { for (let i = 1; ; i++) if (ownerOf(routing, keyString([i])) === shard) return i; };
  return { db, a: on("s1"), b: on("s2") };
}

const stored = async (c: SimCluster) => (await rawRows(c, "t")).map((r) => `${r.row.id as number}@${r.shard}`).sort();

describe("the shard's write guard on a multi-row INSERT planned before two splits (open problem 35)", () => {
  it("with the guard off (ignoreWriteClaim), both new shards take every row, and the write check reports it", async () => {
    const c = new SimCluster({ shards: 1, faults: { ignoreWriteClaim: true } });
    const { db, a, b } = await staleInsertScene(c);
    await db.query("INSERT INTO t VALUES (?, 1), (?, 2)", [a, b]);
    await c.settle();
    // 同じ主キーの行が 2 つのシャードにある。
    expect(await stored(c)).toEqual([`${a}@s1`, `${a}@s2`, `${b}@s1`, `${b}@s2`].sort());
    const read = await new Db(c).query("SELECT id, v FROM t ORDER BY id").then((r) => r.values, (e: Error) => `error ${e.message}`);
    expect(read).toMatch(/UNIQUE constraint failed/);
    // 検査は、守りがなくても、宣言の外の行と、持ち主でないシャードに残る行を報告する。文の実行と、確定のときの受け入れの両方である。
    const seen = c.writeEscapes.map((e) => `${e.shard} ${e.sql === null ? "commit" : "statement"} ${e.row}`);
    expect(seen).toEqual(expect.arrayContaining([`s1 statement t [${b}]`, `s2 statement t [${a}]`, `s1 commit t [${b}]`, `s2 commit t [${a}]`]));
    expect(c.writeEscapes.find((e) => e.shard === "s1" && e.sql !== null)?.problem).toMatch(/outside its declared spans/);
    expect(c.writeEscapes.find((e) => e.shard === "s1" && e.sql === null)?.problem).toMatch(/does not own token/);
    // 行を持ち主でないシャードに残さなかった書き込みは、報告しない。
    expect(seen).not.toContain(`s1 statement t [${a}]`);
    expect(seen).not.toContain(`s2 statement t [${b}]`);
  });

  it("with the guard on, the new shards refuse the statement, nothing is stored, and a fresh plan stores each row once on its owner", async () => {
    const c = new SimCluster({ shards: 1 });
    const { db, a, b } = await staleInsertScene(c);
    const failed = await db.query("INSERT INTO t VALUES (?, 1), (?, 2)", [a, b]).then(() => null, (e: Error) => e);
    expect(failed?.message).toMatch(/^write outside claim: the statement wrote t row \[\d+\] \(shard key \[\d+\]\) on shard s[12], outside the spans it declared/);
    expect(isWriteOutsideClaim(failed)).toBe(true);
    await c.settle();
    expect(await stored(c)).toEqual([]);
    // 断られた書き込みも、検査は報告する。Worker の宣言の誤りだからである。
    expect(c.writeEscapes.some((e) => e.shard === "s1" && e.row === `t [${b}]`)).toBe(true);
    c.writeEscapes.length = 0;
    allWriteEscapes.length = 0;
    // いまの範囲表で計画し直した Db は、行を持ち主ごとの文に分けて送る。
    await new Db(c).query("INSERT INTO t VALUES (?, 1), (?, 2)", [a, b]);
    await c.settle();
    expect(await stored(c)).toEqual([`${a}@s1`, `${b}@s2`].sort());
    expect(c.writeEscapes).toEqual([]);
  });
});

describe("the shard's write guard on each path that runs user SQL or takes a transaction's writes", () => {
  /** シャード 1 つ (s0) と表 t。行 1 を宣言して、行 1 と行 2 を入れる文を、直に送る。 */
  async function scene(faults = {}) {
    const c = new SimCluster({ shards: 1, faults });
    const db = c.client();
    await db.ddl("CREATE TABLE t(id INTEGER PRIMARY KEY, v INTEGER NOT NULL)");
    const cat = await c.catalog();
    const row1: Span = { kind: "pk", table: "t", pk: keyString([1]), sk: keyString([1]) };
    const req = { sql: "INSERT INTO t VALUES (1, 10), (2, 20)", params: [], spans: [row1], schema: cat.version };
    return { c, cat, req };
  }

  it("refuses an autocommit write that writes a row it did not declare, on the RETURNING path and on the trigger path", async () => {
    const { c, req } = await scene();
    await expect(c.shard("s0").execAuto({ ...req, write: { sk: null, capture: "insert" } })).rejects.toThrow(/^write outside claim: the statement wrote t row \[2\]/);
    await expect(c.shard("s0").execAuto({ ...req, write: { sk: null } })).rejects.toThrow(/^write outside claim: the statement wrote t row \[2\]/);
    expect(await stored(c)).toEqual([]);
    expect(c.writeEscapes.map((e) => e.row)).toEqual(["t [2]", "t [2]"]);
  });

  it("returns the refusal as the statement's error on the transaction paths, optimistic and pessimistic, with no changes", async () => {
    const { c, req } = await scene();
    const optimistic = await c.shard("s0").exec({ ...req, write: { sk: null } });
    expect(optimistic.error).toMatch(/^write outside claim: the statement wrote t row \[2\]/);
    expect(optimistic.changes).toEqual([]);
    const pessimistic = await c.shard("s0").exec({ ...req, write: { sk: null }, lock: { txn: "x", start: 1 } });
    expect(pessimistic.error).toMatch(/^write outside claim: the statement wrote t row \[2\]/);
    expect(pessimistic.changes).toEqual([]);
    expect(pessimistic.F).toBeTypeOf("number");
    expect(await stored(c)).toEqual([]);
  });

  it("lets the same statements through when they declare both rows", async () => {
    const { c, req } = await scene();
    const both = [...req.spans, { kind: "pk" as const, table: "t", pk: keyString([2]), sk: keyString([2]) }];
    const dry = await c.shard("s0").exec({ ...req, spans: both, write: { sk: null } });
    expect(dry.error).toBeUndefined();
    expect(dry.changes.map((ch) => ch.pk)).toEqual([keyString([1]), keyString([2])]);
    await c.shard("s0").execAuto({ ...req, spans: both, write: { sk: null, capture: "insert" } });
    expect(await stored(c)).toEqual(["1@s0", "2@s0"]);
    expect(c.writeEscapes).toEqual([]);
  });

  it("puts back the old behaviour with ignoreWriteClaim: the undeclared row is stored, and the write check still reports it", async () => {
    const { c, req } = await scene({ ignoreWriteClaim: true });
    await c.shard("s0").execAuto({ ...req, write: { sk: null, capture: "insert" } });
    expect(await stored(c)).toEqual(["1@s0", "2@s0"]);
    expect(c.writeEscapes.map((e) => `${e.row}: ${e.problem}`)).toEqual([expect.stringMatching(/^t \[2\]: the statement wrote a row outside its declared spans/)]);
  });

  it("refuses a transaction's write whose row image is not the row it names, at commitLocal and at prepare", async () => {
    const { c, cat } = await scene();
    const def = cat.tables.t!;
    // 行 5 を名乗り、行 7 のイメージを運ぶ変更。持ち主の確かめ (enter) は行 5 について済むが、本体に入るのは行 7 である。
    const forged: Change = { table: "t", pk: keyString([5]), sk: keyString([5]), before: null, after: tupleOfRow(def, { id: 7, v: 1 }) };
    const T = await c.shard("s0").now({});
    await expect(c.shard("s0").commitLocal({ txn: "t1", T, writes: [forged], spans: [], schema: cat.version }))
      .rejects.toThrow(/^write outside claim: a change for t row \[5\] on shard s0 carries the image of t row \[7\]/);
    const prepared = await c.shard("s0").prepare({ txn: "t2", T, writes: [forged], spans: [], anchor: "s0", schema: cat.version });
    expect(prepared).toEqual({ ok: false, reason: expect.stringMatching(/^write outside claim: a change for t row \[5\]/) });
    expect(c.backends.get("s0")!.exec(`SELECT count(*) AS n FROM __intents`)[0]!.n).toBe(0);
    expect(await stored(c)).toEqual([]);
    expect(c.writeEscapes.map((e) => `${e.sql} ${e.row}`)).toEqual(["null t [5]", "null t [5]"]);
  });

  it("refuses a statement that writes a row of a range its shard has handed away, as a row it does not own", async () => {
    const c = new SimCluster({ shards: 1 });
    const db = c.client();
    await db.ddl("CREATE TABLE t(id INTEGER PRIMARY KEY, v INTEGER NOT NULL)");
    await split(c, "s0", "s1", { range: planSplit((await c.catalog()).routing, "s0")! });
    const cat = await c.catalog();
    const on = (shard: string) => { for (let i = 1; ; i++) if (ownerOf(cat.routing, keyString([i])) === shard) return i; };
    const [mine, gone] = [on("s0"), on("s1")];
    const row: Span = { kind: "pk", table: "t", pk: keyString([mine]), sk: keyString([mine]) };
    await expect(c.shard("s0").execAuto({
      sql: "INSERT INTO t VALUES (?, 1), (?, 2)", params: [mine, gone], spans: [row], schema: cat.version, write: { sk: null, capture: "insert" },
    })).rejects.toThrow(new RegExp(`^write outside claim: shard s0 does not own t row \\[${gone}\\] \\(not owner: s1\\)`));
    expect(await stored(c)).toEqual([]);
    expect(c.writeEscapes.map((e) => e.row)).toEqual([`t [${gone}]`]);
  });

  it("reads a whole-table span as covering only the rows inside its claim", async () => {
    const c = new SimCluster({ shards: 2 });
    const db = c.client();
    await db.ddl("CREATE TABLE t(id INTEGER PRIMARY KEY, v INTEGER NOT NULL)");
    const cat = await c.catalog();
    const on = (shard: string) => { for (let i = 1; ; i++) if (ownerOf(cat.routing, keyString([i])) === shard) return i; };
    const [mine, theirs] = [on("s0"), on("s1")];
    // s0 の claim は、s0 が範囲表で持つ区間である。s1 の行は、s0 が手放したことのない token だが、claim の外にある。
    const claim = regionsOf(cat.routing, "s0");
    expect(claim.some((x) => { const t = tokenOf(keyString([theirs]), keyString([theirs])); return t >= x.start && t < x.end; })).toBe(false);
    const wide: Span = { kind: "table", table: "t", claim };
    const req = { sql: "INSERT INTO t VALUES (?, 1)", schema: cat.version, write: { sk: null } };
    await c.shard("s0").execAuto({ ...req, params: [mine], spans: [wide] });
    await expect(c.shard("s0").execAuto({ ...req, params: [theirs], spans: [wide] }))
      .rejects.toThrow(new RegExp(`^write outside claim: the statement wrote t row \\[${theirs}\\]`));
    expect(await stored(c)).toEqual([`${mine}@s0`]);
    expect(c.writeEscapes.map((e) => e.row)).toEqual([`t [${theirs}]`]);
  });
});
