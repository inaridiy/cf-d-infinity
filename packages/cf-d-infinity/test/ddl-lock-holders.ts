// 主キーで読んでから書く取引と、同じ表の index の DDL と ADD COLUMN を並べる乱択 (test/ddl-concurrent.test.ts の 9)。
//
// 台本は seed から作り、置き場所を知らない (test/placement-oracle.ts と同じ)。同じ台本を、1 シャードと 2 シャード、通常の経路と
// 基準経路 (scans か full) の 4 つの実行で流し、結果を SQLite (WAL、busy_timeout 5 秒) の答えと比べ、4 つの間でも比べる。
//
// 台本
//   表 x(id INTEGER PRIMARY KEY, v, w) に 16 行。v は一意で、書き手は w だけを書く (UNIQUE の index はいつも作れる)。
//   DDL は 1 つ (DDL_KINDS): 一意でない CREATE INDEX、DROP INDEX (シャード内の index と、シャードをまたぐ UNIQUE)、
//   シャードをまたぐ CREATE UNIQUE INDEX (build)、shard key を含む CREATE UNIQUE INDEX (trial)、ADD COLUMN (trial)。
//   取引は 1 つから 3 つで、行は取引ごとに別である (行ロックの取り合いを作らない。答えが 1 つに決まる)。
//     holder  DDL を始める前に、行ロックを取る (BEGIN IMMEDIATE の主キーの読み、か書き込み)。DDL を始めた後に、ときどきもう 1 行
//             (別のシャードのこともある) を書き、COMMIT か ROLLBACK を、5 秒の期限の前 (0.7〜3.8 秒) か後 (5.9〜6.8 秒) に送る。
//             期限の後まで持つ取引は、間に読みを挟み、5 秒より長く黙らない (行ロックは、黙った取引のものだけが切れる)。
//             BEGIN IMMEDIATE の取引の一部は、DDL の前には読むだけで、書くのは DDL の後である (読みがロックを取る)。
//     late    全シャードが DDL の prepare を適用した後に始める (下の「合図」。半分は合図の窓の中、半分は窓が閉じた後)。主キーで読み、
//             書き、COMMIT する。一部は 2.5〜4.5 秒、ロックを持つ。
//     reader  素の BEGIN で、DDL の前に読み、DDL の後に書いて、100〜300 ms で COMMIT する。DDL が holder のロックを待っている
//             シャードでは、reader の書き込みは禁止の前に通り、DDL は reader も待つ。reader が 5 秒の期限の後までロックを持つと、DDL は
//             SQLITE_BUSY になり、行が禁止したシャードにあれば通るので、成否が置き場所で決まる (未解決。
//             test/open/ddl-busy-by-writer-during-its-wait.test.ts)。この生成器は、その形を作らない。
//   合図: Worker への prepared の答えのうち、範囲表の全シャードがその epoch の prepare を適用した後の最後の答えを、windowMs だけ止め、
//   その間に late の取引を始める。シャードは、表の行ロックがある間は prepare を適用しないので、そのとき x の行ロックはどこにもない。
//   build の DDL では、既存の行を読む要求を slowBuildMs だけ遅らせる (index を作る間の窓。5 秒の待ちの期限を越えることもある)。
//
// SQLite の答え (M24 の asSqlite と holderSurvives。specs/m24_table_epochs.qnt の m24_retry):
//   DDL      DDL を始める前にロックを取った取引 (holder) が、始めてから 5 秒より後まで終わらなければ、5 秒で SQLITE_BUSY (conflict) に
//            なる。そうでなければ確定し、holder の終わりを待つ。失敗するなら busy の類の誤りだけである。late は DDL を待たせも
//            失敗させもしない (SQLite では、late が DDL の書き込みのロックを待つ)。全シャードが prepare を適用した後の遷移を、行ロックを
//            持つ取引が取り消させたら (M24 の WOUND)、その取引のロックは prepare の後に取られたもので、違反である。
//   holder   どの文も COMMIT も断られない (DDL のほうが待つ)。
//   late     BEGIN IMMEDIATE なら、どの文も通る (SQLite の BEGIN IMMEDIATE は DDL を待ってから始まる)。素の BEGIN は、読みが DDL の前の
//            スナップショットなので、DDL が確定すれば書き込みが SQLITE_BUSY になってよい。
//   reader   SQLITE_BUSY になってよい (SQLite でも、DDL の確定の後の書き込みは BUSY_SNAPSHOT になる)。
//   表       確定した取引の書き込みだけが残る。DDL が確定したなら、その変更がある。行イメージの形は test/setup.ts の検査が確かめる。
//   誤り     どの取引の文も、断られるなら busy の類の誤りだけである。
// 4 つの実行の間では、DDL の結果 (ok、busy、ほかの誤り) と、holder と BEGIN IMMEDIATE の late の確定の成否が同じでなければならない。
// 素の BEGIN の取引 (late と reader) は、SQLite でも成否が間合いで決まるので比べない。行が prepare を待っているシャードにあれば、
// 書き込みが禁止の前に通って確定し、もう禁止したシャードにあれば待って SQLITE_BUSY になる (どちらも SQLite の答えのどれかである)。
//
// 既知の欠陥 (5808b08。直していない。test/open/ に再現がある)。既定の実行では、下の印のある実行の違反のうち、その欠陥が説明する種類
// (explains) だけを伏せ、数える。表と表定義の違反、busy でない文の誤り、5 秒でない busy は伏せない。OPEN=1 では何も伏せない。
//   D1  ロックを取る読みが、書き込み禁止の表で通る (test/open/locking-read-on-fenced-table.test.ts)。シャードの lockRows の確かめは、
//       書き込みとして頼る表にしか、禁止を当てない (src/shard/kernel.ts の lockedStep)。全シャードが prepare を適用した後に、
//       BEGIN IMMEDIATE の主キーの読みがロックを取り、続く書き込みが DDL を取り消させる (M24 の WOUND)。DDL は、やり直して、その取引を
//       待つか、期限を過ぎて失敗する (busy でない誤りのこともある)。印: シャードが、lockRows のある exec に、x が禁止の間に答えた。
//       基準経路では、主キーの読みも行を集めるのでロックを取らず (Txn.shardRead が通常の経路だけで lockRows を付ける)、BEGIN IMMEDIATE の
//       取引の書き込みが、DDL の確定の後に SQLITE_BUSY になる。DDL の結果は通常の経路と違う。印: 基準経路で、ロックを読みで取る
//       BEGIN IMMEDIATE の取引 (late と、DDL の前には読むだけの holder)。その取引と、それが holder なら DDL の違反を伏せる。
//   D2  一意でない CREATE INDEX と DROP INDEX は、行ロックを持つ取引を待たない (test/open/index-ddl-ignores-row-locks.test.ts)。
//       fence が空なので (src/sql/ddl.ts の createIndex と dropIndex)、prepare はロックを待たず (src/shard/kernel.ts の applyStep は、
//       fence の表の行ロックだけを待つ)、DDL はすぐに確定し、表の書き込みの
//       epoch を進める。ロックを持つ取引の次の書き込みと COMMIT が stale schema で断られる。印: その DDL の commit のとき、どこかの
//       シャードに x の生きた行ロックがあった。
import { Db } from "../src/client/db";
import { DDL_WAIT_MS } from "../src/meta";
import { fencedBy } from "../src/catalog";
import { shardsOf } from "../src/routing";
import type { Reference } from "../src/sql/plan";
import { prng, rawRows } from "./ddl-harness";
import { SimCluster } from "./sim";

export type DdlKind = "create index" | "drop index" | "drop unique index" | "create unique index" | "create local unique index" | "add column";
interface DdlSpec { sql: string; setup: string[]; fenced: boolean; build: boolean; check: (cat: CatalogLike) => boolean }
interface CatalogLike { indexes: Record<string, unknown>; tables: Record<string, { columns: string[] }> }
export const DDL_KINDS: Record<DdlKind, DdlSpec> = {
  "create index": { sql: "CREATE INDEX xi ON x(w)", setup: [], fenced: false, build: false, check: (c) => "xi" in c.indexes },
  "drop index": { sql: "DROP INDEX xi0", setup: ["CREATE INDEX xi0 ON x(w)"], fenced: false, build: false, check: (c) => !("xi0" in c.indexes) },
  "drop unique index": { sql: "DROP INDEX xu0", setup: ["CREATE UNIQUE INDEX xu0 ON x(v)"], fenced: false, build: false, check: (c) => !("xu0" in c.indexes) },
  "create unique index": { sql: "CREATE UNIQUE INDEX xu ON x(v)", setup: [], fenced: true, build: true, check: (c) => "xu" in c.indexes },
  "create local unique index": { sql: "CREATE UNIQUE INDEX xl ON x(id, w)", setup: [], fenced: true, build: false, check: (c) => "xl" in c.indexes },
  "add column": { sql: "ALTER TABLE x ADD COLUMN y INTEGER NOT NULL DEFAULT 0", setup: [], fenced: true, build: false, check: (c) => c.tables.x!.columns.includes("y") },
};

export interface TxnPlan {
  name: string;
  role: "holder" | "late" | "reader";
  immediate: boolean;
  r1: number;
  r2: number | null;
  /** holder (BEGIN IMMEDIATE だけ): DDL の前には r1 を読むだけで、r1 を書くのは DDL の後 (writeAt) である。 */
  readOnlyBefore: boolean;
  /** holder と reader は DDL を始めた時刻から、late は自分が始めた時刻からの ms。 */
  writeAt: number | null;
  keepAliveAt: number | null;
  endAt: number;
  rollback: boolean;
  /** late: 合図から始めるまでの ms。負なら、合図の窓 (windowMs) が閉じてから、その絶対値の ms の後に始める。 */
  delay: number;
}

export interface LockScript {
  seed: number;
  ddl: DdlKind;
  txns: TxnPlan[];
  windowMs: number;
  slowBuildMs: number;
}

const ROWS = 16;
const int = (r: () => number, lo: number, hi: number) => lo + Math.floor(r() * (hi - lo + 1));

export function lockScript(seed: number): LockScript {
  const r = prng(seed * 4099 + 7);
  const kinds = Object.keys(DDL_KINDS) as DdlKind[];
  const ddl = kinds[seed % kinds.length]!;
  const free = Array.from({ length: ROWS }, (_v, i) => i + 1);
  for (let i = free.length - 1; i > 0; i--) {
    const j = Math.floor(r() * (i + 1));
    [free[i], free[j]] = [free[j]!, free[i]!];
  }
  const take = () => free.pop()!;
  const n = int(r, 1, 3);
  const txns: TxnPlan[] = [];
  for (let i = 0; i < n; i++) {
    const roll = r();
    const role: TxnPlan["role"] = roll < 0.45 ? "holder" : roll < 0.85 ? "late" : "reader";
    const immediate = role !== "reader" && r() < 0.55;
    const base = { name: `${role[0]}${i + 1}`, role, immediate, r1: take(), r2: null as number | null, readOnlyBefore: false, writeAt: null as number | null, keepAliveAt: null as number | null, rollback: r() < 0.15, delay: 0 };
    if (role === "holder") {
      const past = r() < 0.3;
      const readOnlyBefore = immediate && r() < 0.35;
      const second = !readOnlyBefore && r() < 0.6;
      const writeAt = readOnlyBefore || second ? int(r, 200, 900) : null;
      txns.push({
        ...base, readOnlyBefore, r2: second ? take() : null, writeAt,
        keepAliveAt: past ? int(r, 2800, 3500) : null,
        endAt: past ? int(r, 5900, 6800) : int(r, Math.max(700, (writeAt ?? 0) + 300), 3800),
      });
    } else if (role === "late") {
      const long = r() < 0.3;
      const endAt = long ? int(r, 2500, 4500) : int(r, 150, 900);
      // 半分は合図の窓の中で始め、半分は窓の後 (build なら既存の行を読んでいる間、ほかの DDL なら確定の後) に始める。
      const delay = r() < 0.5 ? int(r, 0, 80) : -int(r, 50, 1500);
      txns.push({ ...base, r2: r() < 0.4 ? take() : null, keepAliveAt: long ? Math.floor(endAt / 2) : null, endAt, delay });
    } else {
      const writeAt = int(r, 150, 1500);
      txns.push({ ...base, writeAt, endAt: writeAt + int(r, 100, 300) });
    }
  }
  const slowBuildMs = DDL_KINDS[ddl].build ? [0, int(r, 300, 1500), int(r, 5500, 8000)][int(r, 0, 2)]! : 0;
  return { seed, ddl, txns, windowMs: int(r, 100, 600), slowBuildMs };
}

export type Path = "sim" | Reference;
export interface StmtOutcome { sql: string; outcome: string; at: number }
export interface TxnOutcome { name: string; stmts: StmtOutcome[]; committed: boolean; endSentAt: number | null; endDoneAt: number | null; startedAt: number }
export interface LockRun {
  script: LockScript;
  shards: number;
  path: Path;
  ddl: string;
  /** DDL を始めた時刻からの ms。 */
  ddlMs: number;
  /** DDL の確定を Meta が記録した時刻 (DDL を始めた時刻からの ms)。確定しなければ null。 */
  committedAt: number | null;
  /** 合図 (全シャードが prepare を適用した) の時刻。来なければ null。 */
  signalAt: number | null;
  txns: TxnOutcome[];
  /** 行ごとの w (最後の表)。 */
  w: Record<number, number>;
  schemaApplied: boolean;
  /** 既知の欠陥の印 (上の D1、D2)。 */
  marks: { lockOnFence: boolean; d2LockAtCommit: boolean };
  /** 行ロックを持つ取引が DDL を取り消させた回数 (M24 の WOUND)。 */
  wounds: number;
  /** そのうち、合図の epoch (全シャードが prepare を適用した遷移) を取り消させた回数。そのとき x の行ロックはどこにもなかった。 */
  woundsAfterSignal: number;
}

const BUSY = /^(conflict|read too old|not owner|migrating|upgrading)/;
export const classOf = (outcome: string): "ok" | "busy" | "error" => (outcome === "ok" ? "ok" : BUSY.test(outcome) ? "busy" : "error");

type KernelPeek = {
  snap: { opens: { epoch: number; fence: string[] }[] };
  locks: Map<string, { txn: string }>;
  leases: Map<string, { until: number }>;
  deps: { clock: { now(): number } };
};
const kernelOf = (c: SimCluster, id: string): KernelPeek => (c.cores.get(id) as unknown as { k: KernelPeek }).k;

/** 台本を 1 つの置き場所と経路で流す。 */
export async function runLockScript(s: LockScript, o: { shards: number; path: Path }): Promise<LockRun> {
  const c = new SimCluster({ shards: o.shards, seed: s.seed });
  const reference = o.path === "sim" ? undefined : o.path;
  const conn = () => new Db(c, { retries: 0, ...(reference ? { reference } : {}) });
  const admin = new Db(c);
  await admin.ddl("CREATE TABLE x(id INTEGER PRIMARY KEY, v INTEGER NOT NULL, w INTEGER NOT NULL DEFAULT 0)");
  await admin.query(`INSERT INTO x(id, v) VALUES ${Array.from({ length: ROWS }, (_v, i) => `(${i + 1}, ${(i + 1) * 10})`).join(", ")}`);
  const spec = DDL_KINDS[s.ddl];
  for (const sql of spec.setup) await admin.ddl(sql);
  await c.settle();

  // ---- 見張り ----
  const marks = { lockOnFence: false, d2LockAtCommit: false };
  let signal!: () => void;
  const signalled = new Promise<void>((r) => (signal = r));
  let signalAt: number | null = null;
  let signalEpoch: number | null = null;
  let d0 = 0;
  const now = () => c.runtime.now() - d0;
  let routingShards: string[] = [];
  c.net.reply = (m) => {
    if (m.from !== "client") return undefined;
    if (m.method === "exec") {
      // D1 の印: ロックを取る読みに、x が書き込み禁止の間に答えた。
      const req = m.req as { lockRows?: { table: string }[] };
      if (req.lockRows?.some((l) => l.table.toLowerCase() === "x") && fencedBy(kernelOf(c, m.to).snap as Parameters<typeof fencedBy>[0], "x")) marks.lockOnFence = true;
      return undefined;
    }
    if (m.method !== "prepared" || signalAt !== null) return undefined;
    const epoch = (m.req as { epoch: number }).epoch;
    if (!routingShards.every((id) => kernelOf(c, id).snap.opens.some((x) => x.epoch === epoch))) return undefined;
    signalAt = now();
    signalEpoch = epoch;
    signal();
    return c.sleep(s.windowMs);
  };
  if (spec.build && s.slowBuildMs > 0) {
    c.net.gate = (m) => {
      const req = m.req as { sql?: string; lock?: unknown };
      if (m.from === "client" && m.method === "exec" && !req.lock && /FROM "x" .*ORDER BY .* LIMIT \d+$/.test(req.sql ?? "")) return c.sleep(s.slowBuildMs);
      return undefined;
    };
  }
  let committedAt: number | null = null;
  const commit = c.commit.bind(c);
  c.commit = async (...a: Parameters<typeof commit>) => {
    // D2 の印: 書き込みを止めない DDL の commit のとき、x の生きた行ロックがある。
    if (!spec.fenced && routingShards.some((id) => {
      const k = kernelOf(c, id);
      return [...k.locks].some(([key, l]) => key.startsWith("x\0") && (k.leases.get(l.txn)?.until ?? 0) > k.deps.clock.now());
    })) marks.d2LockAtCommit = true;
    const out = await commit(...a);
    committedAt = now();
    return out;
  };
  const wounds: number[] = [];
  const abort = c.abort.bind(c);
  c.abort = (epoch: number, reason: string, wound?: boolean) => {
    if (wound) wounds.push(epoch);
    return abort(epoch, reason, wound);
  };

  // ---- 取引 ----
  const outcomes = new Map<string, TxnOutcome>();
  const until = async (t: number) => {
    const left = t - now();
    if (left > 0) await c.sleep(left);
  };
  const runTxn = async (p: TxnPlan, at: () => number, before?: () => Promise<void>) => {
    const db = conn();
    const out: TxnOutcome = { name: p.name, stmts: [], committed: false, endSentAt: null, endDoneAt: null, startedAt: now() };
    outcomes.set(p.name, out);
    let failed = false;
    const stmt = async (sql: string, params: number[] = []) => {
      if (failed) return;
      const r = await db.query(sql, params).then(() => "ok", (e: Error) => e.message);
      out.stmts.push({ sql, outcome: r, at: now() });
      if (r !== "ok") failed = true;
    };
    const read = (id: number) => stmt("SELECT v, w FROM x WHERE id = ?", [id]);
    const write = (id: number) => stmt("UPDATE x SET w = w + 1 WHERE id = ?", [id]);
    await stmt(p.immediate ? "BEGIN IMMEDIATE" : "BEGIN");
    await read(p.r1);
    if (p.role === "holder" && !p.readOnlyBefore) await write(p.r1);
    if (before) await before();
    if (p.role === "late") await write(p.r1);
    const base = at();
    if (p.writeAt !== null) {
      await until(base + p.writeAt);
      if (p.role === "holder" && !p.readOnlyBefore) await write(p.r2!);
      else await write(p.r1);
    } else if (p.role === "late" && p.r2 !== null) await write(p.r2);
    if (p.keepAliveAt !== null) {
      await until(base + p.keepAliveAt);
      await read(p.r1);
    }
    await until(base + p.endAt);
    out.endSentAt = now();
    if (failed) {
      await db.query("ROLLBACK").catch(() => undefined);
    } else {
      const end = p.rollback ? "ROLLBACK" : "COMMIT";
      const r = await db.query(end).then(() => "ok", (e: Error) => e.message);
      out.stmts.push({ sql: end, outcome: r, at: now() });
      out.committed = end === "COMMIT" && r === "ok";
      if (r !== "ok") await db.query("ROLLBACK").catch(() => undefined);
    }
    out.endDoneAt = now();
  };

  // DDL の前の文 (holder と reader)。DDL は、その 200 ms 後に始める。
  d0 = c.runtime.now() + 200;
  routingShards = shardsOf((await c.catalog()).routing);
  let ready!: () => void;
  const started = new Promise<void>((r) => (ready = r));
  const early = s.txns.filter((t) => t.role !== "late").map((t) => runTxn(t, () => 0, async () => {
    await started;
  }));
  await until(0);
  let ddlMs = -1;
  const ddl = admin.ddl(spec.sql).then(() => "ok", (e: Error) => e.message).then((r) => ((ddlMs = now()), r));
  ready();
  const late = s.txns.filter((t) => t.role === "late").map(async (t) => {
    await Promise.race([signalled, ddl]);
    await c.sleep(t.delay >= 0 ? t.delay : s.windowMs - t.delay);
    const startAt = now();
    await runTxn(t, () => startAt);
  });
  const ddlOutcome = await ddl;
  await Promise.all([...early, ...late]);
  c.net.reply = () => undefined;
  c.net.gate = () => undefined;
  await c.settle();
  const rows = await rawRows(c, "x");
  const w: Record<number, number> = {};
  for (const { row } of rows) w[Number(row.id)] = Number(row.w);
  const cat = await c.catalog();
  return {
    script: s, shards: o.shards, path: o.path, ddl: ddlOutcome, ddlMs, committedAt, signalAt,
    woundsAfterSignal: wounds.filter((e) => e === signalEpoch).length, wounds: wounds.length,
    txns: s.txns.map((t) => outcomes.get(t.name)!), w, schemaApplied: spec.check(cat as unknown as CatalogLike), marks,
  };
}

// ---- 検査 ----

/**
 * 既知の欠陥の印 (ファイルの初めの D1、D2)。違反に付け、既定の実行では伏せる。
 *   D1 lock on fence     通常の経路: シャードが、ロックを取る読みに、x が書き込み禁止の間に答えた。
 *   D1 reference read    基準経路: 読みでロックを取るはずの BEGIN IMMEDIATE の取引 (late と、DDL の前には読むだけの holder)。
 *   D2 commit under lock 書き込みを止めない index の DDL の commit のとき、x の生きた行ロックがあった。
 */
export type Mask = "D1 lock on fence" | "D1 reference read" | "D2 commit under lock";
export interface Finding { kind: string; detail: string; mask: Mask | null }
export const defectOf = (m: Mask): "D1" | "D2" => m.slice(0, 2) as "D1" | "D2";
const runMask = (r: LockRun): Mask | null => (r.marks.lockOnFence ? "D1 lock on fence" : r.marks.d2LockAtCommit ? "D2 commit under lock" : null);

/** 古い計画として断られた誤り (DDL の確定の後の書き込みと COMMIT)。 */
const STALE = /stale schema/;
/** 行ロックを持つ取引が DDL を取り消させたときの理由 (src/client/db.ts の attemptStatement)。D1 の DDL が、やり直せずにこの文で失敗する。 */
const WOUND_REASON = /reached the table's write lock on another shard, so the schema change was withdrawn to be run again/;

/**
 * 印が説明する違反の種類。印のある実行でも、ほかの種類の違反 (表、表定義、busy でない文の誤り、5 秒でない busy など) は伏せない。
 * text は、違反のもとになった誤りの文 (DDL か取引の文の答え) である。
 */
function explains(mask: Mask, kind: string, text: string): boolean {
  switch (kind) {
    case "ddl withdrawn by a later lock": return mask === "D1 lock on fence";
    case "ddl failed": return mask === "D1 lock on fence" && (classOf(text) === "busy" || WOUND_REASON.test(text));
    case "ddl error": return mask === "D1 lock on fence" && WOUND_REASON.test(text);
    case "ddl did not wait":
    case "ddl not busy": return mask !== "D1 lock on fence";
    case "holder refused":
    case "late immediate refused": return STALE.test(text);
    case "differs: ddl":
    case "differs: transaction": return mask !== "D2 commit under lock";
    default: return false;
  }
}

/** 基準経路で、読みでロックを取るはずの BEGIN IMMEDIATE の取引 (上の D1 の基準経路の印)。 */
const lockByRead = (t: TxnPlan) => t.immediate && (t.role === "late" || t.readOnlyBefore);

/**
 * 基準経路の full は、条件を押し下げずに表の全行を読む (src/sql/plan.ts の Reference)。取引の読みの範囲は表の全体になり、ほかの取引が
 * 表のどこかを書いて先に確定すれば、COMMIT が `span changed after T` の競合になる。主キーの範囲で読む経路では起きない。DDL とは関係が
 * なく、試験の経路の形の違いなので、その COMMIT の断りは数えず、比べない。
 */
const fullSpan = (r: LockRun, x: StmtOutcome) => r.path === "full" && x.sql === "COMMIT" && /^conflict: span changed after T/.test(x.outcome);

/** 1 つの実行を SQLite の答えと比べる。印のある違反には、既知の欠陥の名前を付ける。 */
export function checkRun(r: LockRun): Finding[] {
  const out: Finding[] = [];
  const refPath = r.path !== "sim";
  const holderByRead = refPath && r.script.txns.some((t) => t.role === "holder" && lockByRead(t));
  // 取引の違反は、その取引が基準経路で読みのロックを取らないなら D1 の基準経路の印、DDL と表の違反は、そういう holder がいれば同じ印。
  const add = (kind: string, detail: string, txn?: TxnPlan, text = "") => {
    const mask = runMask(r) ?? (refPath && (txn ? lockByRead(txn) : holderByRead) ? "D1 reference read" : null);
    out.push({ kind, detail, mask: mask && explains(mask, kind, text) ? mask : null });
  };
  const plans = r.script.txns;
  const byName = new Map(r.txns.map((t) => [t.name, t]));
  // DDL
  const holders = plans.filter((p) => p.role === "holder");
  const ends = holders.map((p) => byName.get(p.name)!.endSentAt ?? Infinity);
  const busyExpected = ends.some((e) => e > DDL_WAIT_MS);
  const cls = classOf(r.ddl);
  if (cls === "error") add("ddl error", `the DDL failed with an error that is not busy: ${r.ddl}`, undefined, r.ddl);
  if (busyExpected) {
    if (cls !== "busy") add("ddl not busy", `a holder kept its locks past 5 s, but the DDL ${r.ddl} after ${r.ddlMs} ms`, undefined, r.ddl);
    else if (r.ddlMs < DDL_WAIT_MS - 100 || r.ddlMs > DDL_WAIT_MS + 700) add("ddl busy at the wrong time", `the DDL was busy after ${r.ddlMs} ms, not at 5 s`);
  } else {
    if (cls !== "ok") add("ddl failed", `no holder kept its locks past 5 s, but the DDL failed after ${r.ddlMs} ms: ${r.ddl}`, undefined, r.ddl);
    const lastEnd = Math.max(0, ...ends.filter(Number.isFinite));
    if (cls === "ok" && r.ddlMs < lastEnd) add("ddl did not wait", `the DDL committed after ${r.ddlMs} ms, before a holder ended at ${lastEnd} ms`);
  }
  // 全シャードが prepare を適用したとき、x の行ロックはどこにもなかった。その後にロックを取った取引が、DDL を取り消させてはならない
  // (asSqlite: その後の取引は、SQLite では DDL の書き込みのロックを待つ)。
  if (r.woundsAfterSignal > 0) add("ddl withdrawn by a later lock", `a lock taken after every shard had applied the prepare withdrew the DDL ${r.woundsAfterSignal} time(s); the DDL ${r.ddl} after ${r.ddlMs} ms`);
  if ((cls === "ok") !== r.schemaApplied) add("schema", `the DDL ${r.ddl}, but its change is ${r.schemaApplied ? "" : "not "}in the catalog`);
  // 取引
  for (const p of plans) {
    const t = byName.get(p.name)!;
    const refused = t.stmts.filter((x) => x.outcome !== "ok" && !fullSpan(r, x));
    for (const x of refused) if (classOf(x.outcome) === "error") add("statement error", `${p.name}: ${x.sql} failed with an error that is not busy: ${x.outcome}`, p);
    const mustPass = p.role === "holder" || (p.role === "late" && p.immediate);
    if (mustPass && refused.length > 0) {
      add(p.role === "holder" ? "holder refused" : "late immediate refused", `${p.name} (${p.immediate ? "BEGIN IMMEDIATE" : "BEGIN"}, ${p.role}): ${refused[0]!.sql} at ${refused[0]!.at} ms: ${refused[0]!.outcome}`, p, refused[0]!.outcome);
    }
  }
  // 表
  const want: Record<number, number> = {};
  for (let id = 1; id <= ROWS; id++) want[id] = 0;
  for (const p of plans) {
    const t = byName.get(p.name)!;
    if (!t.committed) continue;
    want[p.r1]! += 1;
    if (p.r2 !== null) want[p.r2]! += 1;
  }
  for (let id = 1; id <= ROWS; id++) if ((r.w[id] ?? -1) !== want[id]) add("table", `row ${id} has w = ${r.w[id]}, the committed transactions wrote ${want[id]}`);
  return out;
}

/** 実行の要約 (4 つの実行の間で比べるもの)。 */
const summary = (r: LockRun) => ({
  ddl: classOf(r.ddl),
  txns: Object.fromEntries(r.script.txns.filter((p) => p.role === "holder" || (p.role === "late" && p.immediate)).map((p) => [p.name, r.txns.find((t) => t.name === p.name)!.committed])),
});

/** 2 つの実行を比べる。どちらかの実行に印があれば、その印を付ける。 */
export function compareRuns(a: LockRun, b: LockRun): Finding[] {
  const sa = summary(a);
  const sb = summary(b);
  const mask: Mask | null = runMask(a) ?? runMask(b);
  const out: Finding[] = [];
  const label = (r: LockRun) => `${r.shards} shard${r.shards > 1 ? "s" : ""} ${r.path}`;
  const ref = [a, b].some((r) => r.path !== "sim");
  if (sa.ddl !== sb.ddl) {
    const m = mask ?? (ref && a.script.txns.some((t) => t.role === "holder" && lockByRead(t)) ? "D1 reference read" : null);
    out.push({ kind: "differs: ddl", detail: `${label(a)}: ${a.ddl}; ${label(b)}: ${b.ddl}`, mask: m && explains(m, "differs: ddl", "") ? m : null });
  }
  const spanRefused = (r: LockRun, name: string) => r.txns.find((t) => t.name === name)!.stmts.some((x) => fullSpan(r, x));
  for (const p of a.script.txns) {
    if (!(p.name in sa.txns) || sa.txns[p.name] === sb.txns[p.name]) continue;
    if (spanRefused(a, p.name) || spanRefused(b, p.name)) continue;
    const m = mask ?? (ref && lockByRead(p) ? "D1 reference read" : null);
    out.push({ kind: "differs: transaction", detail: `${p.name}: ${label(a)} ${sa.txns[p.name] ? "committed" : "did not commit"}; ${label(b)} ${sb.txns[p.name] ? "committed" : "did not commit"}`, mask: m && explains(m, "differs: transaction", "") ? m : null });
  }
  return out;
}

export interface SeedReport { script: LockScript; runs: LockRun[]; findings: Finding[] }

/** seed の台本を、1 シャードと 2 シャード、通常の経路と基準経路で流し、調べる。基準経路は、seed の偶奇で scans か full にする。 */
export async function lockHoldersSeed(seed: number): Promise<SeedReport> {
  const script = lockScript(seed);
  const ref: Reference = seed % 2 === 0 ? "scans" : "full";
  const runs: LockRun[] = [];
  for (const path of ["sim", ref] as const) for (const shards of [1, 2]) runs.push(await runLockScript(script, { shards, path }));
  const findings = runs.flatMap((r) => checkRun(r).map((f) => ({ ...f, detail: `${r.shards} shard(s) ${r.path}: ${f.detail}` })));
  const [sim1, sim2, ref1, ref2] = runs as [LockRun, LockRun, LockRun, LockRun];
  findings.push(...compareRuns(sim1, sim2), ...compareRuns(ref1, ref2), ...compareRuns(sim1, ref1), ...compareRuns(sim2, ref2));
  return { script, runs, findings };
}
