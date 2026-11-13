// 同じ baton の続きが 2 つあっても、確定と答えた書き込みは必ず入る (不変条件 12、specs/m17_txn_id_reuse.qnt)。
//
// baton は署名されているが、使い捨てではない。取引の ID もそのまま戻るので、BEGIN の直後の baton から 2 つの続きを作れる
// (HTTP の再送でも起き得る)。2026-11-12 の入口の安全の確認 (指摘 2) で、anchor が取引の ID だけで決着を覚え、2 つ目の続きの
// COMMIT に 1 つ目の結果を返すことが分かった。2 つ目の書き込みは入らない。その日の修正は、確定の記録と intent の中身で、
// 同じ ID の別の続きを断った。2026-11-13 の Codex の見直し (指摘 C1) で、2 つの続きが同時に COMMIT すると、断られた側の中止が
// ID だけで参加者の intent を消し、確定した側の書き込みが消えることが分かった (モデルの m17_red_abort)。
// いまは、2PC の ID を「取引の ID と、続きの中身の指紋」にする (Txn.commit)。2 つの続きは別々の 2PC で、同じ行を書けば普通の
// 競合で片方が断られ、違う行なら両方が確定する。同じ中身の再送は同じ ID なので、同じ答えになる。
import { describe, expect, it } from "vitest";
import { Db, type ClientFaults } from "../src/client/db";
import type { Faults } from "../src/types";
import { handlePipeline, type PipelineReq } from "../src/client/hrana";
import { keyString } from "../src/keys";
import { ownerOf } from "../src/routing";
import { prng, seedsOr, SimCluster } from "./sim";

const step = (c: SimCluster, baton: string | null, sql: string[]) =>
  handlePipeline({ baton, requests: sql.map((s) => ({ type: "execute", stmt: { sql: s } })) } as PipelineReq, async (token) => new Db(c, { token })) as Promise<{
    baton: string | null; results: { type: string; error?: { message: string } }[];
  }>;

/** BEGIN の直後の baton から、それぞれ 2 つのシャードに書いて COMMIT する続きを 2 つ作り、順に流す。 */
async function twoContinuations(clientFaults: ClientFaults, same = false) {
  const c = new SimCluster({ shards: 2, clientFaults });
  await new Db(c).ddl("CREATE TABLE t(id INTEGER PRIMARY KEY, v TEXT)");
  const { routing } = await c.catalog();
  const on = (s: string, from: number) => { for (let i = from; ; i++) if (ownerOf(routing, keyString([i])) === s) return i; };
  const [a0, a1, b0, b1] = [on("s0", 1), on("s1", 1), on("s0", 100), on("s1", 100)];
  if (same) {
    // COMMIT の再送: 書き込みを済ませた baton から、COMMIT だけを 2 回送る。中身が同じなので 2PC の ID も同じで、2 回目は
    // anchor の記録から同じ答えを返す。(文ごと送り直すのは再送ではなく、取引の実行し直しである。1 つ目が確定していれば、
    // 2 つ目は UNIQUE の違反か競合になる。)
    const begun = await step(c, null, ["BEGIN", `INSERT INTO t VALUES (${a0}, 'a')`, `INSERT INTO t VALUES (${a1}, 'a')`]);
    const a = await step(c, begun.baton, ["COMMIT"]);
    const b = await step(c, begun.baton, ["COMMIT"]);
    await c.settle();
    const rows = (await new Db(c).query("SELECT id FROM t ORDER BY id")).rows.map((r) => r.id as number);
    const committed = (r: typeof a) => r.results.every((x) => x.type === "ok");
    return { committed: [committed(a), committed(b)], rows, a: [a0, a1], b: [b0, b1] };
  }
  const begun = await step(c, null, ["BEGIN"]);
  const a = await step(c, begun.baton, [`INSERT INTO t VALUES (${a0}, 'a')`, `INSERT INTO t VALUES (${a1}, 'a')`, "COMMIT"]);
  const b = await step(c, begun.baton, [`INSERT INTO t VALUES (${b0}, 'b')`, `INSERT INTO t VALUES (${b1}, 'b')`, "COMMIT"]);
  await c.settle();
  const rows = (await new Db(c).query("SELECT id FROM t ORDER BY id")).rows.map((r) => r.id as number);
  const committed = (r: typeof a) => r.results.every((x) => x.type === "ok");
  return { committed: [committed(a), committed(b)], rows, a: [a0, a1], b: [b0, b1] };
}

/**
 * BEGIN の直後の baton から、両方のシャードに書いて COMMIT する続きを 2 つ作り、同時に流す。RPC の遅れを seed で変えて、
 * 2 つの COMMIT の段を混ぜる (specs/m17_txn_id_reuse.qnt の m17_red_abort、2026-11-13 の Codex の指摘 C1)。
 * 確定と答えた続きの行は、全部入っていなければならない。もう 1 つの続きの行は、確定と答えていなければ 1 つも入らない。
 */
async function concurrentContinuations(seed: number, clientFaults: ClientFaults = {}) {
  const c = new SimCluster({ shards: 2, clientFaults, seed });
  const rnd = prng(seed);
  c.net.jitter = () => (rnd() < 0.3 ? 0 : rnd() * 4);
  await new Db(c).ddl("CREATE TABLE t(id INTEGER PRIMARY KEY, v TEXT)");
  const { routing } = await c.catalog();
  const on = (s: string, from: number) => { for (let i = from; ; i++) if (ownerOf(routing, keyString([i])) === s) return i; };
  const ids = { a: [on("s0", 1), on("s1", 1)], b: [on("s0", 100), on("s1", 100)] };
  const begun = await step(c, null, ["BEGIN"]);
  const [a, b] = await Promise.all((["a", "b"] as const).map((k) =>
    step(c, begun.baton, [`INSERT INTO t VALUES (${ids[k][0]}, '${k}')`, `INSERT INTO t VALUES (${ids[k][1]}, '${k}')`, "COMMIT"])));
  await c.settle();
  const rows = (await new Db(c).query("SELECT id FROM t ORDER BY id")).rows.map((r) => r.id as number);
  const committed = (r: { results: { type: string }[] }) => r.results.every((x) => x.type === "ok");
  const problems: string[] = [];
  for (const [k, r] of [["a", a!], ["b", b!]] as const) {
    const have = ids[k].filter((id) => rows.includes(id)).length;
    if (committed(r) && have !== 2) problems.push(`seed ${seed}: continuation ${k} was told committed but ${2 - have} of its rows are missing`);
    if (!committed(r) && have !== 0) problems.push(`seed ${seed}: continuation ${k} was refused but ${have} of its rows are present`);
  }
  return problems;
}

describe("two continuations of one baton committing at once (m17_red_abort)", () => {
  it("never loses the rows of the continuation told committed", async () => {
    const problems: string[] = [];
    for (const seed of seedsOr(Array.from({ length: 60 }, (_v, i) => i + 1))) problems.push(...await concurrentContinuations(seed));
    expect(problems.slice(0, 5)).toEqual([]);
  }, 120000);

  it("put back m17_red_impl: with the transaction id as the 2PC id, some ordering loses committed rows", async () => {
    let lost = 0;
    for (let seed = 1; seed <= 60 && lost === 0; seed++) lost += (await concurrentContinuations(seed, { commitIdIsTxn: true })).length;
    expect(lost).toBeGreaterThan(0);
  }, 120000);
});

/**
 * 書き込みを済ませた baton から、COMMIT だけを 2 回、同時に送る (再送が元の COMMIT を追い越す)。2 つは同じ中身なので、同じ 2PC の
 * ID の 2 つの実行になる (specs/m17_txn_id_reuse.qnt の m17_red_resend、2026-11-13 の Codex の 2 回目の見直し、指摘 1)。
 * 確定と答えたなら、書き込みは全部入る。どちらも同じ答え (確定) にならなければならない。
 */
async function concurrentResends(seed: number, faults: Faults = {}) {
  const c = new SimCluster({ shards: 3, seed, faults });
  const rnd = prng(seed);
  c.net.jitter = () => (rnd() < 0.3 ? 0 : rnd() * 4);
  await new Db(c).ddl("CREATE TABLE t(id INTEGER PRIMARY KEY, v TEXT)");
  const { routing } = await c.catalog();
  const ids = ["s0", "s1", "s2"].map((s) => { for (let i = 1; ; i++) if (ownerOf(routing, keyString([i])) === s) return i; });
  const begun = await step(c, null, ["BEGIN", ...ids.map((id) => `INSERT INTO t VALUES (${id}, 'r')`)]);
  const [a, b] = await Promise.all([step(c, begun.baton, ["COMMIT"]), step(c, begun.baton, ["COMMIT"])]);
  await c.settle();
  const rows = (await new Db(c).query("SELECT id FROM t ORDER BY id")).rows.map((r) => r.id as number);
  const told = [a!, b!].map((r) => (r.results.every((x) => x.type === "ok") ? "committed" : `failed ${r.results.find((x) => x.type !== "ok")?.error?.message}`));
  const problems: string[] = [];
  if (told.includes("committed") && rows.length !== ids.length) problems.push(`seed ${seed}: told ${told.join(" / ")} but ${ids.length - rows.length} rows are missing`);
  if (told.some((t) => t !== "committed")) problems.push(`seed ${seed}: a resent COMMIT of the committed transaction was told ${told.find((t) => t !== "committed")}`);
  return problems;
}

describe("the same COMMIT sent twice at once (m17_red_resend)", () => {
  it("commits once, tells both committed, and loses nothing", async () => {
    const problems: string[] = [];
    for (const seed of seedsOr(Array.from({ length: 60 }, (_v, i) => i + 1))) problems.push(...await concurrentResends(seed));
    expect(problems.slice(0, 5)).toEqual([]);
  }, 120000);

  it("put back m17_red_resend: drives of one id run at once and an abort ignores the record, and some ordering loses committed rows", async () => {
    let lost = 0;
    for (let seed = 1; seed <= 60 && lost === 0; seed++) lost += (await concurrentResends(seed, { concurrentDrives: true, abortIgnoresRecord: true })).filter((p) => /missing/.test(p)).length;
    expect(lost).toBeGreaterThan(0);
  }, 120000);
});

describe("a baton used twice, one continuation after the other (m17)", () => {
  it("commits both continuations as two transactions when they write different rows", async () => {
    const r = await twoContinuations({});
    expect(r.committed).toEqual([true, true]);
    expect(r.rows).toEqual(expect.arrayContaining([...r.a, ...r.b]));
  });

  it("gives a resent COMMIT the same answer, and writes the rows once", async () => {
    const r = await twoContinuations({}, true);
    expect(r.committed).toEqual([true, true]);
    expect(r.rows.filter((id) => r.a.includes(id))).toEqual([...r.a].sort((x, y) => x - y));
  });

  it("put back m17_red_impl: an anchor that knows only the transaction id tells the second continuation it committed, and loses its writes", async () => {
    const r = await twoContinuations({ commitIdIsTxn: true });
    expect(r.committed).toEqual([true, true]);
    expect(r.rows.some((id) => r.b.includes(id))).toBe(false);
  });
});
