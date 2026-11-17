// Meta の epoch の列 (src/catalog.ts) と、その上に載せた Meta (src/meta.ts) の試験。docs/design-catalog-epoch.md の段 1 から段 3。
//
// 段 1 と段 2 の間は、段 1 より前の Meta (test/meta-old.ts) と答えを比べる乱択の検査がここにあった。段 3 で表定義の変更が 2 相に
// なり、比べる入口 (applyDdl、revokeDdl、publishIndex、lockTables、finishLock、renewLock) が新しい Meta にない。残る入口
// (catalog、分割の枠) の答えも、表定義の版の数と取り消しの印がなくなったので、比べられない。
// 古い Meta の写しは消した。表定義の遷移の条件は、M21 と突き合わせる test/catalog-m21.test.ts と、下の試験が確かめる。
// 表定義の epoch は、表と view ごとに持ち、commit の記録でだけ進む (設計書の「表ごとの epoch」、M24。2026-11-17)。
import { describe, expect, it } from "vitest";
import { movesToResume, split } from "../src/autoscaler";
import { fold, objectKey, refusal, type Logged, type ObjectEpochs } from "../src/catalog";
import { Db } from "../src/client/db";
import { MetaCore, readEpochs } from "../src/meta";
import { planSplit, REGION_TOKENS } from "../src/routing";
import { isInternalName, parseDdl, type SchemaView } from "../src/sql/ddl";
import type { Faults } from "../src/types";
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
    // 表定義の epoch は、commit の記録でだけ進む (設計書の「決めたこと 6 を改める」)。prepare と、移動の記録では進まない。
    expect([1, 2, 3, 4, 5, 6].map((e) => fold(readEpochs(b), e).schema)).toEqual([0, 2, 2, 2, 2, 6]);
    // 欠陥のスイッチ epochOnPrepare は、段 3 の形に戻す (prepare と abort でも進む。M24 の m24_red_prepare_advances)。
    expect([1, 2, 3, 4, 5, 6].map((e) => fold(readEpochs(b), e, { epochOnPrepare: true }).schema)).toEqual([1, 2, 2, 2, 5, 6]);
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
    expect(await meta.abort(5, "changed")).toEqual({ reason: "changed", wound: false });
    const s = fold(readEpochs(b));
    expect({ open: s.open, aborted: s.aborted, t: s.tables.t !== undefined }).toEqual({ open: null, aborted: { of: 5, reason: "changed" }, t: true });
    expect(await outcome(() => meta.commit(5, ["s0", "s1"]))).toBe("throws SqlError: changed");
    // もう abort された遷移の abort は、記録せずに、記録した理由を返す。commit された遷移は取り消せない。
    expect(await meta.abort(5, "later")).toEqual({ reason: "changed", wound: false });
    expect(await outcome(() => meta.abort(3, "late"))).toMatch(/^throws SqlError: cannot withdraw: the schema change of epoch 3 was already committed/);
    expect(readEpochs(b).length).toBe(7);
  });

  // 表ごとの epoch (設計書の「表ごとの epoch」の「規則」、M24)。進むのは commit だけで、進むのは、その DDL が変えたものだけである。
  it("keeps a read epoch and a write epoch per table and an epoch per view, advanced only by the commit of a DDL that changes it", async () => {
    const b = new SqliteBackend();
    const meta = new MetaCore(b, ["s0", "s1"], { runtime: new VirtualRuntime(1) });
    const at = async (): Promise<Record<string, ObjectEpochs | undefined>> => {
      const { objects } = await meta.catalog();
      return Object.fromEntries(["a", "b", "v", "a2", "__gidx_au", "*"].map((k) => [k, objects[k]]));
    };
    const rw = (read: number, write = read): ObjectEpochs => ({ read, write });
    await ddl(meta, "CREATE TABLE A(id INTEGER PRIMARY KEY, x TEXT)"); // epoch 1, 2
    await ddl(meta, "CREATE TABLE b(id INTEGER PRIMARY KEY, x TEXT)"); // epoch 3, 4
    // 名前は、大文字と小文字を区別しない。関係のない表の CREATE TABLE は、a の epoch を進めない。
    expect(await at()).toMatchObject({ a: rw(2), b: rw(4), "*": rw(4) });
    // prepare は、どの epoch も進めない。abort も進めない (失敗した DDL は、触った表の取引も古くしない)。
    const failing = await meta.prepare("ALTER TABLE A ADD COLUMN y INTEGER"); // epoch 5
    expect(await at()).toMatchObject({ a: rw(2), "*": rw(4) });
    await meta.abort(failing.epoch!, "the rows refused it"); // epoch 6
    expect(await at()).toMatchObject({ a: rw(2), b: rw(4), "*": rw(4) });
    expect((await meta.catalog()).schema).toBe(4);
    // 列を足す commit は、その表の読みの epoch と書き込みの epoch を進める。
    await ddl(meta, "ALTER TABLE A ADD COLUMN y INTEGER"); // epoch 7, 8
    expect(await at()).toMatchObject({ a: rw(8), b: rw(4), "*": rw(8) });
    // 列だけの一意でない index は、その表の書き込みの epoch だけを進める。消すときも同じである。
    await ddl(meta, "CREATE INDEX ax ON A(x)"); // epoch 9, 10
    expect(await at()).toMatchObject({ a: rw(8, 10), b: rw(4) });
    await ddl(meta, "DROP INDEX ax"); // epoch 11, 12
    expect(await at()).toMatchObject({ a: rw(8, 12), b: rw(4) });
    // view は epoch を 1 つ持つ。view の DDL は、元の表の epoch を進めない。
    await ddl(meta, "CREATE VIEW v AS SELECT id FROM A"); // epoch 13, 14
    expect(await at()).toMatchObject({ a: rw(8, 12), v: rw(14) });
    // シャードをまたぐ UNIQUE の index は、表の書き込みの epoch だけを進める。index の表だけは、prepare の epoch で生まれる。
    const build = await meta.prepare("CREATE UNIQUE INDEX au ON A(x)"); // epoch 15
    expect(await at()).toMatchObject({ a: rw(8, 12), __gidx_au: rw(15) });
    await meta.commit(build.epoch!, ["s0", "s1"], 1); // epoch 16
    expect(await at()).toMatchObject({ a: rw(8, 16), __gidx_au: rw(15) });
    // index を消すと、その index の表の epoch も進む (消した名前も、消した epoch を持ち続ける)。
    await ddl(meta, "DROP INDEX au"); // epoch 17, 18
    expect(await at()).toMatchObject({ a: rw(8, 18), __gidx_au: rw(18) });
    // 名前を変えると、古い名前と新しい名前の両方の epoch が進む。
    await ddl(meta, "ALTER TABLE A RENAME TO a2"); // epoch 19, 20
    expect(await at()).toMatchObject({ a: rw(20), a2: rw(20), b: rw(4) });
    // 消した名前は、消した epoch を持ち続け、作り直した表は、より新しい epoch になる。
    await ddl(meta, "DROP TABLE b"); // epoch 21, 22
    expect(await at()).toMatchObject({ b: rw(22) });
    await ddl(meta, "CREATE TABLE b(id INTEGER PRIMARY KEY)"); // epoch 23, 24
    expect(await at()).toMatchObject({ b: rw(24), a2: rw(20), v: rw(14), "*": rw(24) });
    // 取引の表定義を名指す epoch まで畳んだ表定義 (接続をまたぐ取引の組み立て直し)。範囲表は、いまのものである。
    const then = await meta.catalogAt(8);
    expect({ schema: then.schema, tables: Object.keys(then.tables), a: then.objects.a, epoch: then.epoch }).toEqual({ schema: 8, tables: ["A", "b"], a: rw(8), epoch: 24 });
    expect(await outcome(() => meta.catalogAt(7))).toMatch(/^throws SqlError: schema epoch 7 is not an epoch at which a schema change committed/);
  });

  // 実装の一覧の 1。DDL ごとの、変えるもの。
  it("names what each DDL changes: tables whose reads change, tables whose index set changes, and views", () => {
    const tables: SchemaView["tables"] = {};
    const schema: SchemaView = { tables, views: {}, indexes: {} };
    const apply = (sql: string) => {
      const p = parseDdl(sql, schema);
      for (const d of p.defs) tables[d.name] = d;
      for (const n of p.drops) delete tables[n];
      Object.assign(schema.views, p.views);
      for (const n of p.dropViews ?? []) delete schema.views[n];
      Object.assign(schema.indexes, p.indexes);
      for (const n of p.dropIndexes ?? []) delete schema.indexes[n];
      return p.changes;
    };
    const c = (read: string[], write: string[] = [], views: string[] = []) => ({ read, write, views });
    expect(apply("CREATE TABLE t(tenant_id INTEGER NOT NULL, id INTEGER NOT NULL, a TEXT, e TEXT UNIQUE, PRIMARY KEY (tenant_id, id))")).toEqual(c(["t", "__gidx_t_0_key"]));
    expect(apply("ALTER TABLE t ADD COLUMN b INTEGER")).toEqual(c(["t"]));
    expect(apply("CREATE INDEX ta ON t(a)")).toEqual(c([], ["t"]));
    // 行で失敗し得る index (シャード内の UNIQUE、式か WHERE のある index) は、読みの epoch も進める。
    expect(apply("CREATE UNIQUE INDEX tu ON t(tenant_id, a)")).toEqual(c(["t"]));
    expect(apply("CREATE INDEX te ON t(lower(a))")).toEqual(c(["t"]));
    expect(apply("CREATE INDEX tp ON t(a) WHERE b > 0")).toEqual(c(["t"]));
    expect(apply("CREATE UNIQUE INDEX tg ON t(a)")).toEqual(c([], ["t"]));
    expect(apply("DROP INDEX ta")).toEqual(c([], ["t"]));
    expect(apply("DROP INDEX tg")).toEqual(c(["__gidx_tg"], ["t"]));
    expect(apply("CREATE VIEW tv AS SELECT a FROM t")).toEqual(c([], [], ["tv"]));
    expect(apply("DROP VIEW tv")).toEqual(c([], [], ["tv"]));
    expect(apply("ALTER TABLE t RENAME TO u")).toEqual(c(["t", "u"]));
    expect(apply("DROP TABLE u")).toEqual(c(["__gidx_t_0_key", "u"]));
    expect(parseDdl("CREATE TABLE IF NOT EXISTS x(id INTEGER PRIMARY KEY)", { tables: { x: {} as never }, views: {}, indexes: {} }).changes).toBeUndefined();
  });

  // 計画書の不変条件 16 (モデル M24c の FENCE_COVERS)。DDL が待つ表の集合 (prepare の記録の fence) は、その DDL が確定で書き込みの epoch を
  // 進める表のうち、prepare の直前にある利用者の表である (src/catalog.ts の fenceOf)。DDL の種類ごとに並べた一覧ではないことを、
  // 畳み込みが epoch を進めた表と突き合わせて確かめる。まだない名前、view、内部の表 (__gidx_<index>) は入らない。
  const FENCES: [string, string[]][] = [
    ["CREATE TABLE t(tenant_id INTEGER NOT NULL, id INTEGER NOT NULL, a TEXT, e TEXT UNIQUE, PRIMARY KEY (tenant_id, id))", []],
    ["CREATE TABLE o(id INTEGER PRIMARY KEY)", []],
    ["ALTER TABLE t ADD COLUMN b INTEGER", ["t"]],
    ["CREATE INDEX ta ON t(a)", ["t"]],
    ["CREATE UNIQUE INDEX tu ON t(tenant_id, a)", ["t"]],
    ["CREATE INDEX te ON t(lower(a))", ["t"]],
    ["CREATE UNIQUE INDEX tg ON t(a)", ["t"]],
    ["DROP INDEX ta", ["t"]],
    ["DROP INDEX tg", ["t"]],
    ["CREATE VIEW tv AS SELECT a FROM t", []],
    ["DROP VIEW tv", []],
    ["ALTER TABLE t RENAME TO u", ["t"]],
    ["DROP TABLE u", ["u"]],
    ["DROP TABLE o", ["o"]],
  ];
  async function fences(faults: Faults = {}) {
    const b = new SqliteBackend();
    const meta = new MetaCore(b, ["s0", "s1"], { runtime: new VirtualRuntime(1), faults });
    const out: { sql: string; fence: string[]; advanced: string[] }[] = [];
    for (const [sql] of FENCES) {
      const before = fold(readEpochs(b));
      const p = await meta.prepare(sql, {}, before.schema);
      const fence = (readEpochs(b).at(-1)!.rec as { fence: string[] }).fence;
      await meta.commit(p.epoch!, ["s0", "s1"], 1);
      const after = fold(readEpochs(b));
      // prepare の直前にあった利用者の表のうち、commit で書き込みの epoch が進んだもの。
      const advanced = Object.keys(before.tables).filter((t) => !isInternalName(t) && after.objects[objectKey(t)]!.write > before.objects[objectKey(t)]!.write);
      out.push({ sql, fence: [...fence].sort(), advanced: advanced.sort() });
    }
    return out;
  }
  it("fences exactly the existing user tables whose write epoch the DDL's commit advances", async () => {
    const got = await fences();
    expect(got.map((x) => [x.sql, x.fence])).toEqual(FENCES);
    for (const x of got) expect(x.fence, x.sql).toEqual(x.advanced);
  });
  // m24c_red_fence。行で失敗しない index の DDL (一意でない CREATE INDEX、DROP INDEX) の fence が空になる (2026-11-17 までの形)。
  it("put back (indexDdlUnfenced): plain index DDLs advance the table's write epoch without fencing it", async () => {
    const unfenced = (await fences({ indexDdlUnfenced: true })).filter((x) => x.fence.join() !== x.advanced.join());
    expect(unfenced.map((x) => [x.sql, x.fence, x.advanced])).toEqual([
      ["CREATE INDEX ta ON t(a)", [], ["t"]], ["DROP INDEX ta", [], ["t"]], ["DROP INDEX tg", [], ["t"]],
    ]);
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

  // モデル M24c の ONE_RESTART (specs/m24c_lock_holders.qnt)。取り消させる手 (wound) の abort は、同じ 1 手で、やり直しの prepare を記録する。
  // DDL が始まってから終わるまで、列に、開いている試みのない時がない。やり直しは、同じ文、同じ fence、同じ待ちの期限で、DDL の最初の
  // 試みの epoch を運ぶ (何度取り消させられても)。書き込みが止まる時間の上限は、最初の試みから数える。
  it("records the retry's prepare together with a wound's abort, and every retry names the DDL's first attempt", async () => {
    const rt = new VirtualRuntime(1);
    const b = new SqliteBackend();
    const meta = new MetaCore(b, ["s0", "s1"], { runtime: rt, leaseMs: 5_000, buildMaxMs: 10_000 });
    await ddl(meta, "CREATE TABLE t(id INTEGER PRIMARY KEY, a TEXT)"); // epoch 1, 2
    const t0 = rt.now();
    const waitUntil = t0 + 5_000;
    const first = await meta.prepare("ALTER TABLE t ADD COLUMN b INTEGER", { waitUntil }); // epoch 3
    rt.set(t0 + 4_000);
    expect(await meta.abort(first.epoch!, "a holder reached the lock", true)).toEqual({ reason: "a holder reached the lock", wound: true, next: 5 });
    const log = readEpochs(b);
    expect(log.slice(-2).map((x) => [x.epoch, x.rec.kind])).toEqual([[4, "abort"], [5, "prepare"]]);
    expect(log.at(-1)!.rec).toMatchObject({ kind: "prepare", mode: "trial", fence: ["t"], waitUntil, retryOf: 3 });
    expect((await meta.catalog()).open).toEqual({ epoch: 5, mode: "trial", fence: ["t"], retryOf: 3 });
    // やり直しが、また取り消させられる。次のやり直しも、最初の試み (epoch 3) を名指す。
    expect(await meta.abort(5, "another holder", true)).toEqual({ reason: "another holder", wound: true, next: 7 });
    expect(readEpochs(b).at(-1)!.rec).toMatchObject({ kind: "prepare", waitUntil, retryOf: 3 });
    // もう取り消された試みの abort は、記録せずに、その DDL の、いま開いているやり直しを答える。
    expect(await meta.abort(3, "late")).toEqual({ reason: "a holder reached the lock", wound: true, next: 7 });
    expect(await meta.abort(5, "late")).toEqual({ reason: "another holder", wound: true, next: 7 });
    expect((await meta.catalog()).open).toMatchObject({ epoch: 7, retryOf: 3 });
    expect(readEpochs(b).length).toBe(8);
    // 期限の上限 (10 秒) は、最初の試みの prepare から数える。延ばしても、t0 + 10 秒で abort する (やり直しから数えれば、t0 + 14 秒まで開く)。
    rt.set(t0 + 8_000);
    await meta.renew(7);
    rt.set(t0 + 10_500);
    expect((await meta.catalog()).aborted).toEqual({ of: 7, reason: "ALTER TABLE t ADD COLUMN b INTEGER did not finish within 10 seconds and was withdrawn; the table is unchanged" });
    // 閉じた DDL に、開いているやり直しはない。
    expect(await meta.abort(3, "late")).toEqual({ reason: "a holder reached the lock", wound: true });
    // 取り消させる手でない abort は、やり直さない。待ちの期限を運ばない prepare (待つ者がいない) も、やり直さない。
    const second = await meta.prepare("ALTER TABLE t ADD COLUMN b INTEGER", { waitUntil: rt.now() + 5_000 });
    expect(await meta.abort(second.epoch!, "the rows refused it")).toEqual({ reason: "the rows refused it", wound: false });
    const bare = await meta.prepare("ALTER TABLE t ADD COLUMN b INTEGER");
    expect(await meta.abort(bare.epoch!, "a holder reached the lock", true)).toEqual({ reason: "a holder reached the lock", wound: true });
    expect((await meta.catalog()).open).toBeUndefined();
    // やり直しを引き継いで、確定できる。
    const third = await meta.prepare("ALTER TABLE t ADD COLUMN b INTEGER", { waitUntil: rt.now() + 5_000 });
    const { next } = await meta.abort(third.epoch!, "a holder reached the lock", true);
    expect((await meta.commit(next!, ["s0", "s1"])).tables.t!.columns).toEqual(["id", "a", "b"]);
  });

  // m24c_red_gap。取り消しと一緒に、やり直しの prepare を記録しない (2026-11-17 までの形)。取り消しの後、列に、開いている試みがない。
  it("put back (woundWithoutRestart): a wound's abort leaves no open attempt in the log", async () => {
    const rt = new VirtualRuntime(1);
    const meta = new MetaCore(new SqliteBackend(), ["s0", "s1"], { runtime: rt, faults: { woundWithoutRestart: true } });
    await ddl(meta, "CREATE TABLE t(id INTEGER PRIMARY KEY, a TEXT)");
    const first = await meta.prepare("ALTER TABLE t ADD COLUMN b INTEGER", { waitUntil: rt.now() + 5_000 });
    expect(await meta.abort(first.epoch!, "a holder reached the lock", true)).toEqual({ reason: "a holder reached the lock", wound: true });
    expect((await meta.catalog()).open).toBeUndefined();
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
