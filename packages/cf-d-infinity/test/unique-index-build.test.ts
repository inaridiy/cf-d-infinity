// 行のある表にシャードをまたぐ UNIQUE の index を作っている間、まだ出来上がっていない index を、読みも書き込みも使わない。
//
// 2026-11 までは、index を記録した時点から、Worker の SQLite が利用者の表定義どおりに UNIQUE を持ち、書き込みが index の表を
// 引いていた。既存の行に重複があれば DDL は失敗して取り消されるが、その前に実行された文は、存在しないことになる index を
// もとに、結果を変えていた (読みが UNIQUE 違反で失敗する、INSERT OR REPLACE が行を消す)。
//
// いまは、index を作り始める版が表を書き込み禁止にし、index は公開まで見えない (specs/m12_unique_index_build.qnt)。
// 読みは index と無関係に答え、書き込みは作り終えるまで待つ。作る側が止まっても、期限が来れば取り消される。
import { describe, expect, it } from "vitest";
import { Db, type ClientFaults } from "../src/client/db";
import { ownerOf } from "../src/routing";
import { encode } from "../src/shard/rows";
import type { Faults } from "../src/types";
import { INDEX_LEASE_MS } from "../src/meta";
import { duplicates, hold, indexAgreement, rawRows, tenantOn } from "./ddl-harness";
import { SimCluster } from "./sim";

const outcome = (p: Promise<unknown>) => p.then(() => "ok", (e: Error) => e.message);
const TABLE = "CREATE TABLE t(tenant_id INTEGER NOT NULL, id INTEGER NOT NULL, v INTEGER, PRIMARY KEY (tenant_id, id)) SHARD KEY (tenant_id)";
/** indexAgreement の `値 -> 行` から値だけを取る。 */
const values = (list: string[]) => list.map((x) => x.split(" -> ")[0]);

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
    // 作る側の延長は、この試験の都合で止めておく。作る側が要求の途中で止まった (Worker が落ちた) のと同じになる。
    // 延長が続く場合は、下の「a build that keeps renewing」が確かめる。
    const builder = new Db(Object.assign(Object.create(c) as SimCluster, { renewLock: () => new Promise<{ leaseMs: number }>(() => {}) }));
    const ddl = builder.ddl("CREATE UNIQUE INDEX u ON t(v)").then(() => "ok", (e: Error) => e.message);
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

  it("is withdrawn when the statement that builds it stops renewing its lease, and the waiting write goes through", async () => {
    const { c, A, paused, ddl, original } = await setup();
    const before = c.time;
    // 作る側は止まったまま戻ってこない (setup の作る側は、延長を止めてある)。書き込みは、Meta が取り消すまで待つ。
    await new Db(c).query("INSERT INTO t VALUES (?, 9, 8)", [A]);
    expect(c.time - before).toBeGreaterThanOrEqual(INDEX_LEASE_MS / 2);
    expect(c.time - before).toBeLessThan(INDEX_LEASE_MS * 2);
    const cat = await c.catalog();
    expect({ building: cat.tables.t!.building, built: cat.tables.t!.globalIndexes, listed: cat.indexes.u }).toEqual({ building: undefined, built: [], listed: undefined });
    // 遅れて戻ってきた作る側は、公開できない。取り消された理由を受け取る。
    paused.release();
    expect(await ddl).toMatch(/stopped before it finished and was withdrawn/);
    expect(await rows(c)).toEqual([...original, { tenant_id: A, id: 9, v: 8 }].sort((x, y) => x.tenant_id - y.tenant_id || x.id - y.id));
    expect((await c.catalog()).tables.t!.globalIndexes).toEqual([]);
  });
});

// specs/m11_schema_change.qnt の m11_red_early_public。index は、既存の行の項目を全部書き終えてから公開する (PUBLIC_LAST)。
// モデルの反例と同じ順で流す: 行が 1 つある表に index を記録し (issue)、行の項目を書く前に公開する (publish)。公開された index は、
// その行の項目を持たない。M11 の index は (値, 行) の集合で、実装は M12 の、書き込みを止めて作る形だが、公開の位置の守りは同じである。
describe("a UNIQUE index that spans shards is published after the existing rows are indexed (m11_red_early_public)", () => {
  const scenario = async (clientFaults?: ClientFaults) => {
    const c = new SimCluster({ shards: 2, clientFaults });
    await new Db(c).ddl(TABLE);
    const A = await tenantOn(c, "s0");
    const B = await tenantOn(c, "s1");
    await new Db(c).query("INSERT INTO t VALUES (?, 1, 7)", [A]);
    const ddl = await outcome(new Db(c).ddl("CREATE UNIQUE INDEX u ON t(v)"));
    const cat = await c.catalog();
    const published = cat.tables.t!.globalIndexes.map((g) => g.name);
    // 公開の後に、別のシャードの行が同じ値を書く。一意性は、公開された index で確かめる。
    const write = await outcome(new Db(c).query("INSERT INTO t VALUES (?, 1, 7)", [B]));
    await c.settle();
    // index の項目が指していない行。index を使う文 (一意性の確認、値で引く読み) からは見えない。
    // indexAgreement は値で引く読みも確かめるが、重複が入ると、その読みは Worker の SQLite の UNIQUE で失敗するので、項目だけを比べる。
    const entries = new Map((await rawRows(c, "__gidx_u")).map(({ row }) => [row.k, row.pk]));
    const unindexed = (await rawRows(c, "t")).filter(({ row }) => entries.get(encode([row.v ?? null])) !== encode([row.tenant_id ?? null, row.id ?? null]))
      .map(({ row }) => (row.tenant_id === A ? "A" : "B"));
    return { ddl, published, write, unindexed, duplicates: (await duplicates(c, "t", "v")).length };
  };

  it("refuses a value that a row had before the index was built", async () => {
    const r = await scenario();
    expect(r).toEqual({ ddl: "ok", published: ["u"], write: expect.stringMatching(/UNIQUE constraint failed/), unindexed: [], duplicates: 0 });
  });

  it("put back: published before the rows are indexed, the index misses the row and a duplicate value goes in", async () => {
    const r = await scenario({ publishBeforeBackfill: true });
    expect(r).toEqual({ ddl: "ok", published: ["u"], write: "ok", unindexed: ["A"], duplicates: 1 });
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

// specs/m12_unique_index_build.qnt の m12_red_scan_early。既存の行を読む要求は、index を記録した版 (表を書き込み禁止にする版) を
// 名乗る。シャードはその版を適用してから答えるので、読んだ後で、その行は変わらない (SCAN_AT_VERSION)。実装では、先に全シャードへ
// その版を適用させることでも守っている。モデルの反例と同じ順で流す: index を記録する (ddlStart)。s0 の行を、s0 がまだ禁止を
// 適用していないうちに読む (backfill)。index を知らない Worker が、その行の値を書き換えて確定する (plan、prepare、commit)。
// 各シャードが版を適用し (applyVer)、s1 の行を読み、公開する。
describe("the rows are read for the index only after their shard applied the write lock (m12_red_scan_early)", () => {
  const scenario = async (clientFaults?: ClientFaults) => {
    const c = new SimCluster({ shards: 2, clientFaults });
    await new Db(c).ddl(TABLE);
    const A = await tenantOn(c, "s0");
    const B = await tenantOn(c, "s1");
    await new Db(c).query("INSERT INTO t VALUES (?, 1, 7)", [A]);
    await new Db(c).query("INSERT INTO t VALUES (?, 1, 8)", [B]);
    // 書く側は、index を記録する前の表定義を持っている (記録をまだ知らない Worker。モデルの cv = 0 の計画)。
    const writer = new Db(c, { catalog: await c.catalog() });
    // 1 つ目のシャード (s0) の行を読み終え、2 つ目のシャードを読むところで、作成を止める。
    let scans = 0;
    const paused = hold(c, "gate", (m) => m.from === "client" && m.method === "exec" && /FROM "t"\s+ORDER BY/.test((m.req as { sql: string }).sql) && ++scans === 2);
    const ddl = outcome(new Db(c).ddl("CREATE UNIQUE INDEX u ON t(v)"));
    await paused.reached;
    const write = outcome(writer.query("UPDATE t SET v = 9 WHERE tenant_id = ? AND id = 1", [A]));
    const early = await Promise.race([write, c.sleep(500).then(() => "waiting")]);
    paused.release();
    const out = { early, ddl: await ddl, write: await write };
    await c.settle();
    const ix = await indexAgreement(c, "t", "u");
    return { ...out, missing: values(ix.missing), dangling: values(ix.dangling) };
  };

  it("makes the write that comes after the read wait for the index, so the index matches the rows", async () => {
    expect(await scenario()).toEqual({ early: "waiting", ddl: "ok", write: "ok", missing: [], dangling: [] });
  });

  it("put back: a shard read before it applied the lock takes the write, and the index keeps the value the row no longer has", async () => {
    expect(await scenario({ scanBeforeLock: true })).toEqual({ early: "ok", ddl: "ok", write: "ok", missing: [encode([9])], dangling: [encode([7])] });
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

// specs/m12_unique_index_build.qnt の m12_clock_red_skip_empty。公開の時刻は、行を読んだシャードの時計の最大である。行のないシャードも
// 読み、その時計を入れる (SCAN_EVERY_SHARD)。そのシャードで、行を消した書き込みの時刻も、公開の時刻より前に来なければならない。
// モデルの反例と同じ順で流す: 時計の進んだ s1 で、index を使わない書き込みが確定する (ここでは行を消す)。index を記録し、各シャードが
// 版を適用する。行のある s0 だけを読み、公開する。s0 が公開の版を適用し、index を使う文が s0 で読む時刻を決める。
// 実装は、行がないことを読んで知るので、欠陥のスイッチは、行のないシャードの時計を捨てる形で、読まなかったのと同じにする。
describe("the publication timestamp of a UNIQUE index includes the clocks of shards with no rows (m12_clock_red_skip_empty)", () => {
  /** s1 の時計は s0 より 5 秒進んでいる。s1 の行を index なしに消してから index を作る。index を作るとき、s1 に表の行はない。 */
  const afterPublish = async (clientFaults?: ClientFaults) => {
    const c = new SimCluster({ shards: 2, skewMs: (id) => (id === "s1" ? 5000 : 0), clientFaults });
    await new Db(c).ddl(TABLE);
    const A = await tenantOn(c, "s0");
    const B = await tenantOn(c, "s1");
    // index の項目が s0 に載る値を選ぶ。項目を書く取引が s1 に触れると、その確定の時刻に s1 の時計が入る。
    const { routing } = await c.catalog();
    const onS0 = (from: number) => {
      let v = from;
      while (ownerOf(routing, encode([encode([v])])) !== "s0") v++;
      return v;
    };
    const v = onS0(1);
    const w = onS0(v + 1);
    await new Db(c).query("INSERT INTO t VALUES (?, 1, ?)", [A, w]);
    await new Db(c).query("INSERT INTO t VALUES (?, 1, ?)", [B, v]);
    const legacy = await new Db(c).query("DELETE FROM t WHERE tenant_id = ? AND id = 1", [B]);
    await new Db(c).ddl("CREATE UNIQUE INDEX u ON t(v)");
    const tx = await new Db(c).begin();
    const outcome = await tx.query("INSERT INTO t VALUES (?, 2, ?)", [A, v]).then(() => "ok", (e: Error) => e.message);
    return { legacy: legacy.ts!, aware: tx.T!, outcome };
  };

  it("puts the statement that uses the index after the delete on the shard that had no rows", async () => {
    const { legacy, aware, outcome } = await afterPublish();
    expect(outcome).toBe("ok");
    expect(aware).toBeGreaterThanOrEqual(legacy);
  });

  it("put back: without that shard's clock, the statement that uses the index reads before the delete in timestamp order", async () => {
    const { legacy, aware, outcome } = await afterPublish({ scanSkipsEmpty: true });
    // 時刻の順では、この INSERT は、s1 の行 (同じ値) を足して消した書き込みより前にある。そこで同じ値の行が 2 つになる。
    expect(outcome).toBe("ok");
    expect(aware).toBeLessThan(legacy);
  });
});

describe("the lease on a table whose rows are being indexed", () => {
  const slowBuild = async (o: { leaseMs?: number; buildMaxMs?: number }) => {
    const c = new SimCluster({ shards: 2, ...o });
    const db = new Db(c);
    await db.ddl("CREATE TABLE t(tenant_id INTEGER NOT NULL, id INTEGER NOT NULL, v INTEGER, PRIMARY KEY (tenant_id, id)) SHARD KEY (tenant_id)");
    await db.query("INSERT INTO t VALUES (1, 1, 1), (2, 1, 2), (3, 1, 3)");
    // 行を読む要求を、1 回ごとに 2 秒遅らせる。作る作業が、期限より長くかかる。
    c.net.gate = (m) => (m.from === "client" && m.method === "exec" && /FROM "t"\s+ORDER BY/.test((m.req as { sql: string }).sql) ? c.sleep(2_000) : undefined);
    const t0 = c.time;
    const out = await db.ddl("CREATE UNIQUE INDEX u ON t(v)").then(() => "ok", (e: Error) => e.message);
    return { out, took: c.time - t0, cat: await c.catalog() };
  };

  it("is kept while a build that takes longer than the lease keeps renewing it", async () => {
    const r = await slowBuild({ leaseMs: 1_000 });
    expect(r.took).toBeGreaterThan(3_000);
    expect(r.out).toBe("ok");
    expect(r.cat.tables.t!.globalIndexes.map((g) => g.name)).toEqual(["u"]);
  });

  it("ends at its upper bound even while the build keeps renewing it", async () => {
    const r = await slowBuild({ leaseMs: 1_000, buildMaxMs: 3_000 });
    expect(r.out).toMatch(/did not finish within 3 seconds and was withdrawn/);
    expect({ building: r.cat.tables.t!.building, built: r.cat.tables.t!.globalIndexes }).toEqual({ building: undefined, built: [] });
  });
});
