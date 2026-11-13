import { DurableObject, RpcTarget } from "cloudflare:workers";
import { Db, type Cluster, type StatementStat } from "./client/db";
import { exportPage, importRows, type ExportCursor } from "./transfer";

export { importRows, type ExportCursor };
import { collectMetrics, decide, DEFAULTS, healthProblems, needsFollowUp, nextShardNumber, split, splitsToResume, type AutoscalerState, type Thresholds } from "./autoscaler";
import { MetaCore, type Catalog, type SplitMove } from "./meta";
import { planSplit, shardsOf } from "./routing";
import { ShardCore } from "./shard/core";
import { batonSealer, handlePipeline, serveHranaSocket, type BatonSeal, type PipelineReq } from "./client/hrana";
import { setSqlWasm } from "./sql/scratch";
import { bindTyped, restoreColumns } from "./value";
import { BadRequest, checkCount, checkSql, clusterName, ENTRY_LIMITS, readJson, sameToken, shardCount, shardName } from "./entry";
import { checkProtocol, PROTOCOL_VERSION, type Backend, type Row, type ShardApi, type ShardHealth, type Value } from "./types";
// @ts-expect-error wrangler と esbuild がバンドル時に解決する
import sqlWasm from "./sql-wasm.wasm";

setSqlWasm(sqlWasm as WebAssembly.Module);

export interface Env {
  DINF_SHARD: DurableObjectNamespace<DinfShard>;
  DINF_META: DurableObjectNamespace<DinfMeta>;
  DINF_AUTOSCALER: DurableObjectNamespace<DinfAutoscaler>;
  DINF_SHARD_COUNT?: string;
  /** データの読み書きの認証トークン。未設定ならデータの経路を全部拒否する。 */
  DINF_API_TOKEN?: string;
  /** 運用の操作 (/admin) の認証トークン。未設定なら運用の経路を全部拒否する。 */
  DINF_ADMIN_TOKEN?: string;
  /**
   * 自動増設の動作。"split" なら閾値を超えたシャードを実際に割る。それ以外 (既定) は、割るべきだと記録するだけである。
   * 増設は取り消せず、途中でやめる手順もないので、明示的に有効にしたときだけ行う。
   */
  DINF_AUTOSCALE?: string;
  /** 負荷が続いている間だけ回す Autoscaler の周期 (ms)。既定は 5000。 */
  DINF_AUTOSCALE_TICK_MS?: string;
  /** 増設の閾値の上書き (JSON)。省略した項目は既定値になる。 */
  DINF_AUTOSCALE_THRESHOLDS?: string;
  /**
   * 遅い文として記録する下限 (ms)。既定は 500。"off" で記録をやめ、0 なら全部の文を記録する。
   * 記録は DinfMeta に直近 1,000 件だけ残る。
   */
  DINF_SLOW_QUERY_MS?: string;
  /** Hrana の baton に署名する鍵。未設定なら DINF_API_TOKEN から導く。 */
  DINF_BATON_SECRET?: string;
  /**
   * 版を上げるデプロイの訓練にだけ使う上書き。1 段目で受け付ける上限 (ACCEPT) を上げ、
   * 全 DO が入れ替わってから 2 段目で送る版 (SEND) を上げる。
   */
  DINF_PROTOCOL_SEND?: string;
  DINF_PROTOCOL_ACCEPT?: string;
}

/** 課金される行書き込みを文の種類ごとに数える。費用の内訳を測るために使う。 */
export const rowStats = new Map<string, { calls: number; rowsWritten: number; rowsRead: number }>();
const statKey = (sql: string) => {
  const m = /^\s*(?:\/\*.*?\*\/\s*)?(\w+)(?:\s+(?:OR\s+\w+\s+)?(?:INTO|FROM|TABLE(?:\s+IF\s+(?:NOT\s+)?EXISTS)?|INDEX)?)?\s*["`]?([\w.]+)?/i.exec(sql);
  return m ? `${m[1]!.toUpperCase()} ${m[2] ?? ""}`.trim() : sql.slice(0, 30);
};

class DoBackend implements Backend {
  constructor(private storage: DurableObjectStorage) {}
  exec(sql: string, ...params: Value[]): Row[] {
    const { columns, values } = this.raw(sql, ...params);
    return values.map((v) => Object.fromEntries(columns.map((c, i) => [c, v[i] ?? null])));
  }
  raw(sql: string, ...params: Value[]): { columns: string[]; values: Value[][] } {
    // DO の SQLite は JS の数をすべて REAL として束縛する。INTEGER の引数は包む (src/value.ts)。
    const b = bindTyped(sql, params, "real");
    const cur = this.storage.sql.exec(b.sql, ...(b.params as never[]));
    const values = [...cur.raw()].map((r) => r.map((v) => (v instanceof ArrayBuffer ? new Uint8Array(v) : v)) as Value[]);
    if (cur.rowsWritten > 0 || cur.rowsRead > 0) {
      const k = statKey(sql);
      const e = rowStats.get(k) ?? { calls: 0, rowsWritten: 0, rowsRead: 0 };
      e.calls++;
      e.rowsWritten += cur.rowsWritten;
      e.rowsRead += cur.rowsRead;
      rowStats.set(k, e);
    }
    return { columns: restoreColumns(cur.columnNames, b.columns), values };
  }
  iterate(sql: string, ...params: Value[]): { columns: string[]; rows: Iterable<Value[]> } {
    const b = bindTyped(sql, params, "real");
    const cur = this.storage.sql.exec(b.sql, ...(b.params as never[]));
    const record = () => {
      if (cur.rowsWritten === 0 && cur.rowsRead === 0) return;
      const k = statKey(sql);
      const e = rowStats.get(k) ?? { calls: 0, rowsWritten: 0, rowsRead: 0 };
      e.calls++;
      e.rowsWritten += cur.rowsWritten;
      e.rowsRead += cur.rowsRead;
      rowStats.set(k, e);
    };
    const rows = (function* () {
      try {
        for (const r of cur.raw()) yield r.map((v) => (v instanceof ArrayBuffer ? new Uint8Array(v) : v)) as Value[];
      } finally {
        record();
      }
    })();
    return { columns: restoreColumns(cur.columnNames, b.columns), rows };
  }
  tx<T>(fn: () => T): T {
    return this.storage.transactionSync(fn);
  }
  sync(): Promise<void> {
    return this.storage.sync();
  }
  size(): number {
    return this.storage.sql.databaseSize;
  }
}

class ShardSession extends RpcTarget {
  constructor(private shard: DinfShard) {
    super();
  }
  call(method: keyof ShardApi, req: unknown, v?: number): Promise<unknown> {
    return this.shard.call(method, req, v);
  }
}

const protocolOf = (env: Env) => Number(env.DINF_PROTOCOL_SEND ?? PROTOCOL_VERSION);

/** シャード名は `<cluster>-<番号>`。接頭辞が Meta の名前になる。 */
const clusterOfShard = (id: string) => id.slice(0, id.lastIndexOf("-"));

/** シャード 1 個。データと複製は DO の SQLite が持ち、ここは ShardCore への配線だけを行う。 */
export class DinfShard extends DurableObject<Env> {
  private core: ShardCore;
  constructor(ctx: DurableObjectState, env: Env) {
    super(ctx, env);
    this.core = new ShardCore({
      id: ctx.id.name ?? ctx.id.toString(),
      backend: new DoBackend(ctx.storage),
      clock: { now: () => Date.now() },
      peer: (id) => shardStub(env, id),
      meta: {
        ddlSince: (v) => env.DINF_META.getByName(clusterOfShard(ctx.id.name!)).ddlSince(v) as never,
        revokeDdl: (v, reason) => env.DINF_META.getByName(clusterOfShard(ctx.id.name!)).revokeDdl(v, reason),
        startSplit: (id, move) => env.DINF_META.getByName(clusterOfShard(ctx.id.name!)).startSplit(id, move),
        checkSplit: (id, move) => env.DINF_META.getByName(clusterOfShard(ctx.id.name!)).checkSplit(id, move),
      },
      background: (p) => ctx.waitUntil(p),
      // 予約済みの alarm は後ろへずらさない。負荷が続くと毎回ずれて、いつまでも発火しなくなる。
      scheduleRedrive: () => {
        void ctx.storage.getAlarm().then((at) => (at === null ? ctx.storage.setAlarm(Date.now() + 5000) : undefined));
      },
    });
  }
  /**
   * RPC の session を開く。返した対象への呼び出しは同じ session に属し、DO のリクエストとして別に課金されない。
   * 長く続く WebSocket の接続から使う。
   */
  session(): ShardSession {
    return new ShardSession(this);
  }
  async call(method: keyof ShardApi, req: unknown, v?: number): Promise<unknown> {
    checkProtocol(v, Number(this.env.DINF_PROTOCOL_ACCEPT ?? PROTOCOL_VERSION));
    return (this.core[method] as (r: unknown) => Promise<unknown>).call(this.core, req);
  }
  override async alarm(): Promise<void> {
    if (await this.core.redrive()) await this.ctx.storage.setAlarm(Date.now() + 5000);
  }

  /** 文の種類ごとの行の読み書き数。reset で 0 に戻す。 */
  rowStats(reset: boolean): Record<string, { calls: number; rowsWritten: number; rowsRead: number }> {
    const out = Object.fromEntries(rowStats);
    if (reset) rowStats.clear();
    return out;
  }
}

/** 遅い文の 1 件。 */
export interface SlowQuery extends StatementStat {
  /** 記録した時刻 (ms)。 */
  at: number;
}
const SLOW_KEEP = 1000;
const SLOW_DEFAULT_MS = 500;
const SLOW_SQL_MAX = 2000;
/** 全部の文が遅い状況で記録が負荷にならないよう、isolate ごとに 10 秒あたり 20 件までにする。 */
const SLOW_WINDOW_MS = 10_000;
const SLOW_PER_WINDOW = 20;
let slowWindow = { start: 0, count: 0 };

/**
 * 遅い文の記録先を作る。記録は応答を待たせず、background (waitUntil) があればそれに預ける。
 * 記録するのは文面と時間と実行場所だけで、bound parameter は残さない。
 */
function slowSink(env: Env, background?: (p: Promise<unknown>) => void): ((s: StatementStat) => void) | undefined {
  const raw = env.DINF_SLOW_QUERY_MS;
  if (raw === "off") return undefined;
  const min = raw === undefined || raw === "" ? SLOW_DEFAULT_MS : Number(raw);
  if (!Number.isFinite(min) || min < 0) return undefined;
  return (s) => {
    if (s.ms < min) return;
    const now = Date.now();
    if (now - slowWindow.start > SLOW_WINDOW_MS) slowWindow = { start: now, count: 0 };
    if (++slowWindow.count > SLOW_PER_WINDOW) return;
    const p = Promise.resolve(env.DINF_META.getByName("shard").recordSlow({ ...s, at: now, sql: s.sql.slice(0, SLOW_SQL_MAX) }))
      .catch(() => undefined);
    if (background) background(p);
  };
}

export class DinfMeta extends DurableObject<Env> {
  private core: MetaCore;
  constructor(ctx: DurableObjectState, env: Env) {
    super(ctx, env);
    this.core = new MetaCore(new DoBackend(ctx.storage));
  }
  catalog(initial: string[]) {
    this.core.setInitial(initial);
    return this.core.catalog();
  }
  ddlSince(v: number) {
    return this.core.ddlSince(v);
  }
  /** 遅い文を記録する。直近の SLOW_KEEP 件だけ残す。 */
  recordSlow(e: SlowQuery): void {
    const sql = this.ctx.storage.sql;
    sql.exec(`CREATE TABLE IF NOT EXISTS __slow(seq INTEGER PRIMARY KEY, at INTEGER, ms INTEGER, plan TEXT, shards INTEGER, rows INTEGER, changes INTEGER, attempts INTEGER, error TEXT, sql TEXT)`);
    sql.exec(
      `INSERT INTO __slow(at, ms, plan, shards, rows, changes, attempts, error, sql) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      e.at, e.ms, e.plan, e.shards, e.rows, e.changes, e.attempts, e.error ?? null, e.sql,
    );
    sql.exec(`DELETE FROM __slow WHERE seq <= (SELECT max(seq) FROM __slow) - ?`, SLOW_KEEP);
  }
  /** 遅い文を新しい順に返す。 */
  slowQueries(limit: number): SlowQuery[] {
    const sql = this.ctx.storage.sql;
    sql.exec(`CREATE TABLE IF NOT EXISTS __slow(seq INTEGER PRIMARY KEY, at INTEGER, ms INTEGER, plan TEXT, shards INTEGER, rows INTEGER, changes INTEGER, attempts INTEGER, error TEXT, sql TEXT)`);
    return sql.exec(`SELECT at, ms, plan, shards, rows, changes, attempts, error, sql FROM __slow ORDER BY seq DESC LIMIT ?`, Math.max(1, Math.min(limit, SLOW_KEEP)))
      .toArray().map((r) => ({ ...(r as unknown as SlowQuery), error: (r.error as string | null) ?? undefined }));
  }
  applyDdl(sql: string, initial: string[], basedOn?: number) {
    this.core.setInitial(initial);
    return this.core.applyDdl(sql, basedOn);
  }
  revokeDdl(version: number, reason: string) {
    return this.core.revokeDdl(version, reason);
  }
  switchRange(move: { start: number; end: number; to: string; from?: string }) {
    return this.core.switchRange(move);
  }
  publishIndex(table: string, name: string, version: number, at: number) {
    return this.core.publishIndex(table, name, version, at);
  }
  renewLock(version: number) {
    return this.core.renewLock(version);
  }
  lockTables(tables: string[], basedOn?: number) {
    return this.core.lockTables(tables, basedOn);
  }
  beginSplit(move: SplitMove, basedOn: number) {
    return this.core.beginSplit(move, basedOn);
  }
  startSplit(id: string, move: SplitMove) {
    return this.core.startSplit(id, move);
  }
  checkSplit(id: string, move: SplitMove) {
    return this.core.checkSplit(id, move);
  }
  endSplit(id: string) {
    return this.core.endSplit(id);
  }
  splits() {
    return this.core.splits();
  }
  batonSecret() {
    return this.core.batonSecret();
  }
  finishLock(version: number, sql: string) {
    return this.core.finishLock(version, sql);
  }
  allocate(table: string, n: number, min?: number) {
    return this.core.allocate(table, n, min);
  }
}

interface SplitJob {
  parent: string;
  child: string;
  range: { start: number; end: number };
}

interface ScaleEvent {
  at: number;
  kind: string;
  detail: unknown;
}

export interface AutoscaleConfig {
  cluster: string;
  initial: number;
  tickMs: number;
  thresholds?: Partial<Thresholds>;
  /** "split" なら実際に割る。"notify" (既定) は記録するだけ。 */
  mode?: "notify" | "split";
}
type SavedConfig = Omit<AutoscaleConfig, "thresholds" | "mode"> & {
  thresholds: Thresholds; next: number; pending: SplitJob[]; pinned?: boolean; mode: "notify" | "split";
};

/**
 * 運用者の手作業なしに増設を起動する制御ループ。
 * 平常時は Cron Trigger が 1 分ごとに tick を呼ぶだけで、alarm は仕掛けない。
 * 閾値を超えたシャードか進行中の増設がある間だけ、tickMs の alarm で追いかける。
 * 全シャードへの問い合わせは DO を起こすので、負荷のない間は回数を抑える。
 */
export class DinfAutoscaler extends DurableObject<Env> {
  private state: AutoscalerState = { over: {}, lastSplit: {} };
  private running = new Set<string>();
  private ticking = false;
  constructor(ctx: DurableObjectState, env: Env) {
    super(ctx, env);
    ctx.storage.sql.exec(`CREATE TABLE IF NOT EXISTS events(seq INTEGER PRIMARY KEY, at INTEGER, kind TEXT, detail TEXT)`);
    ctx.storage.sql.exec(`CREATE TABLE IF NOT EXISTS conf(k TEXT PRIMARY KEY, v TEXT)`);
  }
  private conf(): SavedConfig | null {
    const r = this.ctx.storage.sql.exec(`SELECT v FROM conf WHERE k = 'conf'`).toArray()[0];
    return r ? JSON.parse(r.v as string) : null;
  }
  private save(c: object): void {
    this.ctx.storage.sql.exec(`INSERT INTO conf(k, v) VALUES ('conf', ?) ON CONFLICT(k) DO UPDATE SET v = excluded.v`, JSON.stringify(c));
  }
  private event(kind: string, detail: unknown): void {
    this.ctx.storage.sql.exec(`INSERT INTO events(at, kind, detail) VALUES (?, ?, ?)`, Date.now(), kind, JSON.stringify(detail));
  }
  /** 設定を保存する。変わっていなければ書かない (Cron から毎分呼ばれる)。 */
  private async configure(c: AutoscaleConfig, pinned: boolean): Promise<SavedConfig> {
    const prev = this.conf();
    const same = prev?.cluster === c.cluster ? prev : null;
    const thresholds = { ...DEFAULTS, ...c.thresholds };
    const mode = c.mode ?? "notify";
    if (same && same.initial === c.initial && same.tickMs === c.tickMs && !!same.pinned === pinned && same.mode === mode
      && JSON.stringify(same.thresholds) === JSON.stringify(thresholds)) return same;
    const { routing } = await clusterOf(this.env, c.initial, c.cluster).catalog();
    // 起動し直しでも、番号の再利用と途中の増設の取りこぼしを起こさない。
    const next = nextShardNumber(routing, c.cluster, Math.max(c.initial, same?.next ?? 0));
    const saved: SavedConfig = { cluster: c.cluster, initial: c.initial, tickMs: c.tickMs, thresholds, next, pending: same?.pending ?? [], pinned, mode };
    this.save(saved);
    return saved;
  }
  /**
   * Cron Trigger からの呼び出し。設定を取り込み、alarm が動いていなければ 1 回判断する。
   * alarm が動いている間は何もしない。判断の間隔が乱れると、連続回数の数え方が狂うからである。
   */
  async tick(c: AutoscaleConfig): Promise<void> {
    await this.configure(c, false);
    if ((await this.ctx.storage.getAlarm()) !== null) return;
    await this.round();
  }
  /** 負荷の有無によらず tickMs で回し続ける。計測用の構成だけが使う。 */
  async start(c: AutoscaleConfig): Promise<void> {
    await this.configure(c, true);
    await this.ctx.storage.setAlarm(Date.now() + c.tickMs);
  }
  async stop(): Promise<void> {
    const c = this.conf();
    if (c?.pinned) this.save({ ...c, pinned: false });
    await this.ctx.storage.deleteAlarm();
  }
  status(): { events: ScaleEvent[] } {
    const events = this.ctx.storage.sql.exec(`SELECT at, kind, detail FROM events ORDER BY seq`).toArray()
      .map((r) => ({ at: r.at as number, kind: r.kind as string, detail: JSON.parse(r.detail as string) as unknown }));
    return { events };
  }
  override async alarm(): Promise<void> {
    await this.round();
  }
  /** 1 回の判断。終わりに、追いかける必要がある間だけ次の alarm を仕掛ける。 */
  private async round(): Promise<void> {
    if (this.ticking) return;
    this.ticking = true;
    try {
      const busy = await this.judge();
      const c = this.conf();
      if (c && (busy || c.pinned)) await this.ctx.storage.setAlarm(Date.now() + c.tickMs);
    } finally {
      this.ticking = false;
    }
  }
  private async judge(): Promise<boolean> {
    const c = this.conf();
    if (!c) return false;
    const cluster = clusterOf(this.env, c.initial, c.cluster);
    const metrics = await collectMetrics(cluster);
    this.event("tick", metrics.map((m) => ({ id: m.id, w: m.writes, r: m.reads, ms: m.elapsedMs, size: m.size, mig: m.migrating, probe: m.probeMs })));
    // 途中で失敗した増設は同じ範囲で再開する。各段は冪等である。
    for (const job of c.pending) this.runSplit(cluster, job);
    // Meta に残っている分割の枠も再開する。別の進め方 (手で始めた分割など) が途中で止まると、枠が残り、
    // 表定義の変更がいつまでも記録できなくなる。子が受け取り始めた分割は取り消せないので、終わらせる。
    for (const job of splitsToResume(await cluster.splits(), (child) => c.pending.some((j) => j.child === child))) this.runSplit(cluster, job);
    const { routing } = await cluster.catalog();
    // 持続回数と cooldown は永続化する。メモリだけだと、再起動のたびに cooldown が消えて続けて割る。
    const saved = this.ctx.storage.sql.exec(`SELECT v FROM conf WHERE k = 'state'`).toArray()[0];
    if (saved) this.state = JSON.parse(saved.v as string) as AutoscalerState;
    const decisions = decide(metrics, this.state, Date.now(), c.thresholds);
    for (const d of decisions) {
      if (d.kind === "notify") {
        this.event("notify", d);
        continue;
      }
      const range = planSplit(routing, d.shard);
      if (!range) continue;
      if (c.mode !== "split") {
        // 割るべきだと記録するだけにする。cooldown を進めるので、同じシャードについては 10 分に 1 回しか記録しない。
        this.state.lastSplit[d.shard] = Date.now();
        this.event("would-split", d);
        continue;
      }
      const job: SplitJob = { parent: d.shard, child: `${c.cluster}-${c.next++}`, range };
      c.pending.push(job);
      this.save(c);
      this.state.lastSplit[d.shard] = Date.now();
      this.state.lastSplit[job.child] = Date.now();
      this.event("split-start", { ...d, child: job.child });
      this.runSplit(cluster, job);
    }
    this.ctx.storage.sql.exec(
      `INSERT INTO conf(k, v) VALUES ('state', ?) ON CONFLICT(k) DO UPDATE SET v = excluded.v`, JSON.stringify(this.state),
    );
    // 判断の記録は直近の分だけ残す。
    this.ctx.storage.sql.exec(`DELETE FROM events WHERE seq <= (SELECT max(seq) FROM events) - 5000`);
    // 増設の完了は別の経路で pending を書き換えるので、数は読み直す。
    return needsFollowUp(metrics, this.state, this.conf()?.pending.length ?? 0);
  }
  private runSplit(cluster: Cluster, job: SplitJob): void {
    if (this.running.has(job.child)) return;
    this.running.add(job.child);
    this.ctx.waitUntil(split(cluster, job.parent, job.child, { range: job.range }).then(
      (r) => {
        const c = this.conf()!;
        c.pending = c.pending.filter((j) => j.child !== job.child);
        this.save(c);
        this.event("split-done", r);
      },
      // 表定義の変更が枠を持っている間は、分割を待たせる。次の判断のときに、もう一度始める。
      (e) => this.event(/split busy:/.test(String(e)) ? "split-waiting" : "split-failed", { child: job.child, error: String(e) }),
    ).finally(() => this.running.delete(job.child)));
  }
}

function shardStub(env: Env, id: string): ShardApi {
  const stub = env.DINF_SHARD.getByName(id);
  return new Proxy({} as ShardApi, {
    get: (_t, method: keyof ShardApi) => (req: unknown) => stub.call(method, req, protocolOf(env)),
  });
}

export function clusterOf(env: Env, count?: number, prefix = "shard"): Cluster {
  const n = count ?? Number(env.DINF_SHARD_COUNT ?? 8);
  const initial = Array.from({ length: n }, (_, i) => `${prefix}-${i}`);
  const meta = env.DINF_META.getByName(prefix);
  return {
    shard: (id) => shardStub(env, id),
    catalog: () => meta.catalog(initial) as unknown as Promise<Catalog>,
    applyDdl: (sql, basedOn) => meta.applyDdl(sql, initial, basedOn) as unknown as Promise<Catalog>,
    switchRange: (move) => meta.switchRange(move) as never,
    publishIndex: (table, name, version, at) => meta.publishIndex(table, name, version, at) as never,
    revokeDdl: (version, reason) => meta.revokeDdl(version, reason),
    renewLock: (version) => meta.renewLock(version),
    lockTables: (tables, basedOn) => meta.lockTables(tables, basedOn) as never,
    beginSplit: (move, basedOn) => meta.beginSplit(move, basedOn) as never,
    endSplit: (id) => meta.endSplit(id),
    splits: () => meta.splits() as never,
    finishLock: (version, sql) => meta.finishLock(version, sql) as never,
    allocate: (table, n, min) => meta.allocate(table, n, min),
  };
}

/** RPC の session を使い回す Cluster。session は 1 つの接続の中でだけ使い、しばらく使わなければ閉じる。 */
const SESSION_IDLE_MS = 2000;
function sessionCluster(env: Env): Cluster & { sweep(): void; close(): void } {
  const base = clusterOf(env);
  type Session = { call(method: keyof ShardApi, req: unknown, v?: number): Promise<unknown> } & Partial<Disposable>;
  const open = new Map<string, { s: Promise<Session>; last: number; busy: number }>();
  const drop = (id: string) => {
    const e = open.get(id);
    open.delete(id);
    void e?.s.then((s) => s[Symbol.dispose]?.(), () => {});
  };
  return {
    ...base,
    shard: (id) => new Proxy({} as ShardApi, {
      get: (_t, method: keyof ShardApi) => async (req: unknown) => {
        let e = open.get(id);
        if (!e) {
          e = { s: env.DINF_SHARD.getByName(id).session() as unknown as Promise<Session>, last: Date.now(), busy: 0 };
          open.set(id, e);
        }
        e.busy++;
        try {
          return await (await e.s).call(method, req, protocolOf(env));
        } catch (err) {
          // DO の再起動などで session が切れたかもしれないので、次の呼び出しで作り直す。
          // 失敗した呼び出しは再送しない (届いていた場合の二重実行を避ける)。
          drop(id);
          throw err;
        } finally {
          e.busy--;
          e.last = Date.now();
        }
      },
    }),
    // 使っていない session を閉じる。開いたままだと DO が眠れず、duration が課金され続けるおそれがある。
    sweep: () => {
      for (const [id, e] of open) if (e.busy === 0 && Date.now() - e.last > SESSION_IDLE_MS) drop(id);
    },
    close: () => {
      for (const id of [...open.keys()]) drop(id);
    },
  };
}

/**
 * baton に署名する鍵。DINF_BATON_SECRET が設定されていればそれを、なければ Meta が乱数で作って保存した鍵を使う (isolate ごとに覚える)。
 * データ用のトークンから鍵を作ってはならない (2026-11-12 の入口の安全の確認)。トークンを持つ人が、取引の状態を書き換えた baton
 * を作れ、シャードはそれを信じるからである。
 */
let storedSeal: { name: string; seal: Promise<BatonSeal> } | null = null;
const batonSeal = (env: Env, name = "shard"): Promise<BatonSeal> => {
  if (env.DINF_BATON_SECRET) return Promise.resolve(batonSealer(env.DINF_BATON_SECRET));
  if (storedSeal?.name !== name) {
    const seal = env.DINF_META.getByName(name).batonSecret().then((secret) => batonSealer(secret));
    seal.catch(() => {
      if (storedSeal?.seal === seal) storedSeal = null;
    });
    storedSeal = { name, seal };
  }
  return storedSeal.seal;
};

function hranaSocket(request: Request, env: Env): Response {
  const offered = (request.headers.get("sec-websocket-protocol") ?? "").split(",").map((p) => p.trim());
  const proto = ["hrana2", "hrana1"].find((p) => offered.includes(p));
  if (!proto) return new Response("hrana2 subprotocol required", { status: 400 });
  const pair = new WebSocketPair();
  const [client, server] = [pair[0], pair[1]];
  server.accept();
  const cluster = sessionCluster(env);
  const timer = setInterval(() => cluster.sweep(), SESSION_IDLE_MS);
  // hello が期限までに届かない接続は閉じる (入口の安全の確認、指摘 4)。認証の前の接続が、資源を持ち続けないようにする。
  const hello = setTimeout(() => server.close(1008, "hello timeout"), ENTRY_LIMITS.helloMs);
  serveHranaSocket(server, {
    authorize: (jwt) => authorized(env, "data", jwt),
    onHello: () => clearTimeout(hello),
    open: () => dbOn(cluster, 0, slowSink(env)),
    onClose: () => {
      clearTimeout(hello);
      clearInterval(timer);
      cluster.close();
    },
  });
  return new Response(null, { status: 101, webSocket: client, headers: { "sec-websocket-protocol": proto } });
}

// 表定義はこの isolate にキャッシュする。ここでは 2 秒で捨てるだけの簡易版である。
let cached: { at: number; catalog: Catalog } | null = null;

const sharedIds = new Map<string, { next: number; end: number }>();

export async function dbFor(env: Env, token: number, background?: (p: Promise<unknown>) => void): Promise<Db> {
  return dbOn(clusterOf(env), token, slowSink(env, background));
}

async function dbOn(cluster: Cluster, token: number, onStatement?: (s: StatementStat) => void): Promise<Db> {
  if (!cached || Date.now() - cached.at > 2000) cached = { at: Date.now(), catalog: await cluster.catalog() };
  return new Db(cluster, {
    token, catalog: cached.catalog, ids: sharedIds, onStatement,
    onCatalog: (catalog) => {
      cached = { at: Date.now(), catalog };
    },
  });
}

/** シャード、範囲表、Autoscaler の履歴。 */
export async function clusterStatus(env: Env, name = "shard", shards?: number) {
  const cluster = clusterOf(env, shards, name);
  const cat = await cluster.catalog();
  const ids = shardsOf(cat.routing);
  // 適用できない DDL で止まっているシャードは、適用を試みさせないと自分では気づかない (再起動で忘れる)。
  await Promise.all(ids.map((id) => cluster.shard(id).syncSchema({ version: cat.version }).catch(() => {})));
  // 1 つのシャードが答えなくても、ほかの状態は見せる。
  const health = await Promise.all(ids.map((id) => cluster.shard(id).health({}).catch((e): ShardHealth => ({
    id, schema: -1, format: -1, bytes: 0, intents: 0, oldestIntentMs: 0, unapplied: 0,
    redriveErrors: [`does not answer: ${String((e as Error)?.message ?? e).slice(0, 200)}`], incoming: 0, outgoing: 0, logGenerations: 0,
  }))));
  return {
    routing: cat.routing, shards: ids, schema: cat.version, health, problems: healthProblems(health),
    // 進行中の分割。終わるまで、表定義の変更は待つ。長く残っているなら、分割が進めなくなっている。
    splits: await cluster.splits(),
    scaler: await env.DINF_AUTOSCALER.getByName(name).status(),
  };
}

/** 利用者が実行した DDL を、実行した順に返す。論理エクスポートの先頭に置く。 */
export async function schemaSql(env: Env, name = "shard"): Promise<string[]> {
  const { ddl } = await env.DINF_META.getByName(name).ddlSince(0);
  // 適用できずに取り消された文と、それを取り消した文は書き出さない。
  const reverted = new Set(ddl.flatMap((e) => (e.reverts === undefined ? [] : [e.reverts, e.version])));
  return ddl.flatMap((e) => {
    if (typeof e.user !== "string" || e.user.trim() === "" || reverted.has(e.version)) return [];
    // 履歴の文面からは SHARD KEY が除かれている。取り込み先で行の置き場所が変わらないよう、表定義から書き戻す。
    const def = e.defs[0];
    const createsTable = /^\s*CREATE\s+TABLE\b/i.test(e.user) && def !== undefined && !def.name.startsWith("__");
    return [createsTable ? `${e.user} SHARD KEY (${def.shardKey.map((c) => `"${c.replaceAll('"', '""')}"`).join(", ")})` : e.user];
  });
}

/** 表の行を、シャードの順、主キーの順に少しずつ返す。cursor が null になったら終わりである。 */
export async function exportRows(
  env: Env, table: string, cursor: ExportCursor | null, limit = 1000, name = "shard",
): Promise<{ columns: string[]; rows: Value[][]; cursor: ExportCursor | null }> {
  return exportPage(clusterOf(env, undefined, name), table, cursor, limit);
}

/** 遅い文の記録を新しい順に返す。 */
export async function slowQueries(env: Env, limit = 50, name = "shard"): Promise<SlowQuery[]> {
  return env.DINF_META.getByName(name).slowQueries(limit);
}

interface AdminReq {
  cluster?: string;
  shards?: number;
  sql?: string;
  parent?: string;
  child?: string;
  limit?: number;
}

async function admin(env: Env, path: string, b: AdminReq): Promise<unknown> {
  // 名前と数は Durable Object の名前と数になるので、形を確かめる (入口の安全の確認、指摘 8)。
  const name = clusterName(b?.cluster);
  const cluster = clusterOf(env, shardCount(b?.shards), name);
  const scaler = env.DINF_AUTOSCALER.getByName(name);
  switch (path) {
    case "/admin/ddl": {
      // 上の /ddl と同じ理由で、Db の DDL を通す。
      await new Db(cluster, { ids: sharedIds }).ddl(b.sql!);
      if (name === "shard") cached = null;
      return (await cluster.catalog()).version;
    }
    case "/admin/split": return split(cluster, shardName(name, b.parent), shardName(name, b.child));
    case "/admin/rowstats": {
      // 全シャードの内訳を合計する。同じ isolate の DO は表を共有するので、読んだら必ず消す。
      const cat = await cluster.catalog();
      const total: Record<string, { calls: number; rowsWritten: number; rowsRead: number }> = {};
      for (const id of shardsOf(cat.routing)) {
        for (const [k, v] of Object.entries(await env.DINF_SHARD.getByName(id).rowStats(true))) {
          const t = (total[k] ??= { calls: 0, rowsWritten: 0, rowsRead: 0 });
          t.calls += v.calls; t.rowsWritten += v.rowsWritten; t.rowsRead += v.rowsRead;
        }
      }
      return total;
    }
    case "/admin/slow": return slowQueries(env, b.limit ?? 50, name);
    case "/admin/status": return clusterStatus(env, name, b.shards);
    default: throw new Error(`unknown admin path ${path}`);
  }
}

interface Statement {
  sql: string;
  params?: Value[];
}

const bearer = (request: Request) => request.headers.get("authorization")?.replace(/^Bearer /, "") ?? null;

/**
 * 認証。データの読み書きは DINF_API_TOKEN、運用の操作 (/admin) は DINF_ADMIN_TOKEN で分ける。
 * どちらも未設定なら、その経路はすべて拒否する。
 */
export function authorized(env: Env, kind: "data" | "admin", token: string | null): boolean {
  const want = kind === "data" ? env.DINF_API_TOKEN : env.DINF_ADMIN_TOKEN;
  // 一定時間で比べる (入口の安全の確認、指摘 6)。
  return !!want && token !== null && sameToken(token, want);
}

/** 本番の入口。計測用の入口は src/bench.ts が足す。 */
export async function handle(request: Request, env: Env, ctx?: { waitUntil(p: Promise<unknown>): void }): Promise<Response> {
  const path = new URL(request.url).pathname;
  const background = ctx ? (p: Promise<unknown>) => ctx.waitUntil(p) : undefined;
  // WebSocket は hello の jwt で認証する。ブラウザの WebSocket はヘッダを付けられないからである。
  if (request.headers.get("upgrade")?.toLowerCase() === "websocket") return hranaSocket(request, env);
  if (path.startsWith("/admin/")) {
    if (!authorized(env, "admin", bearer(request))) return new Response("unauthorized", { status: 401 });
    try {
      return Response.json(await admin(env, path, (await readJson(request)) as AdminReq));
    } catch (e) {
      return Response.json({ error: e instanceof Error ? e.message : String(e) }, { status: e instanceof BadRequest ? e.status : 400 });
    }
  }
  if (!authorized(env, "data", bearer(request))) return new Response("unauthorized", { status: 401 });
  if (path === "/v3" || path === "/v2") return new Response(null, { status: 200 });
  try {
    if (path === "/v3/pipeline" || path === "/v2/pipeline") {
      const req = (await readJson(request)) as PipelineReq;
      checkCount(req?.requests?.length ?? 0, "pipeline requests");
      return Response.json(await handlePipeline(req, (token) => dbFor(env, token, background), await batonSeal(env)));
    }
    const body = (await readJson(request)) as Statement & { token?: number; statements?: Statement[] };
    if (body.sql !== undefined) checkSql(body.sql);
    if (body.statements !== undefined) {
      checkCount(body.statements.length, "statements");
      for (const s of body.statements) checkSql(s.sql);
    }
    const token = body.token ?? 0;
    if (path === "/ddl") {
      // SQL の DDL と同じ経路を通す。Meta だけを更新すると、全シャードへの適用、UNIQUE の重複検査、
      // グローバル index の backfill が抜け、index が書き込み専用のまま残る。
      await (await dbFor(env, token, background)).ddl(body.sql);
      cached = null;
      return Response.json({ ok: true });
    }
    const db = await dbFor(env, token, background);
    if (path === "/sql") {
      const r = await db.query(body.sql, body.params ?? []);
      return Response.json({ columns: r.columns, rows: r.rows, changes: r.changes, lastInsertRowid: r.lastInsertRowid, token: db.token });
    }
    if (path === "/batch") {
      const out = await db.batch((body.statements ?? []).map((s) => ({ sql: s.sql, params: s.params ?? [] })));
      const results = out.map((r) => ({ rows: r.rows, changes: r.changes }));
      return Response.json({ results, token: db.token });
    }
    return new Response("not found", { status: 404 });
  } catch (e) {
    return Response.json({ error: e instanceof Error ? e.message : String(e) }, { status: e instanceof BadRequest ? e.status : 400 });
  }
}

/** wrangler.jsonc の vars から Autoscaler の設定を作る。 */
export function autoscaleConfig(env: Env, cluster = "shard"): AutoscaleConfig {
  return {
    cluster,
    initial: Number(env.DINF_SHARD_COUNT ?? 8),
    tickMs: Number(env.DINF_AUTOSCALE_TICK_MS ?? 5000),
    mode: env.DINF_AUTOSCALE === "split" ? "split" : "notify",
    thresholds: env.DINF_AUTOSCALE_THRESHOLDS ? (JSON.parse(env.DINF_AUTOSCALE_THRESHOLDS) as Partial<Thresholds>) : undefined,
  };
}

/**
 * Cron Trigger の入口。wrangler.jsonc の `triggers.crons` が自動増設のスイッチで、消せば止まる。
 * 始動も停止も設定ファイルだけで決まり、運用の HTTP 呼び出しは要らない。
 */
export async function autoscale(env: Env): Promise<void> {
  const c = autoscaleConfig(env);
  await env.DINF_AUTOSCALER.getByName(c.cluster).tick(c);
}

/** `export default` にそのまま置ける scheduled ハンドラ。 */
export const scheduled = (_controller: unknown, env: Env): Promise<void> => autoscale(env);

export default { fetch: handle, scheduled };
