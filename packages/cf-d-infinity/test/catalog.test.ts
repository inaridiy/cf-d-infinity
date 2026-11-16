// Meta の epoch の列 (src/catalog.ts) と、その上に載せた Meta (src/meta.ts) の試験。docs/design-catalog-epoch.md の段 1 から段 3。
//
// 段 1 と段 2 の間は、段 1 より前の Meta (test/meta-old.ts) と答えを比べる乱択の検査がここにあった。段 3 で表定義の変更が 2 相に
// なり、比べる入口 (applyDdl、revokeDdl、publishIndex、lockTables、finishLock、renewLock) が新しい Meta にない。残る入口
// (catalog、分割の枠) の答えも、表定義の版の数と取り消しの印がなくなり、表定義の epoch が prepare と abort でも進むので、比べられない。
// 古い Meta の写しは消した。表定義の遷移の条件は、M21 と突き合わせる test/catalog-m21.test.ts と、下の試験が確かめる。
import { describe, expect, it } from "vitest";
import { movesToResume, split } from "../src/autoscaler";
import { fold, refusal, type Logged } from "../src/catalog";
import { Db } from "../src/client/db";
import { MetaCore, readEpochs } from "../src/meta";
import { planSplit, REGION_TOKENS } from "../src/routing";
import { driver } from "./ddl-driver";
import { SimCluster, SqliteBackend, VirtualRuntime } from "./sim";

/** 答えを比べられる文字列にする。誤りは、型の名前と文。 */
async function outcome(f: () => unknown): Promise<string> {
  try {
    const v = await f();
    return `ok ${JSON.stringify(v) ?? "undefined"}`;
  } catch (e) {
    const err = e as Error;
    return `throws ${err.constructor.name}: ${err.message}`;
  }
}

/** Meta だけで、DDL を prepare から commit まで進める (どのシャードも ok と答えたものとする)。 */
async function ddl(meta: MetaCore, sql: string, shards = ["s0", "s1"]) {
  const p = await meta.prepare(sql, {}, (await meta.catalog()).schema);
  return p.epoch === null ? p.catalog : meta.commit(p.epoch, shards);
}

describe("the epoch log", () => {
  it("stores one record per epoch: the first range table at 0, then prepare and commit, the start and the end of a move", async () => {
    const b = new SqliteBackend();
    const meta = new MetaCore(b, ["s0", "s1"], { runtime: new VirtualRuntime(1) });
    await ddl(meta, "CREATE TABLE t(id INTEGER PRIMARY KEY, a TEXT)");
    const range = planSplit((await meta.catalog()).routing, "s0")!;
    const { epoch } = await meta.startMove({ from: "s0", to: "s2", ...range });
    // 同じ移動をもう一度開いても、記録は増えない。
    expect(await meta.startMove({ from: "s0", to: "s2", ...range })).toMatchObject({ epoch });
    // 移動が開いている間は、表定義の遷移を開かない (M21 の DDL_WAITS_MOVE)。
    expect(await outcome(() => meta.prepare("CREATE INDEX ta ON t(a)"))).toMatch(/^throws SchemaBusy: schema busy: a shard split of s0/);
    await meta.endMove(epoch);
    await meta.endMove(epoch);
    await ddl(meta, "CREATE INDEX ta ON t(a)", ["s0", "s1", "s2"]);
    expect(readEpochs(b).map((x) => [x.epoch, x.rec.kind, "of" in x.rec ? x.rec.of : null])).toEqual([
      [0, "genesis", null], [1, "prepare", null], [2, "commit", 1], [3, "move-start", null], [4, "move-end", 3], [5, "prepare", null], [6, "commit", 5],
    ]);
    // 移動の途中の epoch の範囲表は、子を指し、移動が開いている。
    const during = fold(readEpochs(b), 3);
    expect(during.routing.version).toBe(2);
    expect(during.moves).toEqual([{ epoch: 3, from: "s0", to: "s2", ...range }]);
    expect(fold(readEpochs(b), 4).moves).toEqual([]);
    // 表定義の epoch は、表定義の記録 (prepare、commit、abort) でだけ進む (設計書の決めたこと 6)。
    expect([1, 2, 3, 4, 5, 6].map((e) => fold(readEpochs(b), e).schema)).toEqual([1, 2, 2, 2, 5, 6]);
    // commit された文だけが、Worker の SQLite で再生する履歴に入る。
    expect(fold(readEpochs(b), 5).ddl).toEqual(["CREATE TABLE t(id INTEGER PRIMARY KEY, a TEXT)"]);
  });

  it("opens a transition at prepare, fences its tables, and closes it at commit or abort", async () => {
    const b = new SqliteBackend();
    const meta = new MetaCore(b, ["s0", "s1"], { runtime: new VirtualRuntime(1) });
    await ddl(meta, "CREATE TABLE t(id INTEGER PRIMARY KEY, a TEXT)");
    const build = await meta.prepare("CREATE UNIQUE INDEX ta ON t(a)");
    expect(build.mode).toBe("build");
    expect(fold(readEpochs(b)).open).toMatchObject({ epoch: 3, mode: "build", fence: ["t"] });
    // 作っている最中の index は、表定義に入らない。index の表 (staging) だけが載る。
    expect(build.catalog.indexes.ta).toBeUndefined();
    expect(build.catalog.tables.t!.globalIndexes).toEqual([]);
    expect(Object.keys(build.catalog.tables)).toEqual(["t", "__gidx_ta"]);
    expect(build.catalog.open).toEqual({ epoch: 3, mode: "build", fence: ["t"], index: "ta" });
    // 遷移は 1 つずつ開く。
    expect(await outcome(() => meta.prepare("DROP TABLE t"))).toMatch(/^throws SchemaBusy: schema busy: CREATE INDEX ta is in progress/);
    // 全シャードの ok がそろう前には確定しない。
    expect(await outcome(() => meta.commit(3, ["s0"]))).toMatch(/^throws SqlError: the schema change of epoch 3 was not prepared on s1/);
    const done = await meta.commit(3, ["s0", "s1"], 7);
    expect({ open: done.open, index: done.indexes.ta, built: done.tables.t!.globalIndexes.map((g) => g.name) }).toEqual({ open: undefined, index: { table: "t", global: true }, built: ["ta"] });
    expect(readEpochs(b).at(-1)!.rec).toEqual({ kind: "commit", of: 3, at: 7 });
    // 取引が読んだ表の DROP は mode guard で、abort で禁止が解ける。abort の後の commit は通らない (M21 の ONE_EXIT)。
    const guard = await meta.prepare("DROP TABLE t", { guard: ["t"] });
    expect({ mode: guard.mode, open: guard.catalog.open }).toEqual({ mode: "guard", open: { epoch: 5, mode: "guard", fence: ["t"] } });
    expect(await meta.abort(5, "changed")).toEqual({ reason: "changed" });
    const s = fold(readEpochs(b));
    expect({ open: s.open, aborted: s.aborted, t: s.tables.t !== undefined }).toEqual({ open: null, aborted: { of: 5, reason: "changed" }, t: true });
    expect(await outcome(() => meta.commit(5, ["s0", "s1"]))).toBe("throws SqlError: changed");
    // もう abort された遷移の abort は、記録せずに、記録した理由を返す。commit された遷移は取り消せない。
    expect(await meta.abort(5, "later")).toEqual({ reason: "changed" });
    expect(await outcome(() => meta.abort(3, "late"))).toMatch(/^throws SqlError: cannot withdraw: the schema change of epoch 3 was already committed/);
    expect(readEpochs(b).length).toBe(7);
  });

  it("aborts a transition whose lease lapsed, and refuses a late renewal and a late commit", async () => {
    const rt = new VirtualRuntime(1);
    const b = new SqliteBackend();
    const meta = new MetaCore(b, ["s0"], { runtime: rt, leaseMs: 1_000, buildMaxMs: 3_000 });
    await ddl(meta, "CREATE TABLE t(id INTEGER PRIMARY KEY, a TEXT)", ["s0"]);
    const p = await meta.prepare("ALTER TABLE t ADD COLUMN b INTEGER CHECK (b > 0)");
    expect(p.mode).toBe("trial");
    // 延ばし続けても、上限 (buildMaxMs) を過ぎれば abort する。
    for (let i = 0; i < 5; i++) {
      rt.set(rt.now() + 800);
      await outcome(() => meta.renew(p.epoch!));
    }
    const cat = await meta.catalog();
    expect({ open: cat.open, aborted: cat.aborted }).toEqual({
      open: undefined, aborted: { of: 3, reason: `ALTER TABLE t ADD COLUMN b INTEGER CHECK (b > 0) did not finish within 3 seconds and was withdrawn; the table is unchanged` },
    });
    expect(await outcome(() => meta.renew(p.epoch!))).toMatch(/no longer in progress/);
    expect(await outcome(() => meta.commit(p.epoch!, ["s0"]))).toMatch(/did not finish within 3 seconds/);
    // 進める側が止まったら、期限 (leaseMs) のうちに abort する。
    const q = await meta.prepare("DROP TABLE t");
    rt.set(rt.now() + 1_500);
    expect((await meta.catalog()).aborted).toEqual({ of: q.epoch, reason: "DROP TABLE t stopped before it finished and was withdrawn; the table is unchanged" });
  });

  it("does not record a DDL that does nothing, and refuses a plan made on an older schema epoch", async () => {
    const b = new SqliteBackend();
    const meta = new MetaCore(b, ["s0"], { runtime: new VirtualRuntime(1) });
    await ddl(meta, "CREATE TABLE t(id INTEGER PRIMARY KEY)", ["s0"]);
    const n = readEpochs(b).length;
    expect((await meta.prepare("CREATE TABLE IF NOT EXISTS t(id INTEGER PRIMARY KEY)")).epoch).toBeNull();
    expect(readEpochs(b).length).toBe(n);
    expect(await outcome(() => meta.prepare("CREATE TABLE u(id INTEGER PRIMARY KEY)", {}, 1))).toBe("throws SchemaMoved: schema moved to epoch 2");
    // SQLite が空の表で拒否する文は、prepare を記録する前に断る。
    expect(await outcome(() => meta.prepare("CREATE TABLE s(id INTEGER PRIMARY KEY, name VARCHAR(20)) STRICT"))).toMatch(/^throws SqlError: unknown datatype for s.name/);
    expect(readEpochs(b).length).toBe(n);
  });

  it("refuses to fold a broken log", () => {
    const genesis: Logged = { epoch: 0, rec: { kind: "genesis", routing: { version: 1, ranges: [{ start: 0, end: REGION_TOKENS, shard: "s0" }] } } };
    expect(() => fold([genesis, { epoch: 2, rec: { kind: "move-end", of: 1 } }])).toThrow(/broken/);
    expect(() => fold([genesis, { epoch: 1, rec: { kind: "commit", of: 1 } }])).toThrow(/broken/);
    expect(() => fold([genesis, { epoch: 1, rec: { kind: "abort", of: 1, reason: "x" } }])).toThrow(/broken/);
    expect(() => fold([genesis, { epoch: 1, rec: { kind: "move-end", of: 1 } }])).toThrow(/broken/);
    expect(() => fold([{ epoch: 1, rec: genesis.rec }])).toThrow(/broken/);
  });

  it("does not open a move while a schema transition is open, nor a transition while a move is open (both directions of M21's exclusion)", async () => {
    const b = new SqliteBackend();
    const meta = new MetaCore(b, ["s0", "s1"], { runtime: new VirtualRuntime(1) });
    await ddl(meta, "CREATE TABLE t(id INTEGER PRIMARY KEY, a TEXT)");
    const range = planSplit((await meta.catalog()).routing, "s0")!;
    const p = await meta.prepare("ALTER TABLE t ADD COLUMN b INTEGER CHECK (b > 0)");
    // 表定義の遷移が開いている間は、移動を開かない (MOVE_WAITS_DDL)。
    expect(await outcome(() => meta.startMove({ from: "s0", to: "s2", ...range }))).toBe("throws SchemaBusy: schema busy: ALTER TABLE t ADD COLUMN b INTEGER CHECK (b > 0) is in progress");
    await meta.abort(p.epoch!, "test");
    const { epoch } = await meta.startMove({ from: "s0", to: "s2", ...range });
    // 移動が開いている間は、表定義の遷移を開かない (DDL_WAITS_MOVE)。閉じれば開ける。
    expect(await outcome(() => meta.prepare("CREATE INDEX ta ON t(a)"))).toBe("throws SchemaBusy: schema busy: a shard split of s0 is in progress");
    await meta.endMove(epoch);
    expect((await meta.prepare("CREATE INDEX ta ON t(a)")).epoch).toBe(epoch + 2);
    // 欠陥のスイッチは、それぞれの向きの確かめだけを外す。
    const loose = new MetaCore(new SqliteBackend(), ["s0", "s1"], { runtime: new VirtualRuntime(1), faults: { ddlDuringMove: true, moveDuringDdl: true } });
    await ddl(loose, "CREATE TABLE t(id INTEGER PRIMARY KEY, a TEXT)");
    const q = await loose.prepare("ALTER TABLE t ADD COLUMN b INTEGER CHECK (b > 0)");
    const m = await loose.startMove({ from: "s0", to: "s2", ...range });
    expect(m.epoch).toBe(q.epoch! + 1);
    // 移動どうしの条件は残る。
    expect(await outcome(() => loose.startMove({ from: "s0", to: "s3", start: 0, end: range.start }))).toMatch(/^throws SplitBusy: split busy: a move of/);
    await loose.abort(q.epoch!, "test");
    expect((await loose.prepare("CREATE INDEX ta ON t(a)")).epoch).toBe(m.epoch + 2);
  });

  it("refuses a move that overlaps an open move or names its shards, and a child that already owns a range", () => {
    // M21 は移動を 1 つしか持たないので、移動どうしの条件は、ここで確かめる (設計書の「同時に開ける遷移」)。
    const q = REGION_TOKENS / 4;
    const log: Logged[] = [
      { epoch: 0, rec: { kind: "genesis", routing: { version: 1, ranges: [{ start: 0, end: 2 * q, shard: "a" }, { start: 2 * q, end: 4 * q, shard: "b" }] } } },
      { epoch: 1, rec: { kind: "move-start", from: "a", to: "c", start: q, end: 2 * q } },
    ];
    const s = fold(log);
    expect(refusal(s, { kind: "move-start", from: "a", to: "d", start: 0, end: q / 2 })).toMatchObject({ rule: "moves-overlap" });
    expect(refusal(s, { kind: "move-start", from: "b", to: "c", start: 3 * q, end: 4 * q })).toMatchObject({ rule: "moves-overlap" });
    expect(refusal(s, { kind: "move-start", from: "b", to: "a", start: 3 * q, end: 4 * q })).toMatchObject({ rule: "moves-overlap" });
    expect(refusal(s, { kind: "move-start", from: "b", to: "d", start: 3 * q, end: 4 * q })).toBeNull();
    const ended = fold([...log, { epoch: 2, rec: { kind: "move-end", of: 1 } }]);
    expect(refusal(ended, { kind: "move-start", from: "b", to: "c", start: 3 * q, end: 4 * q })).toMatchObject({ rule: "child-owns" });
    expect(refusal(ended, { kind: "move-start", from: "a", to: "d", start: q / 2, end: 2 * q })).toMatchObject({ rule: "owner", owners: ["a", "c"] });
  });

  // 段 1 で利用者に見える、ただ 1 つの変化。Meta は利用者の DDL を自分の SQLite でも実行するので、__epoch を名指す DDL を
  // 通すと、Meta の列そのものを作り変えるか消す (段 1 より前は、この名前の表を作れた)。
  it("refuses user DDL that names __epoch, and leaves the log as it was", async () => {
    const b = new SqliteBackend();
    const meta = new MetaCore(b, ["s0", "s1"], { runtime: new VirtualRuntime(1) });
    await ddl(meta, "CREATE TABLE t(id INTEGER PRIMARY KEY)");
    const before = JSON.stringify(readEpochs(b));
    for (const sql of [
      "CREATE TABLE __epoch(x)", "CREATE TABLE IF NOT EXISTS __epoch(epoch INTEGER PRIMARY KEY, rec TEXT NOT NULL)", `CREATE TABLE "__EPOCH"(x)`,
      "DROP TABLE __epoch", "ALTER TABLE __epoch ADD COLUMN y", "CREATE INDEX e ON __epoch(rec)", "ALTER TABLE t RENAME TO __epoch",
    ]) {
      expect(await outcome(() => meta.prepare(sql)), sql).toMatch(/^throws SqlError: .*(reserved for internal use|no such table)/);
    }
    expect(JSON.stringify(readEpochs(b))).toBe(before);
    expect(b.exec(`SELECT count(*) AS n FROM pragma_table_info('__epoch')`)).toEqual([{ n: 2 }]);
    expect((await ddl(meta, "CREATE TABLE u(id INTEGER PRIMARY KEY)")).schema).toBe(4);
  });

  it("refuses to open data of the previous storage format, instead of reading an empty log", () => {
    const b = new SqliteBackend();
    b.exec(`CREATE TABLE __meta(k TEXT PRIMARY KEY, v)`);
    b.exec(`INSERT INTO __meta VALUES ('format', 4)`);
    expect(() => new MetaCore(b)).toThrow("storage format 4 of this schema object has no migration to format 5");
  });
});

// 分割を進める側は、どの手の前でも止まり得る (test/split-slot.test.ts)。止まった分割を再開して終えたとき、列には、その移動の
// move-start と move-end が 1 つずつあり、開いている移動は残らない。手は、止めずに流したときの呼び出しの列から取る。
describe("the moves a split records", () => {
  const FREE = ["catalog", "moves"];
  async function seeded() {
    const c = new SimCluster({ shards: 1 });
    await new Db(c).ddl("CREATE TABLE items(id INTEGER PRIMARY KEY, n INTEGER NOT NULL)");
    await new Db(c).query(`INSERT INTO items(id, n) VALUES ${Array.from({ length: 40 }, (_, i) => `(${i + 1}, ${i + 1})`).join(", ")}`);
    return { c, range: planSplit((await c.catalog()).routing, "s0")! };
  }

  it("a split stopped before any of its steps and resumed records one move-start and one move-end", async () => {
    const dry = await seeded();
    const free = driver(dry.c, null, FREE);
    expect(await outcome(() => split(free.cluster, "s0", "s1", { range: dry.range }))).toMatch(/^ok/);
    expect(free.calls).toEqual(["startMove", "s1.drain"]);
    for (let i = 0; i < free.calls.length; i++) {
      const { c, range } = await seeded();
      expect(await outcome(() => split(driver(c, i, FREE).cluster, "s0", "s1", { range }))).toMatch(/driver stopped/);
      // 子が知る前に止まった移動は、Meta に開いたまま残る。Autoscaler は、開いている移動を再開する。
      const jobs = movesToResume(await c.moves(), () => false);
      expect(jobs).toEqual(i === 0 ? [] : [{ parent: "s0", child: "s1", range }]);
      for (const j of jobs.length ? jobs : [{ parent: "s0", child: "s1", range }]) expect(await outcome(() => split(c, j.parent, j.child, { range: j.range }))).toMatch(/^ok/);
      const log = readEpochs(c.metaBackend);
      const moves = log.filter((x) => x.rec.kind === "move-start" || x.rec.kind === "move-end").map((x) => x.rec);
      expect(moves).toEqual([{ kind: "move-start", from: "s0", to: "s1", ...range }, { kind: "move-end", of: log.find((x) => x.rec.kind === "move-start")!.epoch }]);
      expect(fold(log).moves).toEqual([]);
      expect(await c.moves()).toEqual([]);
    }
  });
});
