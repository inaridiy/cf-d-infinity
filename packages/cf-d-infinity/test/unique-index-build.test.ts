// 行のある表にシャードをまたぐ UNIQUE の index を作っている間、まだ出来上がっていない index を、読みも書き込みも使わない。
//
// 2026-11 までは、index を記録した時点から、Worker の SQLite が利用者の表定義どおりに UNIQUE を持ち、書き込みが index の表を
// 引いていた。既存の行に重複があれば DDL は失敗して取り消されるが、その前に実行された文は、存在しないことになる index を
// もとに、結果を変えていた (読みが UNIQUE 違反で失敗する、INSERT OR REPLACE が行を消す)。
//
// いまは、index を作り始める版が表を書き込み禁止にし、index は公開まで見えない (specs/m12_unique_index_build.qnt)。
// 読みは index と無関係に答え、書き込みは作り終えるまで待つ。作る側が止まっても、期限が来れば取り消される。
import { describe, expect, it } from "vitest";
import { Db } from "../src/client/db";
import { ownerOf } from "../src/routing";
import { encode } from "../src/shard/rows";
import type { Faults } from "../src/types";
import { hold, indexAgreement, tenantOn } from "./ddl-harness";
import { SimCluster } from "./sim";

describe("CREATE UNIQUE INDEX on a table that already has duplicate values, while it is being built", () => {
  const setup = async () => {
    const c = new SimCluster({ shards: 2 });
    const db = new Db(c);
    await db.ddl("CREATE TABLE t(tenant_id INTEGER NOT NULL, id INTEGER NOT NULL, v INTEGER, PRIMARY KEY (tenant_id, id)) SHARD KEY (tenant_id)");
    const A = await tenantOn(c, "s0");
    const B = await tenantOn(c, "s1");
    // 重複がある。A/1 と B/1 が v = 7、A/2 と B/2 が v = 8。この index は作れない。
    await db.query("INSERT INTO t VALUES (?, 1, 7), (?, 2, 8)", [A, A]);
    await db.query("INSERT INTO t VALUES (?, 1, 7), (?, 2, 8)", [B, B]);
    // 既存の行を埋める処理を、2 つ目のシャードを読むところで止める。1 つ目のシャードの行は、もう項目を持っている。
    let scans = 0;
    const paused = hold(c, "gate", (m) => m.from === "client" && m.method === "exec" && /FROM "t"\s+ORDER BY/.test((m.req as { sql: string }).sql) && ++scans === 2);
    const ddl = db.ddl("CREATE UNIQUE INDEX u ON t(v)").then(() => "ok", (e: Error) => e.message);
    await paused.reached;
    const original = [{ tenant_id: A, id: 1, v: 7 }, { tenant_id: A, id: 2, v: 8 }, { tenant_id: B, id: 1, v: 7 }, { tenant_id: B, id: 2, v: 8 }];
    return { c, A, B, paused, ddl, original };
  };
  const rows = async (c: SimCluster) => (await new Db(c).query("SELECT tenant_id, id, v FROM t ORDER BY tenant_id, id")).rows;

  it("a read that gathers the table does not fail because of the index", async () => {
    const { c, paused, ddl } = await setup();
    const read = await new Db(c).query("SELECT count(*) AS pairs FROM t a JOIN t b ON a.v = b.v AND a.tenant_id < b.tenant_id")
      .then((r) => r.rows, (e: Error) => e.message);
    paused.release();
    await ddl;
    // 値が同じ行の組は 2 つある。index があってもなくても、読みの答えは変わらない。
    expect(read).toEqual([{ pairs: 2 }]);
  });

  it("a write waits for the build, and does not delete a row because of an index that is then withdrawn", async () => {
    const { c, A, paused, ddl, original } = await setup();
    // index がなければ、これは新しい行を足すだけである。作っている最中の index を信じると、v = 8 を持つ行を消してしまう。
    const write = new Db(c).query("INSERT OR REPLACE INTO t VALUES (?, 9, 8)", [A]).then(() => "ok", (e: Error) => e.message);
    expect(await Promise.race([write, c.sleep(500).then(() => "waiting")])).toBe("waiting");
    paused.release();
    expect(await ddl).toMatch(/UNIQUE constraint failed/);
    // DDL は失敗したので、index は無かったことになる。待っていた書き込みは、行を足すだけである。
    expect(await write).toBe("ok");
    expect(await rows(c)).toEqual([...original, { tenant_id: A, id: 9, v: 8 }].sort((x, y) => x.tenant_id - y.tenant_id || x.id - y.id));
  });

  it("is withdrawn at its deadline when the statement that builds it stops, and the waiting write goes through", async () => {
    const { c, A, paused, ddl, original } = await setup();
    const before = c.time;
    // 作る側は、止まったまま戻ってこない。書き込みは、期限が来て Meta が取り消すまで待つ。
    await new Db(c).query("INSERT INTO t VALUES (?, 9, 8)", [A]);
    expect(c.time - before).toBeGreaterThanOrEqual(30_000);
    const cat = await c.catalog();
    expect({ building: cat.tables.t!.building, built: cat.tables.t!.globalIndexes, listed: cat.indexes.u }).toEqual({ building: undefined, built: [], listed: undefined });
    // 遅れて戻ってきた作る側は、公開できない。取り消された理由を受け取る。
    paused.release();
    expect(await ddl).toMatch(/did not finish within 30 seconds and was withdrawn/);
    expect(await rows(c)).toEqual([...original, { tenant_id: A, id: 9, v: 8 }].sort((x, y) => x.tenant_id - y.tenant_id || x.id - y.id));
    expect((await c.catalog()).tables.t!.globalIndexes).toEqual([]);
  });
});

describe("a table whose rows are being indexed", () => {
  /** 1 つ目のシャードの行を読み終えたところで作成を止め、読み終えた行の値を書き換える。 */
  const writeAfterScan = async (faults?: Faults) => {
    const c = new SimCluster({ shards: 2, faults });
    const db = new Db(c);
    await db.ddl("CREATE TABLE t(tenant_id INTEGER NOT NULL, id INTEGER NOT NULL, v INTEGER, PRIMARY KEY (tenant_id, id)) SHARD KEY (tenant_id)");
    const A = await tenantOn(c, "s0");
    const B = await tenantOn(c, "s1");
    await db.query("INSERT INTO t VALUES (?, 1, 7)", [A]);
    await db.query("INSERT INTO t VALUES (?, 1, 8)", [B]);
    let scans = 0;
    const paused = hold(c, "gate", (m) => m.from === "client" && m.method === "exec" && /FROM "t"\s+ORDER BY/.test((m.req as { sql: string }).sql) && ++scans === 2);
    const ddl = db.ddl("CREATE UNIQUE INDEX u ON t(v)").then(() => "ok", (e: Error) => e.message);
    await paused.reached;
    const write = new Db(c).query("UPDATE t SET v = 9 WHERE tenant_id = ? AND id = 1", [A]).then(() => "ok", (e: Error) => e.message);
    const early = await Promise.race([write, c.sleep(500).then(() => "waiting")]);
    paused.release();
    const out = { early, ddl: await ddl, write: await write };
    // 確定した書き込みが、全部のシャードに適用されるのを待ってから、行と index を比べる。
    await c.settle();
    const ix = await indexAgreement(c, "t", "u");
    const values = (list: string[]) => list.map((x) => x.split(" -> ")[0]);
    return { ...out, missing: values(ix.missing), dangling: values(ix.dangling) };
  };

  it("is not written until the index is public, so the index matches the rows", async () => {
    expect(await writeAfterScan()).toEqual({ early: "waiting", ddl: "ok", write: "ok", missing: [], dangling: [] });
  });

  it("put back: a shard that accepts the write leaves the index with the value the row no longer has", async () => {
    expect(await writeAfterScan({ ignoreTableLock: true })).toEqual({ early: "ok", ddl: "ok", write: "ok", missing: ["[9]"], dangling: ["[7]"] });
  });
});

// index の公開は、文の意味を変える。だから、時刻の順の中に 1 点を持つ。index を使わずに確定した書き込みは、その点より前で、
// index を使う文は、その点より後である。公開の版が時刻を運び、シャードは、その版を適用するときに時計をそこまで進める。
describe("the publication of a UNIQUE index that spans shards", () => {
  /** s1 の時計は s0 より 5 秒進んでいる。s1 で index なしに書いた値を、index が出来た後で、s0 だけを触る文が使おうとする。 */
  const afterPublish = async (faults?: Faults) => {
    const c = new SimCluster({ shards: 2, skewMs: (id) => (id === "s1" ? 5000 : 0), faults });
    await new Db(c).ddl("CREATE TABLE t(tenant_id INTEGER NOT NULL, id INTEGER NOT NULL, v INTEGER, PRIMARY KEY (tenant_id, id)) SHARD KEY (tenant_id)");
    const A = await tenantOn(c, "s0");
    const B = await tenantOn(c, "s1");
    // index の項目が s0 に載る値を選ぶ。
    const { routing } = await c.catalog();
    let v = 1;
    while (ownerOf(routing, encode([encode([v])])) !== "s0") v++;
    const legacy = await new Db(c).query("INSERT INTO t VALUES (?, 1, ?)", [B, v]);
    await new Db(c).ddl("CREATE UNIQUE INDEX u ON t(v)");
    const tx = await new Db(c).begin();
    const outcome = await tx.query("INSERT INTO t VALUES (?, 1, ?)", [A, v]).then(() => "ok", (e: Error) => e.message);
    return { legacy: legacy.ts!, aware: tx.T!, outcome };
  };

  it("puts every statement that uses the index after the writes that were made without it", async () => {
    const { legacy, aware, outcome } = await afterPublish();
    expect(outcome).toMatch(/UNIQUE constraint failed/);
    expect(aware).toBeGreaterThanOrEqual(legacy);
  });

  it("put back: without the timestamp, a statement fails on a row that, in timestamp order, is not there yet", async () => {
    const { legacy, aware, outcome } = await afterPublish({ publishWithoutClock: true });
    expect(outcome).toMatch(/UNIQUE constraint failed/);
    expect(aware).toBeLessThan(legacy);
  });
});
