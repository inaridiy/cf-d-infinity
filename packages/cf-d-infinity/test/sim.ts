import { compoundTerms, depthOf, SHARD_LIMITS } from "../src/shard-limits";
import { createHash } from "node:crypto";
import { DatabaseSync } from "node:sqlite";
import { Db, type ClientFaults, type Cluster } from "../src/client/db";
import { keyString } from "../src/keys";
import { fold, type EpochRecord, type Move } from "../src/catalog";
import { MetaCore, type Catalog } from "../src/meta";
import { initialRouting, regionsOf, shardsOf, tokenOf, type Interval, type Routing } from "../src/routing";
import { type Runtime, sleep, systemRuntime } from "../src/runtime";
import type { Reference } from "../src/sql/plan";
import { ShardCore, type SpanEscape, type WriteCheck } from "../src/shard/core";
import { imageColumns } from "../src/shard/rows";
import { isWideSpan, type Backend, type Change, type ExecReq, type Faults, type Plain, type PlainRow, type ShardApi, type Span, type TableDef, type Ts, type Value } from "../src/types";
import { bindPlain, bindTyped, decodeElem, restoreColumns, type Tuple } from "../src/value";

/**
 * DO の SQLite の実測の制限 (公式の表にないもの)。node:sqlite は上限を変えられないので、文を見て模す。
 * UNION、INTERSECT、EXCEPT で 6 項以上の複合 SELECT は「too many terms in compound SELECT」になる。
 */
export const DO_COMPOUND_SELECT_LIMIT = 5;
/** DO の SQLite の公表されている制限。node:sqlite の既定はどれもこれより緩いので、ここで模す。 */
export const DO_MAX_SQL_BYTES = 100_000;
export const DO_MAX_BOUND_PARAMS = 100;
export const DO_MAX_VALUE_BYTES = 2_000_000;
/**
 * DO の SQLite は、結果の列を 100 までに制限している (表の列の上限と同じ値。test/workerd-limits.test.ts が workerd で確かめている)。
 * node:sqlite は 2,000 列まで受け付ける。ここで模さないと、101 列を返す文がシミュレータでだけ通る。
 * 本物は、サブクエリと CTE の列の数にも同じ上限を掛ける。ここで見るのは、文の結果の列だけである。
 */
export const DO_MAX_RESULT_COLUMNS = 100;
function checkDoColumns(count: number): void {
  if (count > DO_MAX_RESULT_COLUMNS) throw new Error("too many columns in result set: SQLITE_ERROR");
}
/**
 * DO の SQLite は、式の木の深さを 100 までに制限している (test/workerd-limits.test.ts)。node:sqlite は 1,000 まで受け付けるので、
 * ここで模す (段 3 で足した。計画書の未解決の問題 39)。深さは、シャードが文を測るのと同じ見積もり (src/sql/depth.ts) で数える。
 * 見積もりは SQLite の数え方より小さくならないので、ここで断る文は、DO でも断られ得る。シャードの入口 (src/shard-limits.ts) と
 * プランナは同じ見積もりで文を上限に収めるので、ここに当たるのは、確かめを通らずにシャードが実行した文だけである。
 */
function checkDoDepth(sql: string): void {
  const depth = depthOf(sql);
  if (depth > SHARD_LIMITS.exprDepth) throw new Error(`Expression tree is too large (maximum depth ${SHARD_LIMITS.exprDepth}; this statement is estimated at ${depth}): SQLITE_ERROR`);
}
function checkDoLimits(sql: string, params: Value[] = []): void {
  // 本物の DO は複合 SELECT の項を数える。シャードの側の確かめ (src/shard-limits.ts) と同じ数え方にする。引用符の中の識別子まで
  // 数えると、本物では通る文をここだけが断る (検査の誤り。2026-11-13)。
  const terms = compoundTerms(sql);
  if (terms > DO_COMPOUND_SELECT_LIMIT) throw new Error("too many terms in compound SELECT: SQLITE_ERROR");
  if (Buffer.byteLength(sql) > DO_MAX_SQL_BYTES) throw new Error("statement too long: SQLITE_TOOBIG");
  if (params.length > DO_MAX_BOUND_PARAMS) throw new Error("too many SQL variables: SQLITE_ERROR");
  for (const p of params) {
    const bytes = typeof p === "string" ? Buffer.byteLength(p) : p instanceof Uint8Array ? p.byteLength : 0;
    if (bytes > DO_MAX_VALUE_BYTES) throw new Error("string or blob too big: SQLITE_TOOBIG");
  }
}

/**
 * 値の型を区別しない比べ方のために、INTEGER (bigint) を JS の数にする。node:sqlite の既定の読み (数) と比べる検査が使う。
 * 2^53 を超える整数は丸まるので、その値を使う検査 (test/int64.test.ts、test/typed-diff.test.ts) は、これを使わずに型ごと比べる。
 */
export const asNumbers = <T>(rows: T[][]): T[][] => rows.map((r) => r.map((v) => (typeof v === "bigint" ? Number(v) : v)) as T[]);

/** seed から決まる乱数 (mulberry32)。 */
export function prng(seed: number): () => number {
  let a = seed >>> 0;
  return () => {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 2 ** 32;
  };
}

/**
 * 乱択の検査が流す seed。既定は、試験に書いてある数個である。環境変数 SEEDS を与えると、それに替える。
 * `SEEDS=1..500` は範囲、`SEEDS=3,17,204` は列挙である。失敗した seed を再現するときと、seed を大量に流して
 * 失敗を探すとき (scripts/sweep.mjs) に使う。
 */
export function seedsOr(defaults: number[]): number[] {
  const spec = process.env.SEEDS;
  if (!spec) return defaults;
  return spec.split(",").flatMap((part) => {
    const m = /^(\d+)\.\.(\d+)$/.exec(part.trim());
    if (m) return Array.from({ length: Number(m[2]) - Number(m[1]) + 1 }, (_, i) => Number(m[1]) + i);
    if (!/^\d+$/.test(part.trim())) throw new Error(`SEEDS: cannot read "${part}"; write 1..500 or 3,17,204`);
    return [Number(part)];
  });
}

/**
 * 基準経路だけの実行 (環境変数 REFERENCE) か。最適化の経路そのものを確かめる試験 (文が 1 シャードで済むこと、行ロックの待ち、
 * 欠陥を戻したときにその経路で検査が気付くこと) は、`it.skipIf(REFERENCE_ONLY)` で外す。
 */
export const REFERENCE_ONLY = Boolean(process.env.REFERENCE);

function referenceFromEnv(): Reference | undefined {
  const v = process.env.REFERENCE;
  if (!v) return undefined;
  if (v !== "scans" && v !== "full") throw new Error(`REFERENCE: cannot read "${v}"; write scans or full`);
  return v;
}

/**
 * 仮想の実行環境。同じ seed なら、同じ実行になる。
 *
 * 時刻は、予約された出来事 (待ちの終わり、RPC の配送) が起きるときにだけ進む。乱数と識別子は seed から決まる。
 * 出来事は、時刻の順 (同じ時刻なら予約した順) に 1 つずつ起こす。1 つ起こすたびに、本物の setImmediate を挟んで、
 * その出来事が起こした処理が待ちに入るまで進ませる。だから出来事の順序は、実時間の経過にも、計算機の負荷にも依らない。
 *
 * 決定的でなくなるのは、試験が本物のタイマーや入出力を混ぜたときである。待ちは sleep() で書く。
 */
export class VirtualRuntime implements Runtime {
  private t: number;
  private seq = 0;
  private ids = 0;
  private queue: { at: number; seq: number; fn: (() => void) | null }[] = [];
  private pumping = false;
  /** 起こした出来事の数。 */
  steps = 0;
  /** 出来事の数か時刻がこれを超えたら、onStall を 1 度だけ呼ぶ。終わらない実行を、制限時間ではなく原因の分かる失敗にする。 */
  budget: { steps: number; until: number } | null = null;
  onStall: ((why: string) => void) | null = null;
  readonly random: () => number;
  constructor(readonly seed = 1, start = 1_000_000) {
    this.t = start;
    this.random = prng(seed);
  }
  /** 本物の時計と同じく、整数の ms を返す。出来事の順序は、端数まで含めた時刻で決める。 */
  now(): number {
    return Math.floor(this.t);
  }
  /** 時計だけを進める。予約済みの出来事は、進めた後の時刻で順に起きる。 */
  set(ms: number): void {
    this.t = ms;
  }
  after(ms: number, fn: () => void): unknown {
    const e = { at: this.t + Math.max(0, ms), seq: this.seq++, fn };
    // 時刻、予約の順で並べておく。件数は少ないので、挿入位置は後ろから探す。
    let i = this.queue.length;
    while (i > 0 && (this.queue[i - 1]!.at > e.at)) i--;
    this.queue.splice(i, 0, e);
    this.pump();
    return e;
  }
  cancel(handle: unknown): void {
    if (handle) (handle as { fn: (() => void) | null }).fn = null;
  }
  uuid(): string {
    return `${(this.ids++).toString(36)}-${Math.floor(this.random() * 2 ** 32).toString(16).padStart(8, "0")}`;
  }
  private pump(): void {
    if (this.pumping) return;
    this.pumping = true;
    setImmediate(() => {
      this.pumping = false;
      let e = this.queue.shift();
      while (e && e.fn === null) e = this.queue.shift(); // 取り消された予約
      if (!e) return;
      if (e.at > this.t) this.t = e.at;
      this.steps++;
      if (this.budget && this.onStall && (this.steps > this.budget.steps || this.t > this.budget.until)) {
        const stalled = this.onStall;
        this.onStall = null;
        stalled(this.steps > this.budget.steps ? `more than ${this.budget.steps} events` : `simulated time passed ${Math.floor(this.budget.until)} ms`);
      }
      const fn = e.fn!;
      if (this.queue.length > 0) this.pump();
      fn();
    });
  }
}

/**
 * DO の SQLite は、2^53 を超える INTEGER を、精度を落とした JS の数で返す。node:sqlite は既定では例外を投げるので、BigInt で読んで、
 * DO と同じように数にする。
 */
const lossy = (v: unknown): Plain => (typeof v === "bigint" ? Number(v) : (v as Plain));

/**
 * DO のドライバは、結果の TEXT を NUL (U+0000) を含めて全部返す。node:sqlite のドライバは、最初の NUL で切って返す
 * (docs/design-values.md の「確かめた事実」)。シミュレータがそのまま返すと、NUL を含む TEXT を、シャードの側も基準の側も
 * 同じように切って、食い違いが見えない (test/open/nul-in-text.test.ts が見つけた検査の欠け)。
 *
 * そこで、利用者の表に触る文 (Backend.query) のうち、結果を返す文 (SELECT、VALUES、WITH で始まる文) は、DO のドライバと同じ値に
 * なるように包み直して読む。TEXT は BLOB にして運び (CAST(... AS BLOB) は全部のバイトを返す)、UTF-8 として戻す。BLOB は 16 進の
 * 文字列で運ぶ。結果の列を 2 回以上参照するので、`LIMIT -1 OFFSET 0` で、包む前の文を 1 行につき 1 回だけ評価させる。
 * DML の RETURNING は包めないが、D∞ は RETURNING の項を、TEXT を BLOB で運ぶ要素の式に書き換えて送る (src/value.ts の
 * returningElemSql) ので、そのまま読んでも切れない。内部の表の文 (exec、raw、iterate) は包まない。内部の表の TEXT は、JSON か
 * キー文字列で、NUL をそのまま持たない (JSON は `\u0000` と書く)。
 */
const READS_ROWS = /^\s*(?:(?:--[^\n]*(?:\n|$)|\/\*[\s\S]*?\*\/)\s*)*(SELECT|VALUES|WITH)\b/i;
const wholeTextCache = new Map<string, string>();
function wholeTextSql(sql: string, n: number): string {
  const key = `${n}\0${sql}`;
  let hit = wholeTextCache.get(key);
  if (hit === undefined) {
    const cols = Array.from({ length: n }, (_v, i) => `"c${i}"`);
    const read = cols.map((c) => `CASE typeof(${c}) WHEN 'text' THEN CAST(${c} AS BLOB) WHEN 'blob' THEN hex(${c}) ELSE ${c} END`);
    hit = `WITH "__dinf_sim"(${cols.join(", ")}) AS (\n${sql}\n) SELECT ${read.join(", ")} FROM (SELECT * FROM "__dinf_sim" LIMIT -1 OFFSET 0)`;
    if (wholeTextCache.size >= 4096) wholeTextCache.delete(wholeTextCache.keys().next().value!);
    wholeTextCache.set(key, hit);
  }
  return hit;
}
const utf8Text = new TextDecoder();
const fromHex = (s: string) => Uint8Array.from(s.match(/../g) ?? [], (h) => parseInt(h, 16));

/**
 * query の文が、ドライバから INTEGER を読んだ (docs/design-values.md の「シミュレータ」の 3 つ目)。型つきの読みの形の文は、INTEGER を
 * 印つきの文字列で返すので、INTEGER がドライバから数として出てくるのは、包み忘れた文だけである。DO のドライバは、その INTEGER を
 * 丸めた数で返し、D∞ はそれを REAL として読む。範囲の検査と同じく、test/setup.ts が試験ごとに確かめて空にする。
 */
export const allDriverIntegers: string[] = [];

/** node:sqlite の Backend。fence() 後の操作は失敗する (DO 基盤が旧 instance を止めるのと同じ)。 */
export class SqliteBackend implements Backend {
  fenced = false;
  depth = 0;
  /** quorum の確定の待ちに使う。SimCluster が自分のものに差し替える。 */
  rt: Runtime = systemRuntime;
  constructor(readonly db = new DatabaseSync(":memory:")) {}
  /**
   * 用意した文を、文面ごとに覚えて使い回す。シミュレータの時間の大半は文を用意することで、利用者の表の読みは、元の文 (結果の
   * 列名を知るため) と包み直した文の 2 つを用意する。文を読み終えるまで同じ Backend に別の文を挟まない約束 (Backend.iterate) が
   * あるので、同じ文を 2 か所で同時に読むことはない。
   * 表定義を変える文が来たら、覚えた文を全部捨てる。SQLite は古い文を実行するときに用意し直すが、実行の前に読む結果の列名
   * (columns()) は古い表定義のままで、`SELECT *` の列が足りなくなる。表定義を変えた後の巻き戻しも、表定義を戻すので、捨てる。
   */
  private statements = new Map<string, ReturnType<DatabaseSync["prepare"]>>();
  /** 表定義を変える文を用意した回数。巻き戻しが表定義も戻したかを知るのに使う。 */
  private schemaChanges = 0;
  private statement(sql: string): ReturnType<DatabaseSync["prepare"]> {
    if (/^\s*(CREATE|ALTER|DROP)\b/i.test(sql)) {
      this.statements.clear();
      this.schemaChanges++;
      return this.db.prepare(sql);
    }
    let st = this.statements.get(sql);
    if (st === undefined) {
      st = this.db.prepare(sql);
      if (this.statements.size >= 512) this.statements.delete(this.statements.keys().next().value!);
      this.statements.set(sql, st);
    }
    return st;
  }
  /**
   * 文を用意して、結果の列名と、行を読む関数を返す。結果のない文は、ここで実行する。
   * node:sqlite も DO の SQLite と同じく、JS の数を REAL として束縛する。束縛の仕方は DO と同じにする (src/value.ts)。
   * DO の上限は、束縛のために書き換えた後の文に掛かる (書き換えで文が長くなる)。
   */
  private prepare(
    sql: string, b: { sql: string; params: Plain[]; columns: Map<string, string> | null }, user: boolean,
  ): { columns: string[]; read: ((all: boolean) => Iterable<Plain[]>) | null } {
    if (this.fenced) throw new Error("fenced instance");
    // DO の SQLite は BigInt を束縛できない。束縛の書き換え (bindTyped) が、いつも数か文字列にする。
    for (const p of b.params) if (typeof p === "bigint") throw new TypeError("a BigInt reached the driver; the DO SQLite cannot bind it");
    checkDoLimits(b.sql, b.params);
    checkDoDepth(b.sql);
    const st = this.statement(b.sql);
    const p = b.params as never[];
    const columns = restoreColumns(st.columns().map((c) => c.name), b.columns);
    checkDoColumns(columns.length);
    if (columns.length === 0) {
      st.run(...p);
      return { columns, read: null };
    }
    let reader = st;
    let convert: (v: unknown) => Plain = lossy;
    if (user) {
      const integer = (v: bigint): Plain => {
        allDriverIntegers.push(`${sql.slice(0, 160)} returned the INTEGER ${v} as a driver number`);
        return Number(v);
      };
      convert = (v) => (typeof v === "bigint" ? integer(v) : (v as Plain));
      if (READS_ROWS.test(b.sql)) {
        try {
          reader = this.statement(wholeTextSql(b.sql, columns.length));
          convert = (v) => (v instanceof Uint8Array ? utf8Text.decode(v) : typeof v === "string" ? fromHex(v) : typeof v === "bigint" ? integer(v) : (v as Plain));
        } catch (e) {
          // WITH で始まる DML (RETURNING のある書き込み) は包めない。そのまま読む。ほかの文が包めないのは、包み方の誤りなので投げる
          // (黙って素の列で読むと、NUL を含む TEXT が切れても誰も気付かない)。
          if (!(/^\s*WITH\b/i.test(b.sql) && /\b(INSERT|UPDATE|DELETE|REPLACE)\b/i.test(b.sql))) throw e;
        }
      }
    }
    reader.setReturnArrays(true);
    reader.setReadBigInts(true);
    return {
      columns,
      read: (all) => {
        if (all) return (reader.all(...p) as unknown as unknown[][]).map((r) => r.map(convert));
        const it = reader.iterate(...p) as unknown as Iterable<unknown[]>;
        return (function* () { for (const r of it) yield r.map(convert); })();
      },
    };
  }
  exec(sql: string, ...params: Plain[]): PlainRow[] {
    const { columns, read } = this.prepare(sql, bindPlain(sql, params, "real"), false);
    if (!read) return [];
    return [...read(true)].map((r) => Object.fromEntries(columns.map((c, i) => [c, r[i] ?? null])));
  }
  iterate(sql: string, ...params: Plain[]): { columns: string[]; rows: Iterable<Plain[]> } {
    const { columns, read } = this.prepare(sql, bindPlain(sql, params, "real"), false);
    return { columns, rows: read ? read(false) : [] };
  }
  raw(sql: string, ...params: Plain[]): { columns: string[]; values: Plain[][] } {
    const { columns, read } = this.prepare(sql, bindPlain(sql, params, "real"), false);
    return { columns, values: read ? [...read(true)] : [] };
  }
  query(sql: string, params: readonly Value[]): { columns: string[]; rows: Iterable<Plain[]> } {
    const { columns, read } = this.prepare(sql, bindTyped(sql, params, "real"), true);
    return { columns, rows: read ? read(false) : [] };
  }
  tx<T>(fn: () => T): T {
    const name = `sp${this.depth++}`;
    const schema = this.schemaChanges;
    this.db.exec(`SAVEPOINT ${name}`);
    try {
      const out = fn();
      this.db.exec(`RELEASE ${name}`);
      return out;
    } catch (e) {
      this.db.exec(`ROLLBACK TO ${name}`);
      this.db.exec(`RELEASE ${name}`);
      if (this.schemaChanges !== schema) this.statements.clear();
      throw e;
    } finally {
      this.depth--;
    }
  }
  /**
   * 確定していない書き込みを、再起動で失う模擬 (SimCluster.loseUnsynced)。有効にした後の書き込みは SQLite の取引に溜まり、
   * sync() が終わると確定する (COMMIT)。再起動 (SimCluster.restart) は、確定していない分を捨てる (ROLLBACK)。
   * 既定では無効で、書き込みはすぐ確定し、再起動でも失われない。本番の DO は、sync() を呼ばなくても数 ms で書き込みを確定させる。
   * これは、その確定の前に再起動した場合を表す。
   */
  private holding: "off" | "open" | "lost" = "off";
  holdUnsynced(): void {
    if (this.holding === "open") return;
    this.db.exec("BEGIN");
    this.holding = "open";
  }
  /** 確定していない書き込みを捨てる。再起動の模擬が、旧 instance に対して呼ぶ。無効なら何もしない。 */
  dropUnsynced(): void {
    if (this.holding !== "open") return;
    this.db.exec("ROLLBACK");
    this.statements.clear();
    this.holding = "lost";
  }
  /** quorum の確定には本番で約 10 ms かかる。ここで処理が譲られないと、待ちの間のレースを再現できない。 */
  async sync(): Promise<void> {
    await sleep(this.rt, this.rt.random() * 2);
    if (this.holding === "off") return;
    // 再起動した旧 instance の確定は成功しない。COMMIT すると、同じ SQLite を使う新しい instance の書き込みを確定させてしまう。
    if (this.holding === "lost" || this.fenced) throw new Error("fenced instance: the shard restarted before its writes were confirmed");
    this.db.exec("COMMIT");
    this.db.exec("BEGIN");
  }
  size(): number {
    const r = this.db.prepare(`SELECT page_count * page_size s FROM pragma_page_count(), pragma_page_size()`).get() as { s: number };
    return r.s;
  }
}

export interface Rpc {
  from: string;
  to: string;
  method: keyof ShardApi;
  req: unknown;
}

/** メッセージの配送を制御できるネットワーク。gate が返す Promise まで配送を止める。 */
export class SimNet {
  gate: (m: Rpc) => Promise<void> | void = () => {};
  drop: (m: Rpc) => boolean = () => false;
  log: Rpc[] = [];
  /** 失敗した RPC と、その誤りの文。検査が、断られた理由を数えるのに使う。 */
  failed: { m: Rpc; message: string }[] = [];
  jitter: (() => number) | null = null;
  /**
   * 応答の配送を止める。処理は終わっていて、結果だけが呼び出し側へ届かない状態を作る。
   * 本番の RPC の応答は output gate と網の遅延を経るので、この間に別の要求が同じシャードで処理される。
   * 既定では何もしない。
   */
  reply: (m: Rpc) => Promise<void> | void = () => {};
}

/** Worker の側の欠陥のスイッチの名前 (src/client/db.ts の ClientFaults)。 */
const CLIENT_FAULTS = new Set([
  "repinOnRestore", "replayAcrossSchemaChange", "dropWithoutGuard", "noImplicitCommit", "ddlAfterFailedCommit",
  "publishBeforeBackfill", "checkBeforePrepare", "scanSkipsEmpty", "guardFromCommitTs",
  "lockedReadsSkipValidation", "secondDmlNewSince", "secondDmlNewSpanSince",
]);
/**
 * Worker と Meta の両方が読むスイッチの名前。1 つの欠陥を、2 つの守りを外して戻す (commitWithoutAcks は、Worker が 1 つのシャードの
 * prepared を待たず、Meta が ok の集合を確かめない)。injectedFault は、両方に入れる。
 */
const BOTH_FAULTS = new Set(["commitWithoutAcks"]);
/** 範囲の作り方の欠陥のスイッチの名前 (src/client/spans.ts の spanFaults)。test/setup.ts が入れる。 */
export const SPAN_FAULTS = new Set(["rowSpanDespiteUnique"]);
/** 行イメージを値に戻すところの欠陥のスイッチの名前 (src/shard/rows.ts の imageFaults)。test/setup.ts が入れる。 */
export const IMAGE_FAULTS = new Set(["roundedImages"]);

/**
 * 環境変数 FAULT で、欠陥のスイッチを 1 つ、全部のシミュレータに入れる。乱択の検査が、その欠陥を見つけるかを測るためにある
 * (scripts/fault-table.mjs)。試験が自分で入れるスイッチには、上書きせずに足す。
 */
export function injectedFault(): { name: string; side: "shard" | "client" | "both" | "span" | "image" } | null {
  const name = process.env.FAULT;
  if (!name) return null;
  return {
    name,
    side: BOTH_FAULTS.has(name) ? "both" : CLIENT_FAULTS.has(name) ? "client" : SPAN_FAULTS.has(name) ? "span" : IMAGE_FAULTS.has(name) ? "image" : "shard",
  };
}

export interface SimOptions {
  /**
   * 保存データから起動する (test/upgrade.test.ts)。Meta とシャードの SQLite をそのまま使う。シャードの一覧は shards の鍵である。
   * 指定したときは、shards (数) は無視する。
   */
  stored?: { meta: DatabaseSync; shards: Map<string, DatabaseSync> };
  shards?: number;
  /** シャードと Meta の側の欠陥のスイッチ。 */
  faults?: Faults;
  /** このクラスタへつなぐ Db と、分割を進める側 (autoscaler.ts の split) の欠陥のスイッチの既定。 */
  clientFaults?: ClientFaults;
  skewMs?: (id: string) => number;
  K?: number;
  now?: () => number;
  lockTtlMs?: number;
  logRetainMs?: number;
  logGenMs?: number;
  txnRetainMs?: number;
  recentMax?: number;
  /** 範囲の検査 (ShardDeps.spanEscape) と、書き込みの側の範囲の検査 (ShardDeps.writeCheck) を切る。既定では掛ける。 */
  noSpanCheck?: boolean;
  /**
   * 行イメージの検査 (src/shard/rows.ts の imageChecks。捕捉の変更後の行と本体の行、タプルの長さと表定義) を、このクラスタを作った
   * 試験の間だけ切る。守りを外して古い欠陥を再現する試験が使う。既定では掛ける。
   */
  noImageCheck?: boolean;
  /** 仮想の実行環境の seed。同じ seed なら同じ実行になる。 */
  seed?: number;
  /** 表定義の遷移 (prepare から commit か abort まで) の、書き込み禁止の期限と、その上限 (ms)。既定は meta.ts の LEASE_MS と TRANSITION_MAX_MS。 */
  leaseMs?: number;
  buildMaxMs?: number;
  /**
   * 本物の時計とタイマーで動かす。実行は再現できない。本物のタイマーで待つ、まだ移していない試験のためにある。
   * now を渡したときも、こちらになる。
   */
  realTime?: boolean;
}

/**
 * 書き込みの側の範囲の検査 (SimCluster の checkWrites) が見つけた書き込み。シャードが受け入れようとした変更の行が、宣言の外にあるか、
 * そのシャードが持たない行として残るものである。
 */
export interface WriteEscape {
  shard: string;
  /** 文の実行なら、その文。取引が溜めた変更を確定のときに受け取る経路 (commitLocal、prepare) なら null。 */
  sql: string | null;
  /** `表 主キー` */
  row: string;
  problem: string;
}

/** 行イメージから、行の主キーと shard key のキー文字列を読む。シャードの読み方 (rows.ts の tupleKey) を使わずに、ここで読む。 */
function keyOfImage(def: TableDef, t: Tuple): { pk: string; sk: string } {
  const cols = imageColumns(def);
  const at = (c: string): Value => {
    const i = cols.indexOf(c);
    return i >= 0 && i < t.length ? decodeElem(t[i] ?? null) : null;
  };
  return { pk: keyString(def.pk.map(at)), sk: keyString(def.shardKey.map(at)) };
}

/** 宣言した範囲 s が、行 (表 table、キー key、token) を覆うか。全表の範囲は、claim があれば、その token の区間の行だけを覆う。 */
function declaresRow(s: Span, table: string, key: { pk: string; sk: string }, token: number): boolean {
  if (s.table !== "*" && s.table !== table) return false;
  if (s.kind === "pk") return s.pk === key.pk;
  if (s.kind === "sk") return s.sk === key.sk;
  if (s.kind === "pred" && s.sk !== undefined) return s.sk === key.sk;
  return s.claim === undefined || s.claim.some((x) => token >= x.start && token < x.end);
}

/** 子として移動を進めるシャードの alarm の間隔 (DO の alarm と同じ 5 秒) と、続けて発火させる回数の上限 (SimCluster.armMoveAlarm)。 */
const MOVE_ALARM_MS = 5_000;
const MOVE_ALARM_LIMIT = 60;

/** Worker と DO の間の RPC だけをシミュレートしたクラスタ。ShardCore は本物を動かす。 */
/** このプロセスの全クラスタで見つかった、範囲の外の行に依存する文。test/setup.ts が試験ごとに確かめて空にする。 */
export const allSpanEscapes: SpanEscape[] = [];
/** このプロセスの全クラスタで見つかった、宣言の外か持ち主でないシャードへの書き込み。test/setup.ts が試験ごとに確かめて空にする。 */
export const allWriteEscapes: WriteEscape[] = [];

/**
 * 全表の読みの区間の検査 (specs/m19_claim_resplit.qnt の SPLIT_EXACT、反例 m19_red_gap)。Worker が 1 つの全表の読みで使った答えの
 * claim は、1 つの範囲表のスナップショットで、token の全体をちょうど覆わなければならない。抜けた区間の行は、どのシャードからも返らない。
 * どのシャードも、自分の持たない claim には答えていないので、シャードの側の検査 (範囲の検査、書き込みの側の検査) では見えない
 * (M19 の「どのシャードも、持っていない claim には答えていない」)。
 *
 * 確かめ方。シミュレータの stub が、Worker へ返す exec の答えごとに、その答えを返した要求 (宛先、span と claim、名乗った epoch) を覚える
 * (answeredBy)。test/setup.ts が、Worker が複数のシャードの答えを 1 つの文の答えにまとめるところ (src/client/db.ts の ReadScope.budgeted)
 * から、使った答えの組を受け取って、ここへ渡す。全表の span (isWideSpan で、claim のあるもの) について、要求の文面と表ごとに次を確かめる。
 *   1. 使った答えの要求は、どれも同じ epoch を名乗る (1 つのスナップショット)。
 *   2. その epoch まで Meta の列を畳んだ範囲表 R で、尋ねたシャードの集まりが R のシャードの全部で、同じシャードは 1 度だけである。
 *   3. どの要求の claim も、R でそのシャードが持つ区間 (regionsOf) と同じである。
 * 3 つが揃えば、claim は R の区間をちょうど 1 度ずつ覆う。答えを覚えていない組 (シミュレータの外の Cluster) は確かめない。
 * 確かめるだけで、処理は変えない (RPC の列も変わらない)。見つけたものは test/setup.ts が試験ごとに確かめる。
 */
export const allTilingProblems: string[] = [];
/** 確かめた組の数と、答えを覚えていないので確かめなかった組の数。検査が空回りしていないことを、試験が確かめるのに使う。 */
export const tilingStats = { checked: 0, unknown: 0 };
const answeredBy = new WeakMap<object, { c: SimCluster; shard: string; req: ExecReq }>();

const intervalsText = (xs: readonly Interval[]) => xs.map((x) => `[${x.start}, ${x.end})`).join(" ") || "none";
const sameIntervals = (a: readonly Interval[], b: readonly Interval[]) => {
  const key = (xs: readonly Interval[]) => xs.map((x) => `${x.start}-${x.end}`).sort().join(",");
  return key(a) === key(b);
};

/** Worker が 1 つの文の答えにまとめた、シャードの答えの組 parts を確かめる (上の allTilingProblems)。 */
export function checkTiling(parts: readonly unknown[]): void {
  const sent = parts.map((p) => (p !== null && typeof p === "object" ? answeredBy.get(p) : undefined));
  if (sent.length === 0) return;
  if (sent.some((s) => s === undefined)) {
    tilingStats.unknown++;
    return;
  }
  const asked = sent as { c: SimCluster; shard: string; req: ExecReq }[];
  // 文面と表ごとに分ける。1 つの組の要求は、いまは同じ文面である (走査か押し下げた読み)。
  const byTable = new Map<string, { sql: string; table: string; used: { shard: string; claim: Interval[]; epoch: number }[] }>();
  for (const s of asked) {
    for (const sp of s.req.spans) {
      if (!isWideSpan(sp) || sp.claim === undefined) continue;
      const k = `${sp.table}\0${s.req.sql}`;
      const g = byTable.get(k) ?? { sql: s.req.sql.slice(0, 160), table: sp.table, used: [] };
      g.used.push({ shard: s.shard, claim: sp.claim, epoch: s.req.epoch });
      byTable.set(k, g);
    }
  }
  if (byTable.size === 0) return;
  tilingStats.checked++;
  const c = asked[0]!.c;
  for (const { sql, table, used } of byTable.values()) {
    const epochs = [...new Set(used.map((u) => u.epoch))].sort((a, b) => a - b);
    if (epochs.length > 1) {
      allTilingProblems.push(`${sql} | table ${table}: the answers come from routing snapshots at epochs ${epochs.join(", ")}: ${used.map((u) => `${u.shard}@${u.epoch}`).join(" ")}`);
      continue;
    }
    const R = c.routingAt(epochs[0]!);
    const problems: string[] = [];
    const shards = used.map((u) => u.shard);
    const twice = shards.filter((s, i) => shards.indexOf(s) !== i);
    if (twice.length > 0) problems.push(`asked ${[...new Set(twice)].join(", ")} more than once`);
    const missing = shardsOf(R).filter((s) => !shards.includes(s));
    if (missing.length > 0) problems.push(`did not ask ${missing.map((s) => `${s} (${intervalsText(regionsOf(R, s))})`).join(", ")}`);
    for (const u of used) {
      if (!sameIntervals(u.claim, regionsOf(R, u.shard))) problems.push(`asked ${u.shard} for ${intervalsText(u.claim)}, but it holds ${intervalsText(regionsOf(R, u.shard))}`);
    }
    if (problems.length > 0) allTilingProblems.push(`${sql} | table ${table}, routing at epoch ${epochs[0]}: ${problems.join("; ")}`);
  }
}

/**
 * RPC_TRACE=<ディレクトリ> のとき、このプロセスで作ったクラスタの網。test/setup.ts が試験ごとに、RPC の送り元、宛先、種類の列を
 * 書き出して空にする。中身は書かない。変更の前後で、同じ seed の実行の RPC の列が同じかを比べるのに使う。
 */
export const tracedNets: SimNet[] = [];
/**
 * いまの試験が、実時間で動くクラスタ (realTime か now) を作ったか。test/setup.ts が試験ごとに戻す。作っていない試験が本物の
 * 時計と乱数 (systemRuntime) を使ったら、setup.ts が試験を落とす (同じ seed で同じ実行にならないので)。
 */
export const realTimeCluster = { now: false };

/**
 * クラスタの呼び出しの一部だけを差し替えた包み。差し替えない性質 (仮想の実行環境 runtime、基準経路だけで流す印 reference、
 * ほかの呼び出し) は、そのまま引き継ぐ。Cluster を手で並べ直すと、それらを落とす (test/setup.ts の決定性の検査が見つける)。
 */
export function withOverrides(c: SimCluster, over: Partial<Cluster>): Cluster {
  return new Proxy(c as unknown as Cluster, { get: (t, p, r) => (p in over ? (over as Record<string | symbol, unknown>)[p] : Reflect.get(t, p, r)) });
}
/**
 * RPC m が、表定義の記録 version (表定義の epoch) をシャードへ届ける要求か。段 3 から、prepare の記録は、進める側が prepared で届け、
 * commit と abort の記録は、終えた後の syncSchema で届く。試験が、記録がシャードへ届くのを止める (net.gate) のに使う。
 */
export const delivers = (m: Pick<Rpc, "method" | "req">, version: number): boolean =>
  (m.method === "prepared" && (m.req as { epoch: number }).epoch === version) ||
  (m.method === "syncSchema" && (m.req as { schema: number }).schema === version);

/** 行イメージの検査を、いまの試験の間だけ止めているか (SimOptions の noImageCheck)。test/setup.ts が試験ごとに戻す。 */
export const imageCheckOff = { now: false };

export class SimCluster implements Cluster {
  /** 起動時のシャード。増設後の一覧は catalog の routing を見る。 */
  shardIds: string[];
  net = new SimNet();
  /** 時刻、待ち、乱数、識別子の出どころ。Db もシャードも、ここから取る。 */
  readonly runtime: Runtime;
  /** FAULT で入れた Worker の側の欠陥 (下の injectedFault)。 */
  readonly clientFaults: ClientFaults | undefined;
  /**
   * このクラスタへつなぐ Db を、基準経路だけで実行させる指定。環境変数 REFERENCE (scans か full) から取る。
   * SQLite と突き合わせる検査を、通常の実行と、基準経路だけの実行で流すのに使う。
   */
  readonly reference: Reference | undefined = referenceFromEnv();
  private virtual: VirtualRuntime | null;
  private fixedTime = 1_000_000;
  /** 全シャードの時計をまとめて進める量 (ms)。時計の出所が実時間でも効く。 */
  ahead = 0;
  cores = new Map<string, ShardCore>();
  /** 宣言した範囲の外の行に依存していた文。空でなければ、取引の検証が成り立っていない。 */
  spanEscapes: SpanEscape[] = [];
  /** 宣言の外の行か、持ち主でないシャードに残る行を書こうとした書き込み (checkWrites)。空でなければ、行の置き場所が壊れ得る。 */
  writeEscapes: WriteEscape[] = [];
  backends = new Map<string, SqliteBackend>();
  /** Meta の SQLite。 */
  metaBackend: SqliteBackend;
  meta: MetaCore;
  background = new Set<Promise<unknown>>();
  /** 送ったが、まだ応答も失敗も返っていない RPC。終わらない実行で、どの要求が返らないのかを知るのに使う。 */
  private unanswered = new Set<{ m: Rpc; at: number }>();
  /** alarm を予約したシャード。DO の alarm の代わりに fireAlarms で発火させる。 */
  alarms = new Set<string>();

  constructor(private o: SimOptions = {}) {
    const injected = injectedFault();
    if (injected?.side === "shard" || injected?.side === "both") this.o = o = { ...o, faults: { ...o.faults, [injected.name]: true } };
    this.clientFaults = injected?.side === "client" || injected?.side === "both" ? { ...o.clientFaults, [injected.name]: true } : o.clientFaults;
    if (process.env.RPC_TRACE) tracedNets.push(this.net);
    if (o.noImageCheck) imageCheckOff.now = true;
    this.virtual = o.realTime || o.now ? null : new VirtualRuntime(o.seed ?? 1);
    if (!this.virtual) realTimeCluster.now = true;
    this.runtime = this.virtual ?? systemRuntime;
    this.shardIds = o.stored ? [...o.stored.shards.keys()] : Array.from({ length: o.shards ?? 4 }, (_, i) => `s${i}`);
    this.metaBackend = new SqliteBackend(o.stored?.meta);
    this.meta = new MetaCore(this.metaBackend, this.shardIds, { runtime: this.runtime, leaseMs: o.leaseMs, buildMaxMs: o.buildMaxMs, faults: o.faults });
    for (const id of this.shardIds) this.core(id);
  }

  /** シャードの時計の元になる時刻 (ms)。仮想の実行環境では、出来事が起きるときに進む。試験が直に進めてもよい。 */
  get time(): number {
    return this.virtual ? this.virtual.now() : this.fixedTime;
  }
  set time(ms: number) {
    if (this.virtual) this.virtual.set(ms);
    else this.fixedTime = ms;
  }

  /**
   * 実行の指紋。RPC の記録 (送り元、宛先、種類、要求の中身) を順に畳んだもの。同じ実行なら同じ値になる。
   * 同じ seed で値が変わったら、実行のどこかに、本物のタイマー、本物の時計、seed から作っていない乱数が混ざっている。
   */
  fingerprint(): string {
    const h = createHash("sha256");
    for (const m of this.net.log) h.update(JSON.stringify([m.from, m.to, m.method, m.req], (_k, x) => (x instanceof Uint8Array ? [...x] : typeof x === "bigint" ? `${x}n` : x)));
    return `${this.net.log.length} rpcs ${h.digest("hex").slice(0, 16)}`;
  }

  /**
   * 実行が終わらないときに失敗する Promise。work と Promise.race で競わせる。
   * 仮想の時刻で ms を過ぎるか、出来事が steps 個を超えたら、最後の RPC の内訳を付けて失敗する。
   * 仮想の時刻は待ちがあるかぎり進むので、進まなくなった実行 (同じ再試行を繰り返すなど) は、実時間の制限を待たずに分かる。
   */
  stalled(ms: number, steps: number): Promise<never> {
    return new Promise((_, reject) => {
      if (!this.virtual) return;
      this.virtual.budget = { steps: this.virtual.steps + steps, until: this.virtual.now() + ms };
      this.virtual.onStall = (why) => {
        const tail = this.net.log.slice(-400);
        const count = new Map<string, number>();
        for (const m of tail) {
          const k = `${m.from}->${m.to} ${String(m.method)}`;
          count.set(k, (count.get(k) ?? 0) + 1);
        }
        const top = [...count].sort((a, b) => b[1] - a[1]).slice(0, 8).map(([k, n]) => `${k} x${n}`).join(", ");
        const waiting = [...this.unanswered].sort((a, b) => a.at - b.at).slice(0, 6).map(({ m, at }) =>
          `${m.from}->${m.to} ${String(m.method)} sent at ${at}: ${JSON.stringify(m.req, (_k, x) => (x instanceof Uint8Array ? "<blob>" : typeof x === "bigint" ? `${x}n` : x)).slice(0, 300)}`);
        reject(new Error(
          `the run did not finish: ${why} (${this.net.log.length} RPCs, simulated time ${this.time}).\n` +
          `RPCs that never returned (${this.unanswered.size}):\n  ${waiting.join("\n  ") || "none"}\n` +
          `Last 400 RPCs: ${top}`,
        ));
      };
    });
  }

  /** ms だけ待つ。仮想の実行環境では、実時間は掛からない。試験の中の待ちは、これで書く。 */
  sleep(ms: number): Promise<void> {
    return sleep(this.runtime, ms);
  }

  /** DO と同じく、触った時に存在し始める。 */
  private core(id: string): ShardCore {
    if (!this.cores.has(id)) {
      const b = new SqliteBackend(this.o.stored?.shards.get(id));
      b.rt = this.runtime;
      this.backends.set(id, b);
      this.boot(id);
    }
    return this.cores.get(id)!;
  }

  /**
   * instance ごとの、届いていて、まだ答えていない要求を失敗させる関数。再起動 (restart) が、古い instance の分を全部呼ぶ。
   * 答えた要求は、自分で抜ける。
   */
  private inflight = new Map<string, Set<(e: Error) => void>>();

  private boot(id: string): void {
    this.inflight.set(id, new Set());
    this.cores.set(id, new ShardCore({
      id,
      backend: this.backends.get(id)!,
      clock: { now: () => (this.o.now?.() ?? this.time) + this.ahead + (this.o.skewMs?.(id) ?? 0) },
      runtime: this.runtime,
      peer: (to) => this.stub(id, to),
      meta: {
        epochsSince: (after) => this.meta.epochsSince(after),
        endMove: (epoch) => this.meta.endMove(epoch),
      },
      background: (p) => {
        this.background.add(p);
        void p.finally(() => this.background.delete(p));
      },
      scheduleRedrive: (why) => {
        this.alarms.add(id);
        if (why === "move") this.armMoveAlarm(id);
      },
      faults: this.o.faults,
      K: this.o.K,
      lockTtlMs: this.o.lockTtlMs,
      logRetainMs: this.o.logRetainMs,
      logGenMs: this.o.logGenMs,
      txnRetainMs: this.o.txnRetainMs,
      recentMax: this.o.recentMax,
      spanEscape: this.o.noSpanCheck ? undefined : (e) => {
        this.spanEscapes.push(e);
        allSpanEscapes.push(e);
      },
      writeCheck: this.o.noSpanCheck ? undefined : (e) => this.checkWrites(e),
    }));
  }

  /**
   * 書き込みの側の範囲の検査。シャードが書き込みを受け入れる前に呼ばれる (KernelDeps.writeCheck)。シャードの守り (kernel.ts の
   * claimed) とは別に、ここで確かめ直す。守りを欠陥のスイッチ (ignoreWriteClaim) で外しても、同じに確かめる。変更の行ごとに:
   *   1. 変更が名乗る行 (pk と sk) が、行イメージから読んだ行と同じである。
   *   2. 文の実行なら、文が宣言した範囲のどれかが、その行を覆う。
   *   3. 変更後の行が残るなら、そのシャードが、その行の token を持っている。持ち主は、シャードが保存した記録 (Meta の epoch の列の写し
   *      __epoch と、渡したグループの記録 __moved と __arrived) から決める。シャードのメモリと、シャードの所有の規則は使わない。
   *      写しを畳んだ範囲表がそのシャードに割り当てる token を持ち、渡して、届き直してもおらず、その範囲を受け取り直してもいないグループの
   *      行は持たない (段 4 から、
   *      範囲表の切り替えと親の fence と子の受け取りの始まりは、同じ move-start の記録である。親は、その記録を写すまで、移る範囲の行を
   *      持ち、書き込みを受けてよい。その行は、記録を写した後に子へ運ばれる)。
   * 確かめるだけで、処理は変えない (RPC の列も変わらない)。見つけたものは test/setup.ts が試験ごとに確かめる。
   */
  private checkWrites(e: WriteCheck): void {
    for (const c of e.changes) {
      let problem: string | null;
      try {
        problem = this.writeProblem(e, c);
      } catch (err) {
        problem = `the check could not read the change: ${(err as Error)?.message ?? String(err)}`;
      }
      if (problem === null) continue;
      const w: WriteEscape = { shard: e.shard, sql: e.sql, row: `${c.table} ${c.pk}`, problem };
      this.writeEscapes.push(w);
      allWriteEscapes.push(w);
    }
  }

  private writeProblem(e: WriteCheck, c: Change): string | null {
    const image = c.after ?? c.before;
    // 取引の中で入れて消した行は、変更前も変更後もない変更として確定に届く (Txn.buffer)。何も書かず、何も残さない。
    if (!image) return null;
    const key = keyOfImage(e.def(c.table), image);
    if (key.pk !== c.pk || key.sk !== c.sk) return `the change names row ${c.pk} (shard key ${c.sk}), but its image is row ${key.pk} (shard key ${key.sk})`;
    const token = tokenOf(key.sk, key.pk);
    if (e.spans && !e.spans.some((s) => declaresRow(s, c.table, key, token))) {
      return `the statement wrote a row outside its declared spans ${JSON.stringify(e.spans).slice(0, 200)}`;
    }
    if (c.after && !this.ownsToken(e.shard, token, key.sk)) {
      return `the row would stay on ${e.shard}, which does not own token ${token} (the range table gives it to ${this.routingOwner(token)})`;
    }
    return null;
  }

  /**
   * シャードが、shard key sk の行の token を持っているか。シャードが保存した記録から決める (checkWrites の 3)。
   * 写した epoch の列を畳んだ範囲表で、その token がシャードのものであり、そのグループを渡した後に、届き直したか、その範囲を受け取り直したこと
   * (渡していなければ、それでよい)。
   */
  private ownsToken(shard: string, token: number, sk: string): boolean {
    const db = this.backends.get(shard)!.db;
    const rows = db.prepare(`SELECT epoch, rec FROM __epoch ORDER BY epoch`).all() as { epoch: number; rec: string }[];
    const routing = rows.length > 0 ? fold(rows.map((r) => ({ epoch: r.epoch, rec: JSON.parse(r.rec) as EpochRecord }))).routing : initialRouting(this.shardIds);
    if (routing.ranges.find((x) => token >= x.start && token < x.end)?.shard !== shard) return false;
    const last = (table: string) => (db.prepare(`SELECT max(epoch) AS e FROM ${table} WHERE g = ?`).get(sk) as { e: number | null }).e;
    const out = last("__moved");
    if (out === null) return true;
    // 渡した後に、そのグループが届き直したか、そのグループを含む範囲を受け取り直していれば (行のないまま戻ったグループには到着の記録がない)、持つ。
    const received = (db.prepare(`SELECT max(epoch) AS e FROM __incoming WHERE lo <= ? AND ? < hi`).get(token, token) as { e: number | null }).e;
    return Math.max(last("__arrived") ?? -1, received ?? -1) > out;
  }

  /**
   * Meta の今の範囲表で、token を持つシャード。範囲表がまだなければ、最初の範囲表で決める。
   * 範囲表は、Meta の epoch の列を SQLite から直に読んで畳む。MetaCore の入口は、期限切れの取り消しを記録し得るので使わない。
   */
  private routingOwner(token: number): string | undefined {
    const rows = this.metaBackend.db.prepare(`SELECT epoch, rec FROM __epoch ORDER BY epoch`).all() as { epoch: number; rec: string }[];
    const log = fold(rows.map((r) => ({ epoch: r.epoch, rec: JSON.parse(r.rec) as EpochRecord })));
    const routing: Routing = rows.some((r) => r.epoch === 0) ? log.routing : initialRouting(this.shardIds);
    return routing.ranges.find((x) => token >= x.start && token < x.end)?.shard;
  }

  /**
   * Meta の epoch の列を epoch まで畳んだ範囲表 (全表の読みの区間の検査、checkTiling)。routingOwner と同じく、SQLite から直に読む。
   * 記録した epoch の中身は後から変わらないので、epoch ごとに覚えて使い回す。
   */
  private routings = new Map<number, Routing>();
  routingAt(epoch: number): Routing {
    let r = this.routings.get(epoch);
    if (r === undefined) {
      const rows = this.metaBackend.db.prepare(`SELECT epoch, rec FROM __epoch WHERE epoch <= ? ORDER BY epoch`).all(epoch) as { epoch: number; rec: string }[];
      r = rows.some((x) => x.epoch === 0)
        ? fold(rows.map((x) => ({ epoch: x.epoch, rec: JSON.parse(x.rec) as EpochRecord })), epoch).routing
        : initialRouting(this.shardIds);
      this.routings.set(epoch, r);
    }
    return r;
  }

  /**
   * 子として移動を進めるシャードの alarm (docs/design-catalog-epoch.md の決めたこと 4)。DO の alarm と同じく、予約から MOVE_ALARM_MS の後に
   * redrive を走らせ、まだ進める移動が残っていれば、もう一度予約する。仮想の時計のクラスタでだけ、仮想の時計で発火させる (実時間の
   * タイマーは使わない)。移動のない alarm (取り残された intent と phase 2 の再駆動) は、今までどおり試験が fireAlarms で発火させる。
   * 終わらない移動 (親が答えない) で発火し続けないよう、続けて発火させる回数に上限を置く。発火したときに、進める移動がもうなければ、
   * redrive を走らせずに終える。
   */
  private moveAlarms = new Map<string, number>();
  private armMoveAlarm(id: string): void {
    if (!this.virtual || this.moveAlarms.has(id)) return;
    this.moveAlarms.set(id, 0);
    const fire = async () => {
      const core = this.core(id);
      if (core.movesToDrive === 0) {
        this.moveAlarms.delete(id);
        return;
      }
      await core.redrive().catch(() => undefined);
      const fired = (this.moveAlarms.get(id) ?? 0) + 1;
      if (this.core(id).movesToDrive > 0 && fired < MOVE_ALARM_LIMIT) {
        this.moveAlarms.set(id, fired);
        this.runtime.after(MOVE_ALARM_MS, () => void fire());
      } else {
        this.moveAlarms.delete(id);
      }
    };
    this.runtime.after(MOVE_ALARM_MS, () => void fire());
  }

  /** 予約された alarm を発火させる。redrive が仕事を残したら、DO と同じく次の alarm を予約する。 */
  async fireAlarms(): Promise<void> {
    const due = [...this.alarms];
    this.alarms.clear();
    for (const id of due) if (await this.core(id).redrive()) this.alarms.add(id);
  }

  /** 確定していない書き込みを、再起動で失うシャード (loseUnsynced)。 */
  private unsyncedLost = new Set<string>();
  /**
   * このシャードでは、これより後の書き込みのうち sync() で確定していないものを、再起動で失う (SqliteBackend.holdUnsynced)。
   * 再起動した後の instance にも掛かる。既定では、どのシャードの書き込みも再起動で失われない。
   */
  loseUnsynced(id: string): void {
    this.core(id);
    this.unsyncedLost.add(id);
    this.backends.get(id)!.holdUnsynced();
  }

  /** 再起動。メモリは失われ、SQLite だけが残る。旧 instance は fence される。 */
  restart(id: string): void {
    const old = this.backends.get(id)!;
    old.fenced = true;
    for (const fail of [...(this.inflight.get(id) ?? [])]) fail(new Error("fenced instance: the shard restarted while the request was in flight"));
    old.dropUnsynced();
    const fresh = new SqliteBackend(old.db);
    fresh.rt = this.runtime;
    if (this.unsyncedLost.has(id)) fresh.holdUnsynced();
    this.backends.set(id, fresh);
    this.boot(id);
  }

  private stub(from: string, to: string): ShardApi {
    return new Proxy({} as ShardApi, {
      get: (_t, method: keyof ShardApi) => async (req: unknown) => {
        const m: Rpc = { from, to, method, req };
        this.net.log.push(m);
        const sent = { m, at: this.time };
        this.unanswered.add(sent);
        try {
          await this.net.gate(m);
          if (this.net.drop(m)) throw new Error(`rpc dropped: ${String(method)}`);
          const delay = this.net.jitter?.() ?? 0;
          if (this.virtual) await this.sleep(delay);
          else await new Promise((r) => (delay > 0 ? setTimeout(r, delay) : setImmediate(r)));
          // JSON を通して、DO の RPC と同じく参照を共有しないようにする。
          const core = this.core(to);
          // シャードが再起動すると、その instance に届いていた要求は、答えを待たずに失敗する (DO の再起動と同じ。test/workerd-restart.test.ts)。
          // 古い instance の中で行ロックを待っている要求が、待ちの期限 (5 秒) まで、取ったロックを持ったまま残らないようにする
          // (elle-sim の seed 253。2026-11-16)。古い instance の続きは走ったままで、ほかのシャードを呼べる (本物の DO では届かない)。
          // 答えを待つ Promise の段の数は、前の書き方 (call.catch) と同じにする。Promise.race で包むと 1 段増え、再起動のない実行でも、
          // 同じ seed の RPC の列が変わる。
          const inflight = this.inflight.get(to)!;
          const call = (core[method] as (r: unknown) => Promise<unknown>).call(core, structuredClone(req));
          const out = await new Promise<unknown>((resolve, reject) => {
            const fail = (e: unknown) => {
              if (!inflight.delete(fail)) return; // もう答えたか、再起動で失敗させた
              this.net.failed.push({ m, message: e instanceof Error ? e.message : String(e) });
              reject(e);
            };
            inflight.add(fail);
            call.then((v) => void (inflight.delete(fail) && resolve(v)), fail);
          });
          const hold = this.net.reply(m);
          if (hold) await hold;
          if (out === undefined) return undefined;
          const answer = structuredClone(out);
          // Worker へ返す exec の答えに、それを返した要求を結び付ける (全表の読みの区間の検査、checkTiling)。
          if (from === "client" && method === "exec" && answer !== null && typeof answer === "object") answeredBy.set(answer, { c: this, shard: to, req: req as ExecReq });
          return answer;
        } finally {
          this.unanswered.delete(sent);
        }
      },
    });
  }

  shard(id: string): ShardApi {
    return this.stub("client", id);
  }
  catalog() {
    return this.meta.catalog();
  }
  prepare(sql: string, opts: { guard?: string[] } = {}, basedOn?: number) {
    return this.meta.prepare(sql, opts, basedOn);
  }
  commit(epoch: number, acks: string[], at?: Ts) {
    return this.meta.commit(epoch, acks, at);
  }
  abort(epoch: number, reason: string) {
    return this.meta.abort(epoch, reason);
  }
  renew(epoch: number) {
    return this.meta.renew(epoch);
  }
  startMove(move: Move) {
    return this.meta.startMove(move);
  }
  moves() {
    return this.meta.moves();
  }
  /**
   * 試験が範囲の移動を自分で進めるための入口。Meta に move-start を記録させ、tell に挙げたシャードに、その epoch まで列を適用させる
   * (親なら fence が付き、子なら受け取り始めて、自分で移動を進め始める)。誰にも知らせなければ、記録だけが残る (進める側が止まった形)。
   */
  async moveAt(parent: string, child: string, range: Interval, tell: string[] = []): Promise<{ epoch: number }> {
    const { epoch } = await this.meta.startMove({ from: parent, to: child, ...range });
    const { schema } = await this.catalog();
    for (const id of tell) await this.shard(id).syncSchema({ schema, epoch });
    return { epoch };
  }
  /**
   * 試験が、表定義の変更を 1 手ずつ進めるための入口。DDL の prepare を記録し、全シャードの prepared の ok を集めて commit する
   * (Db の changeSchema の、mode ごとの仕事を除いた形)。どこかのシャードが ok と答えなければ abort し、その理由で失敗する。
   */
  async applyDdl(sql: string): Promise<Catalog> {
    const cat = await this.catalog();
    const p = await this.meta.prepare(sql, {}, cat.schema);
    if (p.epoch === null) return p.catalog;
    const shards = shardsOf(p.catalog.routing);
    const answers = await Promise.all(shards.map((id) => this.shard(id).prepared({ epoch: p.epoch! })));
    const bad = answers.find((a) => !a.ok);
    if (bad) {
      await this.meta.abort(p.epoch, bad.reason ?? "refused");
      throw new Error(bad.reason);
    }
    return this.meta.commit(p.epoch, shards);
  }
  allocate(table: string, n: number, min?: number) {
    return this.meta.allocate(table, n, min);
  }
  async settle(): Promise<void> {
    while (this.background.size > 0) await Promise.all(this.background);
  }
  client(): Db {
    return new Db(this);
  }
}

/** シャードの変更ログを commit_ts の昇順で全部読む (テスト用)。 */
export function logRows(b: SqliteBackend): PlainRow[] {
  const gens = JSON.parse((b.exec(`SELECT v FROM __meta WHERE k = 'log_gens'`)[0]?.v as string | undefined) ?? "[]") as number[];
  return gens.flatMap((g) => b.exec(`SELECT commit_ts, txn, blob FROM __log_g${g} ORDER BY commit_ts`));
}

export const USERS = `CREATE TABLE users(
  tenant_id INTEGER NOT NULL, id INTEGER NOT NULL, name TEXT, n INTEGER NOT NULL DEFAULT 0,
  PRIMARY KEY (tenant_id, id))`;
export const ORDERS = `CREATE TABLE orders(
  tenant_id INTEGER NOT NULL, id INTEGER NOT NULL, user_id INTEGER NOT NULL, status TEXT, total INTEGER,
  PRIMARY KEY (tenant_id, id))`;
