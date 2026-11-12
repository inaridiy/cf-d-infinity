import { createHash } from "node:crypto";
import { DatabaseSync } from "node:sqlite";
import { Db, type ClientFaults, type Cluster } from "../src/client/db";
import { MetaCore, type SplitMove, type SplitSlot } from "../src/meta";
import { shardsOf } from "../src/routing";
import { type Runtime, sleep, systemRuntime } from "../src/runtime";
import type { Reference } from "../src/sql/plan";
import { ShardCore, type SpanEscape } from "../src/shard/core";
import type { Backend, Faults, Row, ShardApi, Ts, Value } from "../src/types";
import { bindTyped, restoreColumns } from "../src/value";

/**
 * DO の SQLite の実測の制限 (公式の表にないもの)。node:sqlite は上限を変えられないので、文を見て模す。
 * UNION、INTERSECT、EXCEPT で 6 項以上の複合 SELECT は「too many terms in compound SELECT」になる。
 */
export const DO_COMPOUND_SELECT_LIMIT = 5;
/** DO の SQLite の公表されている制限。node:sqlite の既定はどれもこれより緩いので、ここで模す。 */
export const DO_MAX_SQL_BYTES = 100_000;
export const DO_MAX_BOUND_PARAMS = 100;
export const DO_MAX_VALUE_BYTES = 2_000_000;
function checkDoLimits(sql: string, params: Value[] = []): void {
  const terms = 1 + (sql.replace(/'(?:[^']|'')*'/g, "''").match(/\b(UNION|INTERSECT|EXCEPT)\b/gi)?.length ?? 0);
  if (terms > DO_COMPOUND_SELECT_LIMIT) throw new Error("too many terms in compound SELECT: SQLITE_ERROR");
  if (Buffer.byteLength(sql) > DO_MAX_SQL_BYTES) throw new Error("statement too long: SQLITE_TOOBIG");
  if (params.length > DO_MAX_BOUND_PARAMS) throw new Error("too many SQL variables: SQLITE_ERROR");
  for (const p of params) {
    const bytes = typeof p === "string" ? Buffer.byteLength(p) : p instanceof Uint8Array ? p.byteLength : 0;
    if (bytes > DO_MAX_VALUE_BYTES) throw new Error("string or blob too big: SQLITE_TOOBIG");
  }
}

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
const lossy = (v: unknown): Value => (typeof v === "bigint" ? Number(v) : (v as Value));

/** node:sqlite の Backend。fence() 後の操作は失敗する (DO 基盤が旧 instance を止めるのと同じ)。 */
export class SqliteBackend implements Backend {
  fenced = false;
  depth = 0;
  /** quorum の確定の待ちに使う。SimCluster が自分のものに差し替える。 */
  rt: Runtime = systemRuntime;
  constructor(readonly db = new DatabaseSync(":memory:")) {}
  exec(sql: string, ...params: Value[]): Row[] {
    if (this.fenced) throw new Error("fenced instance");
    checkDoLimits(sql, params);
    // node:sqlite も DO の SQLite と同じく、JS の数を REAL として束縛する。束縛の仕方は DO と同じにする (src/value.ts)。
    const b = bindTyped(sql, params, "real");
    const st = this.db.prepare(b.sql);
    const p = b.params as never[];
    if (st.columns().length === 0) return (st.run(...p), []);
    const names = restoreColumns(st.columns().map((c) => c.name), b.columns);
    st.setReturnArrays(true);
    st.setReadBigInts(true);
    return (st.all(...p) as unknown as Value[][]).map((r) => Object.fromEntries(names.map((c, i) => [c, lossy(r[i] ?? null)])));
  }
  iterate(sql: string, ...params: Value[]): { columns: string[]; rows: Iterable<Value[]> } {
    if (this.fenced) throw new Error("fenced instance");
    checkDoLimits(sql, params);
    const b = bindTyped(sql, params, "real");
    const st = this.db.prepare(b.sql);
    const p = b.params as never[];
    const columns = restoreColumns(st.columns().map((c) => c.name), b.columns);
    if (columns.length === 0) {
      st.run(...p);
      return { columns, rows: [] };
    }
    st.setReturnArrays(true);
    st.setReadBigInts(true);
    const it = st.iterate(...p) as unknown as Iterable<Value[]>;
    return { columns, rows: (function* () { for (const r of it) yield r.map(lossy); })() };
  }
  raw(sql: string, ...params: Value[]): { columns: string[]; values: Value[][] } {
    if (this.fenced) throw new Error("fenced instance");
    checkDoLimits(sql, params);
    const b = bindTyped(sql, params, "real");
    const st = this.db.prepare(b.sql);
    const p = b.params as never[];
    const columns = restoreColumns(st.columns().map((c) => c.name), b.columns);
    if (columns.length === 0) {
      st.run(...p);
      return { columns, values: [] };
    }
    st.setReturnArrays(true);
    st.setReadBigInts(true);
    return { columns, values: (st.all(...p) as unknown as Value[][]).map((r) => r.map(lossy)) };
  }
  tx<T>(fn: () => T): T {
    const name = `sp${this.depth++}`;
    this.db.exec(`SAVEPOINT ${name}`);
    try {
      const out = fn();
      this.db.exec(`RELEASE ${name}`);
      return out;
    } catch (e) {
      this.db.exec(`ROLLBACK TO ${name}`);
      this.db.exec(`RELEASE ${name}`);
      throw e;
    } finally {
      this.depth--;
    }
  }
  /** quorum の確定には本番で約 10 ms かかる。ここで処理が譲られないと、待ちの間のレースを再現できない。 */
  async sync(): Promise<void> {
    await sleep(this.rt, this.rt.random() * 2);
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
const CLIENT_FAULTS = new Set(["repinOnRestore", "replayAcrossSchemaChange", "dropWithoutGuard", "noImplicitCommit", "ddlAfterFailedCommit"]);
/** 範囲の作り方の欠陥のスイッチの名前 (src/client/spans.ts の spanFaults)。test/setup.ts が入れる。 */
export const SPAN_FAULTS = new Set(["rowSpanDespiteUnique"]);

/**
 * 環境変数 FAULT で、欠陥のスイッチを 1 つ、全部のシミュレータに入れる。乱択の検査が、その欠陥を見つけるかを測るためにある
 * (scripts/fault-table.mjs)。試験が自分で入れるスイッチには、上書きせずに足す。
 */
export function injectedFault(): { name: string; side: "shard" | "client" | "span" } | null {
  const name = process.env.FAULT;
  if (!name) return null;
  return { name, side: CLIENT_FAULTS.has(name) ? "client" : SPAN_FAULTS.has(name) ? "span" : "shard" };
}

export interface SimOptions {
  shards?: number;
  faults?: Faults;
  skewMs?: (id: string) => number;
  K?: number;
  now?: () => number;
  lockTtlMs?: number;
  logRetainMs?: number;
  logGenMs?: number;
  txnRetainMs?: number;
  recentMax?: number;
  /** 範囲の検査 (ShardDeps.spanEscape) を切る。既定では掛ける。 */
  noSpanCheck?: boolean;
  /** 仮想の実行環境の seed。同じ seed なら同じ実行になる。 */
  seed?: number;
  /** index を既存の行から作る間の、書き込み禁止の期限と、その上限 (ms)。既定は meta.ts の INDEX_LEASE_MS と INDEX_BUILD_MAX_MS。 */
  leaseMs?: number;
  buildMaxMs?: number;
  /**
   * 本物の時計とタイマーで動かす。実行は再現できない。本物のタイマーで待つ、まだ移していない試験のためにある。
   * now を渡したときも、こちらになる。
   */
  realTime?: boolean;
}

/** Worker と DO の間の RPC だけをシミュレートしたクラスタ。ShardCore は本物を動かす。 */
/** このプロセスの全クラスタで見つかった、範囲の外の行に依存する文。test/setup.ts が試験ごとに確かめて空にする。 */
export const allSpanEscapes: SpanEscape[] = [];

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
  backends = new Map<string, SqliteBackend>();
  meta: MetaCore;
  background = new Set<Promise<unknown>>();
  /** 送ったが、まだ応答も失敗も返っていない RPC。終わらない実行で、どの要求が返らないのかを知るのに使う。 */
  private unanswered = new Set<{ m: Rpc; at: number }>();
  /** alarm を予約したシャード。DO の alarm の代わりに fireAlarms で発火させる。 */
  alarms = new Set<string>();

  constructor(private o: SimOptions = {}) {
    const injected = injectedFault();
    if (injected?.side === "shard") this.o = o = { ...o, faults: { ...o.faults, [injected.name]: true } };
    this.clientFaults = injected?.side === "client" ? { [injected.name]: true } : undefined;
    this.virtual = o.realTime || o.now ? null : new VirtualRuntime(o.seed ?? 1);
    this.runtime = this.virtual ?? systemRuntime;
    this.shardIds = Array.from({ length: o.shards ?? 4 }, (_, i) => `s${i}`);
    this.meta = new MetaCore(new SqliteBackend(), this.shardIds, { runtime: this.runtime, leaseMs: o.leaseMs, buildMaxMs: o.buildMaxMs });
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
    for (const m of this.net.log) h.update(JSON.stringify([m.from, m.to, m.method, m.req], (_k, x) => (x instanceof Uint8Array ? [...x] : x)));
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
          `${m.from}->${m.to} ${String(m.method)} sent at ${at}: ${JSON.stringify(m.req, (_k, x) => (x instanceof Uint8Array ? "<blob>" : x)).slice(0, 300)}`);
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
      const b = new SqliteBackend();
      b.rt = this.runtime;
      this.backends.set(id, b);
      this.boot(id);
    }
    return this.cores.get(id)!;
  }

  private boot(id: string): void {
    this.cores.set(id, new ShardCore({
      id,
      backend: this.backends.get(id)!,
      clock: { now: () => (this.o.now?.() ?? this.time) + this.ahead + (this.o.skewMs?.(id) ?? 0) },
      runtime: this.runtime,
      peer: (to) => this.stub(id, to),
      meta: {
        ddlSince: (v) => this.meta.ddlSince(v), revokeDdl: (v, reason) => this.meta.revokeDdl(v, reason),
        startSplit: (id, move) => this.meta.startSplit(id, move), checkSplit: (id, move) => this.meta.checkSplit(id, move),
      },
      background: (p) => {
        this.background.add(p);
        void p.finally(() => this.background.delete(p));
      },
      scheduleRedrive: () => void this.alarms.add(id),
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
    }));
  }

  /** 予約された alarm を発火させる。redrive が仕事を残したら、DO と同じく次の alarm を予約する。 */
  async fireAlarms(): Promise<void> {
    const due = [...this.alarms];
    this.alarms.clear();
    for (const id of due) if (await this.core(id).redrive()) this.alarms.add(id);
  }

  /** 再起動。メモリは失われ、SQLite だけが残る。旧 instance は fence される。 */
  restart(id: string): void {
    const old = this.backends.get(id)!;
    old.fenced = true;
    const fresh = new SqliteBackend(old.db);
    fresh.rt = this.runtime;
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
          const out = await (core[method] as (r: unknown) => Promise<unknown>).call(core, structuredClone(req)).catch((e: unknown) => {
            this.net.failed.push({ m, message: e instanceof Error ? e.message : String(e) });
            throw e;
          });
          const hold = this.net.reply(m);
          if (hold) await hold;
          return out === undefined ? undefined : structuredClone(out);
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
  applyDdl(sql: string, basedOn?: number) {
    return this.meta.applyDdl(sql, basedOn);
  }
  switchRange(move: { start: number; end: number; to: string; from?: string }) {
    return this.meta.switchRange(move);
  }
  publishIndex(table: string, name: string, version: number, at: Ts) {
    return this.meta.publishIndex(table, name, version, at);
  }
  revokeDdl(version: number, reason: string) {
    return this.meta.revokeDdl(version, reason);
  }
  renewLock(version: number) {
    return this.meta.renewLock(version);
  }
  lockTables(tables: string[], basedOn?: number) {
    return this.meta.lockTables(tables, basedOn);
  }
  beginSplit(move: SplitMove, basedOn: number) {
    return this.meta.beginSplit(move, basedOn);
  }
  endSplit(id: string) {
    return this.meta.endSplit(id);
  }
  splits() {
    return this.meta.splits();
  }
  /**
   * 試験が分割の段を自分で進めるための、分割の枠。Autoscaler の split と同じく、全シャードに最新の版を適用させてから取る。
   * 返る id を、beginIncoming と fence に渡す。
   */
  async reserveSplit(parent: string, child: string, range: { start: number; end: number }): Promise<SplitSlot> {
    const cat = await this.catalog();
    for (const id of shardsOf(cat.routing)) await this.shard(id).syncSchema({ version: cat.version });
    return this.meta.beginSplit({ parent, child, ...range }, cat.version);
  }
  finishLock(version: number, sql: string) {
    return this.meta.finishLock(version, sql);
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
export function logRows(b: SqliteBackend): Row[] {
  const gens = JSON.parse((b.exec(`SELECT v FROM __meta WHERE k = 'log_gens'`)[0]?.v as string | undefined) ?? "[]") as number[];
  return gens.flatMap((g) => b.exec(`SELECT commit_ts, txn, blob FROM __log_g${g} ORDER BY commit_ts`));
}

export const USERS = `CREATE TABLE users(
  tenant_id INTEGER NOT NULL, id INTEGER NOT NULL, name TEXT, n INTEGER NOT NULL DEFAULT 0,
  PRIMARY KEY (tenant_id, id)) SHARD KEY (tenant_id)`;
export const ORDERS = `CREATE TABLE orders(
  tenant_id INTEGER NOT NULL, id INTEGER NOT NULL, user_id INTEGER NOT NULL, status TEXT, total INTEGER,
  PRIMARY KEY (tenant_id, id)) SHARD KEY (tenant_id)`;
