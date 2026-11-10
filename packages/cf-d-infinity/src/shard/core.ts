import { Hlc, SECOND, physicalToTs, tsToPhysical } from "../hlc";
import type {
  Backend, Change, Clock, CommitReq, CommitRes, ExecReq, ExecRes, Faults, FlushRes, GroupCursor, GroupPayload, LockOwner, MetaApi,
  Participant, PrepareReq, PrepareRes, Row, ShardApi, ShardHealth, ShardMetrics, Span, TableDef, Ts, TxnStatus, Value,
} from "../types";
import {
  ConflictError, MAX_WRITE_SET_BYTES, Migrating, NotOwner, ReadTooOld, STORAGE_FORMAT, SqlError, checkStorageFormat, spanCovers, unprotectedSpans,
} from "../types";
import type { DdlEntry } from "../meta";
import { slotOf } from "../routing";
import {
  CAPTURE_TABLES, applyChanges, asSqlError, capturedChanges, decode, deleteRow, encode, encodeKey, insertRow, q,
  rowwiseRestore, selectGroup, selectList, selectRow, setBasedRestore,
} from "./rows";

export interface ShardDeps {
  id: string;
  backend: Backend;
  clock: Clock;
  peer(id: string): ShardApi;
  meta: Pick<MetaApi, never> & { ddlSince(v: number): Promise<{ version: number; ddl: DdlEntry[] }> };
  /** 応答後も続ける処理。DO では ctx.waitUntil に渡す。 */
  background?(p: Promise<unknown>): void;
  /** phase 2 の再駆動を予約する。DO では storage.setAlarm に渡す。 */
  scheduleRedrive?(): void;
  K?: number;
  faults?: Faults;
  /** ロックの TTL。既定は LOCK_TTL_MS である。 */
  lockTtlMs?: number;
  /** 変更ログを残す時間。これより古い T の取引と過去読みは ReadTooOld になる。 */
  logRetainMs?: number;
  /** 変更ログの世代の表 1 つが受け持つ時間。 */
  logGenMs?: number;
  /** 決着済みの取引記録を残す時間。 */
  txnRetainMs?: number;
}

/** TiDB の既定の GC 窓 (10 分) に合わせる。 */
export const LOG_RETAIN_MS = 10 * 60_000;
export const LOG_GEN_MS = 2 * 60_000;
export const TXN_RETAIN_MS = 60 * 60_000;
/** この時間を過ぎた intent は、anchor に問い合わせて決着させる。 */
export const ORPHAN_AGE_MS = 2000;
/**
 * 1 回の要求でシャードが返す結果の上限。要求が小さい値を指定すればそちらが効く。
 * 上限がないと、絞り込みのない SELECT が全行を送り返し、シャードと Worker の両方がメモリを使い切る。
 * バイト数は DO の RPC の上限 (32 MiB) より十分小さくしてある。
 */
/** 移動できる 1 グループ (同じ shard key の行の集まり) の大きさの上限。分割転送がないので、これより大きいと移動が終わらない。 */
export const GROUP_MAX_BYTES = 16_000_000;
export const SHARD_MAX_ROWS = 200_000;
export const SHARD_MAX_BYTES = 16_000_000;
/** 値のおおよその大きさ (バイト)。上限の判定に使うだけで、正確である必要はない。 */
const sizeOf = (v: Value): number =>
  typeof v === "string" ? v.length * 2 : v instanceof Uint8Array ? v.byteLength : 8;

interface Intent {
  tbl: string; pk: string; sk: string; txn: string; anchor: string; prepare_ts: Ts; change: string;
}
interface InFlight {
  pushed: Ts;
  decided: boolean;
  settled: Promise<void>;
  settle(): void;
}

interface FencedRange { start: number; end: number; to: string; done: number }
interface IncomingRange { start: number; end: number; from_id: string }

const ROLLBACK = Symbol("rollback");
const FALLBACK = Symbol("fallback");
const BLOCKED = Symbol("blocked");
const PENDING_UNIQUE = Symbol("pending unique");
/** 述語の検証で読む commit の上限。超えたら競合とみなす。 */
const PRED_WINDOW = 2000;
/** ロックの TTL。Worker の死亡に備える。文を実行するたびに延ばす。 */
const LOCK_TTL_MS = 5000;
/** ロックを待つ時間の上限。SQLite の busy_timeout に相当する。 */
const LOCK_WAIT_MS = 5000;
/**
 * 古い取引が保持者からロックを奪うまで待つ時間。
 * 保持者は多くの場合すぐ終わるので、すぐ奪うと無駄な abort を増やす。
 * 奪う時期を遅らせても閉路はいずれ解ける。ロックはいつ消えてもよいので安全性は変わらない。
 */
const WOUND_DELAY_MS = 200;
/** DDL の適用が、進行中の取引の決着を待つ上限。超えたら再試行できる誤りを返す。 */
const SCHEMA_WAIT_MS = 5000;

interface RowLock extends LockOwner {
  expires: number;
}
interface Waiter extends LockOwner {
  wake(): void;
}

/** シャード 1 個のプロトコル本体。DO に依存せず、Node の SQLite でも同じコードが動く。 */
export class ShardCore implements ShardApi {
  readonly id: string;
  epoch = 0;
  private b: Backend;
  private hlc = new Hlc(0);
  private ceiling: Ts = 0;
  private defs = new Map<string, TableDef>();
  private schema = 0;
  /** 進行中の DDL の適用。同時に来た要求は同じ適用を待つ。 */
  private schemaChange: Promise<void> | null = null;
  /** 直近の write の索引。キーごとの最新 commit 時刻だけを持ち、検査を O(1) にする。 */
  private recent = new Map<string, Ts>();
  private recentLowWater: Ts = 0;
  private maxCommit: Ts = 0;
  private logLowWater: Ts = 0;
  private ddlFloor: Ts = 0;
  private flushedTs: Ts = 0;
  private inflight = new Map<string, InFlight>();
  private fenced: FencedRange[] = [];
  private incoming: IncomingRange[] = [];
  /** 親：移動済みグループ。 */
  private moved = new Map<string, { m: Ts; to: string; acked: boolean }>();
  /** 子：到着済みグループとその m。 */
  private arrived = new Map<string, Ts>();
  private maxArrived: Ts = 0;
  private pulling = new Map<string, Promise<void>>();
  /** 行ロック。メモリだけに置く。消えても検証が F 以降の変更を見るので安全である。 */
  private locks = new Map<string, RowLock>();
  private waiters = new Map<string, Waiter[]>();
  private stats = { at: 0, reads: 0, writes: 0, groups: new Map<string, number>() };
  private faults: Faults;
  private K: number;

  constructor(private deps: ShardDeps) {
    this.id = deps.id;
    this.b = deps.backend;
    this.faults = deps.faults ?? {};
    this.K = deps.K ?? 50;
    this.boot();
  }

  // ---- 起動と永続メタデータ ----

  private boot(): void {
    const b = this.b;
    b.exec(`CREATE TABLE IF NOT EXISTS __meta(k TEXT PRIMARY KEY, v)`);
    // ほかの表に触る前に確かめる。新しい形式の DO を、古いコードが作り変えてしまわないようにする。
    checkStorageFormat(b, "__meta", "shard");
    b.exec(`CREATE TABLE IF NOT EXISTS __ddl(version INTEGER PRIMARY KEY, entry TEXT NOT NULL)`);
    b.exec(`CREATE TABLE IF NOT EXISTS __intents(
      tbl TEXT NOT NULL, pk TEXT NOT NULL, sk TEXT NOT NULL, txn TEXT NOT NULL, anchor TEXT NOT NULL,
      prepare_ts INTEGER NOT NULL, change TEXT NOT NULL, PRIMARY KEY(tbl, pk))`);
    for (const ddl of CAPTURE_TABLES) b.exec(ddl);
    b.exec(`CREATE TABLE IF NOT EXISTS __fenced(start INTEGER, end INTEGER, "to" TEXT, done INTEGER NOT NULL DEFAULT 0)`);
    b.exec(`CREATE TABLE IF NOT EXISTS __incoming(start INTEGER, end INTEGER, from_id TEXT)`);
    b.exec(`CREATE TABLE IF NOT EXISTS __moved(g TEXT PRIMARY KEY, m INTEGER NOT NULL, dest TEXT NOT NULL, acked INTEGER NOT NULL DEFAULT 0)`);
    b.exec(`CREATE TABLE IF NOT EXISTS __moved_txn(txn TEXT NOT NULL, g TEXT NOT NULL, dest TEXT NOT NULL, PRIMARY KEY(txn, g))`);
    b.exec(`CREATE TABLE IF NOT EXISTS __arrived(g TEXT PRIMARY KEY, m INTEGER NOT NULL)`);
    b.exec(`CREATE TABLE IF NOT EXISTS __txn(
      txn TEXT PRIMARY KEY, status TEXT NOT NULL, c INTEGER, participants TEXT, done INTEGER NOT NULL DEFAULT 0, at INTEGER)`);
    this.migrateStorage();

    for (const r of b.exec(`SELECT entry FROM __ddl ORDER BY version`)) {
      this.loadDefs(JSON.parse(r.entry as string) as DdlEntry);
    }
    this.schema = (b.exec(`SELECT max(version) v FROM __ddl`)[0]?.v as number) ?? 0;
    this.fenced = b.exec(`SELECT * FROM __fenced`) as unknown as FencedRange[];
    this.incoming = b.exec(`SELECT * FROM __incoming`) as unknown as IncomingRange[];
    for (const r of b.exec(`SELECT g, m, dest, acked FROM __moved`)) {
      this.moved.set(r.g as string, { m: r.m as Ts, to: r.dest as string, acked: r.acked === 1 });
    }
    for (const r of b.exec(`SELECT g, m FROM __arrived`)) {
      this.arrived.set(r.g as string, r.m as Ts);
      this.maxArrived = Math.max(this.maxArrived, r.m as Ts);
    }
    this.epoch = ((this.metaGet("epoch") as number) ?? 0) + 1;
    this.metaSet("epoch", this.epoch);
    this.ceiling = (this.metaGet("ceiling") as number) ?? 0;
    this.flushedTs = (this.metaGet("flushed") as number) ?? 0;
    this.logLowWater = (this.metaGet("log_low_water") as number) ?? 0;
    this.ddlFloor = (this.metaGet("ddl_floor") as number) ?? 0;

    // 直近 write の索引はメモリにしかないので __log から作り直す。GC で消えた commit は logLowWater 以下にある。
    this.maxCommit = this.logLowWater;
    this.logEach("", [], (ts, _txn, blob) => {
      this.maxCommit = Math.max(this.maxCommit, ts);
      for (const c of decode<Change[]>(blob)) this.touch(c.table, c.pk, c.sk, ts);
    });
    const maxPrepare = (b.exec(`SELECT max(prepare_ts) v FROM __intents`)[0]?.v as number) ?? 0;
    // 再起動の前に予約した alarm がなくても、残った intent と phase 2 を片付ける。
    const pendingWork = b.exec(`SELECT (SELECT count(*) FROM __intents) + (SELECT count(*) FROM __txn WHERE status = 'committed' AND done = 0) n`)[0]?.n as number;
    if (pendingWork > 0) this.deps.scheduleRedrive?.();
    const maxMoved = Math.max(0, ...[...this.moved.values()].map((x) => x.m));
    const resume = Math.max(this.faults.hlcNoCeiling ? 0 : this.ceiling, this.maxCommit, maxPrepare, maxMoved, this.maxArrived);
    this.hlc = new Hlc(resume);
  }

  /**
   * 旧形式の DO を新しい形へ揃える。
   * 変更ログは世代の表に分けたので、旧来の __log 表は最古の世代として残す。
   * 世代を束ねていた view は消す。DO の SQLite は UNION の項を 5 個までしか受け付けないからである。
   */
  private migrateStorage(): void {
    const b = this.b;
    if (b.exec(`SELECT 1 FROM sqlite_master WHERE type = 'view' AND name = '__log'`).length > 0) b.exec(`DROP VIEW __log`);
    if (this.metaGet("log_gens") === null) {
      let gens: number[] = [];
      if (b.exec(`SELECT 1 FROM sqlite_master WHERE type = 'table' AND name = '__log'`).length > 0) {
        b.exec(`ALTER TABLE __log RENAME TO __log_g0`);
        gens = [0];
      }
      this.metaSet("log_gens", JSON.stringify(gens));
      this.metaSet("txn_legacy_at", this.deps.clock.now());
    }
    if (!b.exec(`PRAGMA table_info(__txn)`).some((c) => c.name === "at")) b.exec(`ALTER TABLE __txn ADD COLUMN at INTEGER`);
  }

  private logGens(): number[] {
    return JSON.parse((this.metaGet("log_gens") as string | null) ?? "[]") as number[];
  }

  /**
   * 変更ログを commit_ts の昇順で読む。世代は commit_ts の範囲で分かれているので、古い世代から順に読めば全体も昇順になる。
   * where は `commit_ts > ?` のような条件で、各世代の表に同じものを付ける。
   */
  private logScan(where: string, params: Value[], limit?: number): Row[] {
    const out: Row[] = [];
    for (const g of this.logGens()) {
      const rest = limit === undefined ? "" : ` LIMIT ${limit - out.length}`;
      out.push(...this.b.exec(`SELECT commit_ts, txn, blob FROM __log_g${g} ${where} ORDER BY commit_ts${rest}`, ...params));
      if (limit !== undefined && out.length >= limit) break;
    }
    return out;
  }

  /**
   * 変更ログを commit 時刻の順に 1 行ずつ読む。fn が false を返したらそこでやめる。
   * 保持窓の全行を配列にすると、書き込みの多いシャードでは起動と過去時点の読みがメモリを使い切る。
   */
  private logEach(where: string, params: Value[], fn: (commitTs: Ts, txn: string, blob: string) => boolean | void): void {
    for (const g of this.logGens()) {
      const { rows } = this.b.iterate(`SELECT commit_ts, txn, blob FROM __log_g${g} ${where} ORDER BY commit_ts`, ...params);
      for (const r of rows) {
        if (fn(r[0] as Ts, r[1] as string, r[2] as string) === false) return;
      }
    }
  }

  /** commit の変更ログを、c の世代の表へ書く。必ず書き込みの取引の中で呼ぶ。 */
  private logInsert(c: Ts, txn: string, blob: string): void {
    const g = Math.floor(tsToPhysical(c) / (this.deps.logGenMs ?? LOG_GEN_MS));
    const gens = this.logGens();
    if (!gens.includes(g)) {
      this.b.exec(`CREATE TABLE IF NOT EXISTS __log_g${g}(
        commit_ts INTEGER NOT NULL, txn TEXT NOT NULL, blob TEXT NOT NULL, PRIMARY KEY(commit_ts, txn)) WITHOUT ROWID`);
      const next = [...gens, g].sort((a, b) => a - b);
      this.metaSet("log_gens", JSON.stringify(next));
      this.gc();
    }
    this.b.exec(`INSERT OR IGNORE INTO __log_g${g}(commit_ts, txn, blob) VALUES (?, ?, ?)`, c, txn, blob);
  }

  /**
   * 保持窓より古い変更ログの世代を DROP し、決着済みの取引記録を消す。
   * DROP TABLE は行の書き込みとして課金されないので、GC の費用は世代の数にしかよらない。
   * 消す前に logLowWater を上げるので、消した範囲を必要とする読みと検証は ReadTooOld か abort になる。
   */
  private gc(): void {
    const now = this.deps.clock.now();
    let water = Math.min(this.hlc.value, physicalToTs(now)) - physicalToTs(this.deps.logRetainMs ?? LOG_RETAIN_MS);
    // 未決着の intent は、その prepare 以降に commit し得る。分析へ未送出の範囲も残す。
    const minPrepare = this.b.exec(`SELECT min(prepare_ts) v FROM __intents`)[0]?.v as number | null;
    if (minPrepare !== null && minPrepare !== undefined) water = Math.min(water, minPrepare - 1);
    if (this.flushedTs > 0) water = Math.min(water, this.flushedTs);
    const gens = this.logGens();
    const current = gens.at(-1);
    const drop: number[] = [];
    let low = this.logLowWater;
    for (const g of gens) {
      if (g === current) break;
      const max = (this.b.exec(`SELECT max(commit_ts) v FROM __log_g${g}`)[0]?.v as number | null) ?? 0;
      if (max > water) break;
      drop.push(g);
      low = Math.max(low, max);
    }
    if (drop.length > 0) {
      this.logLowWater = low;
      this.maxCommit = Math.max(this.maxCommit, low);
      this.metaSet("log_low_water", low);
      const keep = gens.filter((g) => !drop.includes(g));
      this.metaSet("log_gens", JSON.stringify(keep));
      for (const g of drop) this.b.exec(`DROP TABLE __log_g${g}`);
      // logLowWater 以下の索引は、検証が先に窓の外として abort するので要らない。
      for (const [k, ts] of this.recent) if (ts <= low) this.recent.delete(k);
    }
    const cutoff = now - (this.deps.txnRetainMs ?? TXN_RETAIN_MS);
    const legacyAt = (this.metaGet("txn_legacy_at") as number | null) ?? 0;
    this.b.exec(
      `DELETE FROM __txn WHERE done = 1 AND (at < ? OR (at IS NULL AND ? < ?))`,
      cutoff, legacyAt, cutoff,
    );
  }

  private metaGet(k: string): Value {
    return this.b.exec(`SELECT v FROM __meta WHERE k = ?`, k)[0]?.v ?? null;
  }
  private metaSet(k: string, v: Value): void {
    this.b.exec(`INSERT INTO __meta(k, v) VALUES (?, ?) ON CONFLICT(k) DO UPDATE SET v = excluded.v`, k, v);
  }

  private def(table: string): TableDef {
    const d = this.defs.get(table);
    if (!d) throw new SqlError(`no such table: ${table}`);
    return d;
  }
  private loadDefs(e: DdlEntry): void {
    for (const d of e.defs) this.defs.set(d.name, d);
    for (const n of e.drops) this.defs.delete(n);
  }

  private async ensureSchema(version: number): Promise<void> {
    // 古い表定義の要求を通すと、新しいグローバル index の更新が漏れる。経路と同じく取り直させる。
    if (version < this.schema) throw new NotOwner(`stale schema ${version} < ${this.schema}`);
    if (version === this.schema) {
      // DDL の適用が intent の決着を待っている間は、古い表定義の新しい要求を受けない。
      // 受けると intent が増え続けて、DDL がいつまでも適用できない。呼び出し側は表定義を取り直して、同じ待ちに合流する。
      if (this.schemaChange) throw new NotOwner(`stale schema ${version}: a schema change is being applied`);
      return;
    }
    this.schemaChange ??= this.applySchema().finally(() => {
      this.schemaChange = null;
    });
    await this.schemaChange;
    // 待っている間に、さらに新しい DDL が出ているかもしれない。
    if (version > this.schema) await this.ensureSchema(version);
  }

  /**
   * 待ちを挟んだ後で、要求の表定義がまだ現行かを確かめ直す。
   * 入口で確かめた後、行ロックや intent の決着を待っている間に DDL が適用されることがある。
   * そのまま書くと、新しいグローバル index を保守しない古い計画が通ってしまう。
   */
  private requireSchema(version: number): void {
    if (this.faults.noSchemaRecheck) return;
    if (version !== this.schema) throw new NotOwner(`stale schema ${version} < ${this.schema}`);
  }

  /**
   * Meta から DDL を取り、順に適用する。
   * 先に、このシャードが持つ intent をすべて決着させる。intent の行イメージは DDL より前の表の形なので、
   * 表や列が消えた後では適用できない。確定済みの取引がそうなると、再駆動が永久に失敗する。
   */
  private async applySchema(): Promise<void> {
    if (!this.faults.ddlIgnoresIntents) await this.settleAllIntents();
    const { ddl } = await this.deps.meta.ddlSince(this.schema);
    for (const e of ddl) {
      if (e.version <= this.schema) continue;
      this.b.tx(() => {
        for (const s of e.sql) this.b.exec(s);
        this.b.exec(`INSERT INTO __ddl(version, entry) VALUES (?, ?)`, e.version, JSON.stringify(e));
      });
      this.loadDefs(e);
      this.schema = e.version;
      // 変更ログの行イメージは DDL より前の形なので、それより古い T は読み戻せない。
      this.ddlFloor = this.issue();
      this.metaSet("ddl_floor", this.ddlFloor);
    }
  }

  /**
   * 持っている intent を、anchor に尋ねて全部決着させる。進行中の取引は終わるまで待つ。
   * 待っている間、新しい prepare は ensureSchema が断るので、intent は増えない。
   */
  private async settleAllIntents(): Promise<void> {
    // 待ちは実時間のタイマーなので、期限も実時間で測る。
    const deadline = Date.now() + SCHEMA_WAIT_MS;
    for (;;) {
      const pending = this.b.exec(`SELECT DISTINCT txn, anchor FROM __intents`) as unknown as Intent[];
      if (pending.length === 0) return;
      for (const i of pending) {
        const res = await this.ask(i.anchor, i.txn, 0);
        if (res.status === "committed") await this.finalize({ txn: i.txn, c: res.c });
        else if (res.status === "aborted") await this.abort({ txn: i.txn });
      }
      if ((this.b.exec(`SELECT count(*) n FROM __intents`)[0]!.n as number) === 0) return;
      if (Date.now() > deadline) {
        throw new ConflictError("schema change is waiting for transactions on this shard to finish");
      }
      await new Promise((r) => setTimeout(r, 5));
    }
  }

  // ---- 時計 ----

  /** HLC を進めた値が保存済みの上限を超えたら、上限を先取りして保存する (最大で毎秒 1 回)。 */
  private guardCeiling(): void {
    if (this.faults.hlcNoCeiling || this.hlc.value <= this.ceiling) return;
    this.ceiling = this.hlc.value + SECOND;
    this.metaSet("ceiling", this.ceiling);
  }
  private issue(): Ts {
    const t = this.hlc.tick(this.deps.clock.now());
    this.guardCeiling();
    return t;
  }
  private observe(ts: Ts | undefined): void {
    if (ts === undefined) return;
    this.hlc.observe(ts);
    this.guardCeiling();
  }

  // ---- 所有権 ----

  private fencedRange(sk: string): FencedRange | undefined {
    const slot = slotOf(sk);
    return this.fenced.find((f) => slot >= f.start && slot < f.end);
  }
  private incomingRange(sk: string): IncomingRange | undefined {
    const slot = slotOf(sk);
    return this.incoming.find((f) => slot >= f.start && slot < f.end);
  }
  private sksOf(spans: Span[], writes: Pick<Change, "sk">[] = []): string[] {
    const out = new Set<string>(writes.map((w) => w.sk));
    for (const s of spans) if (s.kind === "pk" || s.kind === "sk" || (s.kind === "pred" && s.sk)) out.add(s.sk!);
    return [...out];
  }

  /** await の前に呼ぶ。未着のグループを引き取る。 */
  private async ensureArrived(sks: string[]): Promise<void> {
    const wanted = sks.filter((g) => this.incomingRange(g) && !this.arrived.has(g));
    if (wanted.length) await this.pullGroups(wanted);
  }

  /**
   * 同期区間の入口で呼ぶ。親は fence した範囲を一切受理せず、子は T < m を拒否する。
   * 子に T < m の状態はないので、答えると移動前の commit を失った結果を返すことになる。
   */
  private assertOwned(spans: Span[], writes: Pick<Change, "sk">[], T: Ts | null): void {
    for (const sk of this.sksOf(spans, writes)) {
      const f = this.fencedRange(sk);
      if (f && !this.faults.ignoreFence) throw new NotOwner(f.to);
      if (this.incomingRange(sk) && !this.arrived.has(sk)) throw new ConflictError(`group not arrived: ${sk}`);
      const m = this.arrived.get(sk);
      if (m !== undefined && T !== null && T < m && !this.faults.servePastMove) throw new ReadTooOld(`moved at ${m}`);
    }
    if (spans.some((s) => s.kind === "table" || (s.kind === "pred" && !s.sk))) {
      // 全表の読みは親と子の両方に行く。移動の途中は片方のグループが飛行中で、欠落が起こり得る。
      if (this.incoming.length > 0 || this.fenced.some((f) => !f.done)) throw new Migrating();
      if (T !== null && T < this.maxArrived && !this.faults.servePastMove) throw new ReadTooOld(`moved at ${this.maxArrived}`);
    }
  }

  // ---- ライブ移動 ----

  async beginIncoming(req: { start: number; end: number; from: string; schema: number }): Promise<void> {
    await this.ensureSchema(req.schema);
    if (this.incoming.some((x) => x.start === req.start && x.end === req.end)) return;
    this.b.exec(`INSERT INTO __incoming(start, end, from_id) VALUES (?, ?, ?)`, req.start, req.end, req.from);
    this.incoming.push({ start: req.start, end: req.end, from_id: req.from });
    await this.b.sync();
  }

  async fence(req: { start: number; end: number; to: string }): Promise<void> {
    if (this.fenced.some((x) => x.start === req.start && x.end === req.end)) return;
    this.b.exec(`INSERT INTO __fenced(start, end, "to") VALUES (?, ?, ?)`, req.start, req.end, req.to);
    this.fenced.push({ ...req, done: 0 });
    await this.b.sync();
  }

  /**
   * 範囲のグループを列挙する。fence の後に呼べば取り残しはない。
   * ack されていないグループは移動済みでも返す。子が受け取る前に落ちると応答が失われるからである。
   */
  async listGroups(req: { start: number; end: number; limit: number; cursor?: GroupCursor | null }): Promise<{ groups: string[]; cursor: GroupCursor | null }> {
    const out: string[] = [];
    const seen = new Set<string>();
    const add = (g: string) => {
      const slot = slotOf(g);
      if (slot >= req.start && slot < req.end && !this.moved.get(g)?.acked && !seen.has(g)) {
        seen.add(g);
        out.push(g);
      }
    };
    // 表は名前の順に、表の中は shard key の順に読み、前回の続きから始める。
    // 毎回先頭から読むと、行ごとに shard key が違う表 (既定の `id INTEGER PRIMARY KEY`) では、
    // 呼ぶたびに全行を読み直し、全部を配列に持つことになる。
    const tables = [...this.defs.keys()].sort();
    let cursor: GroupCursor = req.cursor ?? { table: tables[0] ?? null, after: null };
    while (cursor.table !== null) {
      const def = this.defs.get(cursor.table);
      if (def) {
        const cols = def.shardKey.map(q).join(", ");
        const keyset = cursor.after !== null && cursor.after.every((v) => v !== null);
        const where = keyset ? `WHERE (${cols}) > (${def.shardKey.map(() => "?").join(", ")})` : "";
        const skip = keyset ? 0 : (cursor.skip ?? 0);
        const { rows } = this.b.iterate(
          `SELECT DISTINCT ${cols} FROM ${q(def.name)} ${where} ORDER BY ${cols} LIMIT -1 OFFSET ${skip}`,
          ...(keyset ? cursor.after! : []),
        );
        let read = 0;
        for (const r of rows) {
          read++;
          add(encode(r));
          if (out.length >= req.limit) {
            // NULL を含む shard key は行の比較で絞れないので、読んだ数で続きを表す。
            const next: GroupCursor = r.every((v) => v !== null)
              ? { table: cursor.table, after: r }
              : { table: cursor.table, after: null, skip: skip + read };
            return { groups: out, cursor: next };
          }
        }
      }
      const name: string = cursor.table;
      cursor = { table: tables.find((t) => t > name) ?? null, after: null };
    }
    // 行のないグループも運ぶ。intent だけがある場合と、ack が届いていない場合である。
    for (const r of this.b.exec(`SELECT DISTINCT sk FROM __intents`)) add(r.sk as string);
    for (const [g] of this.moved) add(g);
    return { groups: out, cursor: null };
  }

  /**
   * グループを子へ渡す。m を確定してから応答するので、再送しても同じ m になる。
   * 親は ack まで行を保持する。子が受け取る前に落ちても再送で取り戻せるからである。
   */
  async pull(req: { groups: string[]; to: string; maxBytes: number }): Promise<GroupPayload[]> {
    const out: GroupPayload[] = [];
    let bytes = 0;
    for (const g of req.groups) {
      const f = this.fencedRange(g);
      if (!f || f.to !== req.to) {
        const known = this.moved.get(g);
        if (known && known.to !== req.to) throw new NotOwner(known.to);
        if (!f) throw new SqlError(`pull of unfenced group ${g}`);
      }
      const rows = [...this.defs.values()].flatMap((def) =>
        selectGroup(this.b, def, g).map((row) => ({ table: def.name, row })),
      );
      const intents = this.faults.dropIntentsOnMove ? [] : this.b.exec(`SELECT * FROM __intents WHERE sk = ?`, g);
      const size = encode(rows).length + encode(intents).length;
      // 1 グループは 1 回の RPC で運ぶ。RPC の上限 (32 MiB) を超える大きさは運べないので、はっきり断る。
      // 断らないと、運べないまま再試行を続け、原因が見えない。
      if (size > GROUP_MAX_BYTES) {
        throw new SqlError(`group too large to move: shard key ${g} holds ${size} bytes (limit ${GROUP_MAX_BYTES}); this split cannot finish`);
      }
      if (out.length > 0 && bytes + size > req.maxBytes) break;
      bytes += size;
      let known = this.moved.get(g);
      if (!known) {
        known = { m: this.issue(), to: req.to, acked: false };
        this.moved.set(g, known);
        this.b.tx(() => {
          this.b.exec(`INSERT INTO __moved(g, m, dest) VALUES (?, ?, ?)`, g, known!.m, req.to);
          for (const i of intents) {
            this.b.exec(`INSERT OR IGNORE INTO __moved_txn(txn, g, dest) VALUES (?, ?, ?)`, i.txn as string, g, req.to);
          }
        });
      }
      out.push({ g, m: known.m, rows, intents, schema: this.schema });
    }
    await this.b.sync();
    return out;
  }

  private pullGroups(groups: string[]): Promise<void> {
    const waits: Promise<void>[] = [];
    const fresh: string[] = [];
    for (const g of groups) {
      const p = this.pulling.get(g);
      if (p) waits.push(p);
      else fresh.push(g);
    }
    if (fresh.length) {
      const job = this.fetchGroups(fresh).finally(() => {
        for (const g of fresh) this.pulling.delete(g);
      });
      for (const g of fresh) this.pulling.set(g, job);
      waits.push(job);
    }
    return Promise.all(waits).then(() => undefined);
  }

  private async fetchGroups(groups: string[]): Promise<void> {
    const byParent = new Map<string, string[]>();
    for (const g of groups) {
      const from = this.incomingRange(g)!.from_id;
      byParent.set(from, [...(byParent.get(from) ?? []), g]);
    }
    for (const [from, list] of byParent) {
      let rest = list;
      while (rest.length) {
        const payload = await this.deps.peer(from).pull({ groups: rest, to: this.id, maxBytes: 1_000_000 });
        await this.receive(payload);
        void this.deps.peer(from).ack({ groups: payload.map((p) => p.g) }).catch(() => {});
        const got = new Set(payload.map((p) => p.g));
        rest = rest.filter((g) => !got.has(g));
      }
    }
  }

  private async receive(payload: GroupPayload[]): Promise<void> {
    // 親の表定義の版まで追いついてから受け取る。子は増設の途中で生まれるので、DDL の「全シャードへの適用」から
    // 漏れることがある。古い版のままだと、届いた行と表の形が合わず、新しい index を保守しない古い計画の書き込みも通る。
    const version = Math.max(0, ...payload.map((p) => p.schema ?? 0));
    if (version > this.schema && !this.faults.childKeepsOldSchema) await this.ensureSchema(version);
    const fresh = payload.filter((p) => !this.arrived.has(p.g));
    this.b.tx(() => {
      for (const p of fresh) {
        for (const { table, row } of p.rows) insertRow(this.b, this.def(table), row);
        for (const i of p.intents) {
          this.b.exec(
            `INSERT OR IGNORE INTO __intents(tbl, pk, sk, txn, anchor, prepare_ts, change) VALUES (?, ?, ?, ?, ?, ?, ?)`,
            i.tbl ?? null, i.pk ?? null, i.sk ?? null, i.txn ?? null, i.anchor ?? null, i.prepare_ts ?? null, i.change ?? null,
          );
        }
        this.b.exec(`INSERT OR IGNORE INTO __arrived(g, m) VALUES (?, ?)`, p.g, p.m);
      }
    });
    // 到着の印は挿入と同じ同期区間で付ける。sync の待ちの間に、要求駆動の pull と背景の drain が
    // 同じグループを受け取ると二重に挿入してしまう。応答は output gate が確定まで止めるので安全である。
    for (const p of fresh) {
      this.arrived.set(p.g, p.m);
      this.maxArrived = Math.max(this.maxArrived, p.m);
      this.observe(p.m);
    }
    await this.b.sync(); // 親が行を消すのは到着の確定後である。
  }

  async ack(req: { groups: string[] }): Promise<void> {
    this.b.tx(() => {
      for (const g of req.groups) {
        const known = this.moved.get(g);
        if (!known || known.acked) continue;
        for (const def of this.defs.values()) {
          for (const row of selectGroup(this.b, def, g)) deleteRow(this.b, def, encodeKey(def, row).pk);
        }
        this.b.exec(`DELETE FROM __intents WHERE sk = ?`, g);
        this.b.exec(`UPDATE __moved SET acked = 1 WHERE g = ?`, g);
        known.acked = true;
      }
    });
  }

  async drain(req: { start: number; end: number }): Promise<{ groups: number; rows: number; bytes: number }> {
    const range = this.incoming.find((x) => x.start === req.start && x.end === req.end);
    if (!range) return { groups: 0, rows: 0, bytes: 0 };
    const parent = this.deps.peer(range.from_id);
    const total = { groups: 0, rows: 0, bytes: 0 };
    // 親のグループを先頭から順に列挙して運ぶ。最後まで行ったら、もう一度先頭から列挙して、取り残しがないことを確かめる。
    // ack 済みのグループは親から消えているので、2 周目は残る側のグループを読むだけである。
    for (let pass = 0; ; pass++) {
      let cursor: GroupCursor | null | undefined = undefined;
      let moved = 0;
      do {
        const page: { groups: string[]; cursor: GroupCursor | null } = await parent.listGroups({ ...req, limit: 256, cursor });
        cursor = page.cursor;
        // 受け取り済みで親に ack が届いていないグループは、ack だけを送り直す。
        const done = page.groups.filter((g) => this.arrived.has(g));
        if (done.length) await parent.ack({ groups: done });
        let rest = page.groups.filter((g) => !this.arrived.has(g));
        moved += page.groups.length;
        // pull は大きさの上限で途中までしか返さないことがある。残りを取り終えるまで繰り返す。
        while (rest.length) {
          const payload = await parent.pull({ groups: rest, to: this.id, maxBytes: 1_000_000 });
          await this.receive(payload);
          await parent.ack({ groups: payload.map((p) => p.g) });
          total.groups += payload.length;
          for (const p of payload) {
            total.rows += p.rows.length;
            total.bytes += encode(p.rows).length;
          }
          const got = new Set(payload.map((p) => p.g));
          rest = rest.filter((g) => !got.has(g));
        }
      } while (cursor !== null);
      if (moved === 0) return total;
      if (pass > 100) throw new SqlError("drain does not converge");
    }
  }

  async finishMove(req: { start: number; end: number }): Promise<void> {
    this.b.exec(`UPDATE __fenced SET done = 1 WHERE start = ? AND end = ?`, req.start, req.end);
    for (const f of this.fenced) if (f.start === req.start && f.end === req.end) f.done = 1;
  }

  async finishIncoming(req: { start: number; end: number }): Promise<void> {
    this.b.exec(`DELETE FROM __incoming WHERE start = ? AND end = ?`, req.start, req.end);
    this.incoming = this.incoming.filter((x) => !(x.start === req.start && x.end === req.end));
  }

  async health(_req: Record<string, never>): Promise<ShardHealth> {
    const one = (sql: string, ...params: Value[]) => (this.b.exec(sql, ...params)[0]?.v as number | null) ?? 0;
    const oldest = one(`SELECT min(prepare_ts) v FROM __intents`);
    return {
      id: this.id, schema: this.schema, format: STORAGE_FORMAT, bytes: this.b.size(),
      intents: one(`SELECT count(*) v FROM __intents`),
      oldestIntentMs: oldest === 0 ? 0 : Math.max(0, this.deps.clock.now() - tsToPhysical(oldest)),
      unapplied: one(`SELECT count(*) v FROM __txn WHERE status = 'committed' AND done = 0`),
      redriveErrors: this.lastRedriveErrors,
      incoming: this.incoming.length,
      outgoing: this.fenced.filter((f) => !f.done).length,
      logGenerations: this.logGens().length,
    };
  }

  /**
   * 表の行を主キーの順に、after より後から limit 行まで返す。pk は columns の中の主キーの列の位置である。
   * 最新の確定済みの状態を読むだけで、時点はそろえない。移動の途中のシャードでは、同じ行が親と子の両方にあるので断る。
   */
  async exportRows(req: { table: string; after: Value[] | null; limit: number }): Promise<{ columns: string[]; rows: Value[][]; pk: number[] }> {
    if (this.incoming.length > 0 || this.fenced.some((f) => !f.done)) throw new Migrating();
    const def = this.defs.get(req.table);
    if (!def) throw new SqlError(`no such table: ${req.table}`);
    const cols = def.pk.map(q).join(", ");
    const keyset = req.after !== null && req.after.every((v) => v !== null);
    const where = keyset ? `WHERE (${cols}) > (${def.pk.map(() => "?").join(", ")})` : "";
    const limit = Math.max(1, Math.min(req.limit, 5000));
    const { columns, rows } = this.b.iterate(
      `SELECT ${selectList(def)} FROM ${q(def.name)} ${where} ORDER BY ${cols} LIMIT ${limit}`, ...(keyset ? req.after! : []),
    );
    const out: Value[][] = [];
    let bytes = 0;
    for (const r of rows) {
      out.push(r);
      for (const v of r) bytes += sizeOf(v);
      // 1 回の応答が大きくなりすぎないよう、行数の上限より先にバイト数で切る。続きは次の呼び出しで読む。
      if (bytes > 4_000_000) break;
    }
    return { columns, rows: out, pk: def.pk.map((c) => columns.indexOf(c)) };
  }

  async metrics(_req: Record<string, never>): Promise<ShardMetrics> {
    const now = this.deps.clock.now();
    const s = this.stats;
    const total = [...s.groups.values()].reduce((a, b) => a + b, 0);
    const top = [...s.groups.entries()].sort((a, b) => b[1] - a[1])[0];
    const out: ShardMetrics = {
      id: this.id, size: this.b.size(), reads: s.reads, writes: s.writes,
      elapsedMs: s.at === 0 ? 0 : now - s.at,
      topGroup: top && total > 0 ? { g: top[0], share: top[1] / total } : null,
      migrating: this.incoming.length > 0 || this.fenced.some((f) => !f.done),
    };
    this.stats = { at: now, reads: 0, writes: 0, groups: new Map() };
    return out;
  }

  private count(kind: "reads" | "writes", spans: Span[], writes: Pick<Change, "sk">[] = []): void {
    // 起動後の最初の要求から数え始める。0 のままだと最初の報告の経過時間が 0 になり、
    // Autoscaler は眠っていたシャードの負荷を次の問い合わせまで判断できない。
    if (this.stats.at === 0) this.stats.at = this.deps.clock.now();
    this.stats[kind]++;
    if (this.stats.groups.size > 4096) return;
    for (const sk of this.sksOf(spans, writes)) this.stats.groups.set(sk, (this.stats.groups.get(sk) ?? 0) + 1);
  }

  // ---- 行ロック ----

  private lockKey(table: string, pk: string): string {
    return `${table}\0${pk}`;
  }

  private liveLock(key: string): RowLock | undefined {
    const l = this.locks.get(key);
    if (l && l.expires <= this.deps.clock.now()) {
      this.locks.delete(key);
      this.wakeNext(key);
      return undefined;
    }
    return l;
  }

  private wakeNext(key: string): void {
    const q2 = this.waiters.get(key);
    const next = q2?.shift();
    if (q2 && q2.length === 0) this.waiters.delete(key);
    next?.wake();
  }

  private wakeAll(key: string): void {
    for (const w of this.waiters.get(key) ?? []) w.wake();
    this.waiters.delete(key);
  }

  private grant(key: string, owner: LockOwner): void {
    this.locks.set(key, { ...owner, expires: this.deps.clock.now() + (this.deps.lockTtlMs ?? LOCK_TTL_MS) });
  }

  private renew(txn: string): void {
    const until = this.deps.clock.now() + (this.deps.lockTtlMs ?? LOCK_TTL_MS);
    for (const l of this.locks.values()) if (l.txn === txn) l.expires = until;
  }

  private releaseLocks(txn: string): void {
    for (const [key, l] of this.locks) {
      if (l.txn !== txn) continue;
      this.locks.delete(key);
      this.wakeNext(key);
    }
  }

  async unlock(req: { txn: string }): Promise<void> {
    this.releaseLocks(req.txn);
  }

  /** 古い取引が優先される。 */
  private older(a: LockOwner, b: LockOwner): boolean {
    return a.start < b.start || (a.start === b.start && a.txn < b.txn);
  }

  /**
   * ロックか intent が空くまで待つ。wound-wait で、若い保持者からは取り上げる。
   * 取り上げられた取引は commit の検証で気付く。prepare 済みの intent は取り上げられないので待つ。
   * prepare 自身はこの待ちに入らない。入ると閉路ができる。
   */
  private waitForRow(key: string, me: LockOwner, deadline: number): Promise<void> {
    const held = this.liveLock(key);
    return new Promise((resolve, reject) => {
      const list = this.waiters.get(key) ?? [];
      const leave = () => {
        const at = list.indexOf(w);
        if (at >= 0) list.splice(at, 1);
        clearTimeout(timer);
        clearTimeout(wound);
        clearTimeout(expiry);
      };
      const timer = setTimeout(() => {
        leave();
        reject(new ConflictError("lock wait timeout"));
      }, Math.max(1, deadline - this.deps.clock.now()));
      const wound = held && this.older(me, held)
        ? setTimeout(() => {
            if (this.locks.get(key)?.txn !== held.txn) return;
            this.locks.delete(key);
            leave();
            resolve();
          }, WOUND_DELAY_MS)
        : undefined;
      // 保持者の Worker が死ぬと誰もロックを解放しない。期限で確かめないと待ち手が眠ったままになる。
      let expiry: ReturnType<typeof setTimeout> | undefined;
      const watch = () => {
        const l = this.liveLock(key); // 切れていれば wakeNext が先頭を起こす
        if (l) expiry = setTimeout(watch, Math.max(1, l.expires - this.deps.clock.now() + 1));
      };
      if (held) expiry = setTimeout(watch, Math.max(1, held.expires - this.deps.clock.now() + 1));
      const w: Waiter = { ...me, wake: () => { leave(); resolve(); } };
      // 古い取引を先に起こす。同じ開始時刻の間は到着順である。
      const at = list.findIndex((x) => this.older(me, x));
      list.splice(at < 0 ? list.length : at, 0, w);
      this.waiters.set(key, list);
    });
  }

  private blockedBy(changes: Pick<Change, "table" | "pk">[], me: LockOwner): string | null {
    for (const c of changes) {
      const key = this.lockKey(c.table, c.pk);
      const held = this.liveLock(key);
      if (held && held.txn !== me.txn) return key;
      const intent = this.intentAt(c.table, c.pk);
      if (intent && intent.txn !== me.txn) return key;
    }
    return null;
  }

  /**
   * 悲観的な DML。最新の状態 F で実行し、変更行のロックを取る。
   * 先に intent を決着させる。確定済みで未適用の行を読み飛ばすと、T も F も新しいのに見えない commit ができる。
   */
  private async lockedExec(req: ExecReq, me: LockOwner): Promise<ExecRes> {
    const deadline = this.deps.clock.now() + LOCK_WAIT_MS;
    // 起こされた行。取らずに去るなら次の待ち手を起こす。起こすのは先頭の 1 件だけだからである。
    let woken: string | null = null;
    try {
      for (;;) {
        await this.ensureArrived(this.sksOf(req.spans));
        this.observe(req.minTs);
        this.observe(req.T);
        let F = this.issue();
        this.assertOwned(req.spans, [], null);
        let applied = await this.settleIntents(req.spans, F);
        while (applied) {
          F = this.issue();
          applied = await this.settleIntents(req.spans, F);
        }
        // ここから先は await を挟まない。
        this.assertOwned(req.spans, [], null);
        this.count("writes", req.spans);
        this.renew(me.txn);
        const overlay = (req.overlay ?? []).map((c) => ({ table: c.table, pk: c.pk, image: c.after }));
        const out = this.rollback(() => {
          if (overlay.length) setBasedRestore(this.b, (t) => this.def(t), overlay);
          return this.run(req);
        });
        const rows = [...out.changes, ...(req.lockRows ?? [])] as Pick<Change, "table" | "pk">[];
        const blocked = this.blockedBy(rows, me);
        if (!blocked) {
          for (const c of rows) this.grant(this.lockKey(c.table, c.pk), me);
          if (woken && this.locks.get(woken)?.txn === me.txn) woken = null;
          return { ...out, changes: out.changes.map((c) => ({ ...c, since: F })), F, T: req.T ?? F, hlc: this.hlc.value, epoch: this.epoch };
        }
        if (woken && woken !== blocked) this.wakeNext(woken);
        woken = null;
        if (this.deps.clock.now() >= deadline) throw new ConflictError("lock wait timeout");
        await this.waitForRow(blocked, me, deadline);
        woken = blocked;
      }
    } finally {
      if (woken) this.wakeNext(woken);
    }
  }

  async syncSchema(req: { version: number }): Promise<void> {
    if (req.version > this.schema) await this.ensureSchema(req.version);
  }

  async now(_req: Record<string, never>): Promise<Ts> {
    return this.issue();
  }

  // ---- intent の解決 ----

  private overlapping(spans: Span[], upTo: Ts): Intent[] {
    const all = this.b.exec(`SELECT * FROM __intents WHERE prepare_ts <= ?`, upTo) as unknown as Intent[];
    return all.filter((i) => spans.some((s) => spanCovers(s, i.tbl, i.pk, i.sk) && this.intentMatches(s, i)));
  }

  /** intent が述語に関わるか。適用後の行と、本体の現在の行のどちらかが満たせば関わる。 */
  private intentMatches(s: Span, i: Intent): boolean {
    if (s.kind !== "pred") return true;
    const c = decode<Change>(i.change);
    const def = this.defs.get(s.table);
    if (!def) return true;
    const current = selectRow(this.b, def, c.pk);
    return [c.after, current].some((row) => row !== null && this.rowMatches(s, def, c.pk, row));
  }

  /**
   * 行イメージが述語を満たすかを本物の表で判定する。型親和性と照合順序が読み取りと同じになるからである。
   * 判定できないときは競合側へ倒す。誤って「関係ない」と答えると Serializable が破れる。
   */
  private rowMatches(s: Extract<Span, { kind: "pred" }>, def: TableDef, pk: string, row: Row): boolean {
    try {
      return this.rollback(() => {
        deleteRow(this.b, def, pk);
        insertRow(this.b, def, row);
        const key = def.pk.map((c) => `${q(s.alias)}.${q(c)} IS ?`).join(" AND ");
        const sql = `SELECT 1 FROM ${q(def.name)} AS ${q(s.alias)} WHERE (${s.where}) AND ${key} LIMIT 1`;
        return this.b.exec(sql, ...s.params, ...decode<Value[]>(pk)).length > 0;
      });
    } catch {
      return true;
    }
  }

  /** (from, 現在] の commit のうち、述語に関わるものがあるか。 */
  private predicateChanged(s: Extract<Span, { kind: "pred" }>, from: Ts): boolean {
    const def = this.defs.get(s.table);
    if (!def || from < this.logLowWater || from < this.ddlFloor) return true;
    const rows = this.logScan(`WHERE commit_ts > ?`, [from], PRED_WINDOW + 1);
    if (rows.length > PRED_WINDOW) return true;
    for (const r of rows) {
      for (const c of decode<Change[]>(r.blob as string)) {
        if (c.table !== s.table || !spanCovers(s, c.table, c.pk, c.sk)) continue;
        // 各版はどれかの commit の before か after に現れるので、途中の版も見逃さない。
        if ([c.before, c.after].some((row) => row !== null && this.rowMatches(s, def, c.pk, row))) return true;
      }
    }
    return false;
  }

  private async ask(anchor: string, txn: string, pushTo: Ts): Promise<TxnStatus> {
    return anchor === this.id ? this.queryTxn({ txn, pushTo }) : this.deps.peer(anchor).queryTxn({ txn, pushTo });
  }

  /**
   * T 以下で確定し得る intent をすべて決着させる。
   * 無視してよいのは commit 時刻が T を超えると確定した intent だけである。
   */
  private async settleIntents(spans: Span[], T: Ts): Promise<Ts> {
    const pushed = new Set<string>();
    // 適用した取引の commit 時刻の最大値。何も適用していなければ 0。
    let applied: Ts = 0;
    for (;;) {
      const pending = this.overlapping(spans, T).filter((i) => !pushed.has(i.txn));
      if (pending.length === 0) return applied;
      for (const txn of new Set(pending.map((i) => i.txn))) {
        const intent = pending.find((i) => i.txn === txn)!;
        if (this.faults.readerTimeoutPass) {
          pushed.add(txn);
          continue;
        }
        const res = await this.ask(intent.anchor, txn, T);
        if (res.status === "committed") {
          await this.finalize({ txn, c: res.c });
          applied = Math.max(applied, res.c);
        } else if (res.status === "aborted") await this.abort({ txn });
        else pushed.add(txn);
      }
    }
  }

  // ---- rollback-read ----

  private rollback<T>(fn: () => T): T {
    let out: { v: T } | undefined;
    try {
      this.b.tx(() => {
        out = { v: fn() };
        throw ROLLBACK;
      });
    } catch (e) {
      if (e !== ROLLBACK) throw e;
    }
    return out!.v;
  }

  /** T より後の commit について、pk ごとに最も古い before-image を集める。 */
  private deltaAfter(T: Ts): { table: string; pk: string; image: Row | null }[] {
    if (T >= this.maxCommit) return [];
    const floor = Math.max(this.logLowWater, this.ddlFloor);
    if (T < floor) throw new ReadTooOld(`moved at ${floor}`);
    const seen = new Map<string, { table: string; pk: string; image: Row | null }>();
    // K を超えた時点で読むのをやめる。T 以降の全ログを読んでから数えると、古い T の読みが来るたびに保持窓の全行を読む。
    this.logEach(`WHERE commit_ts > ?`, [T], (_ts, _txn, blob) => {
      for (const c of decode<Change[]>(blob)) {
        const key = `${c.table}\0${c.pk}`;
        if (!seen.has(key) && this.defs.has(c.table)) seen.set(key, { table: c.table, pk: c.pk, image: c.before });
      }
      return seen.size <= this.K;
    });
    if (seen.size > this.K) throw new ReadTooOld(`delta exceeds K=${this.K}`);
    return [...seen.values()];
  }

  private restore(targets: { table: string; pk: string; image: Row | null }[]): void {
    if (targets.length === 0) return;
    const cat = (t: string) => this.def(t);
    if (this.faults.rowwiseUndo) rowwiseRestore(this.b, cat, targets);
    else setBasedRestore(this.b, cat, targets);
  }

  /**
   * 文を実行し、書き込み文なら行の変更に落とす。書き込み文は必ず rollback の中で呼ぶ。
   * 文の意味は SQLite が解釈し、変更行は trigger が捕捉するので、UPSERT や
   * INSERT ... SELECT のような構文でも Worker 側で解析する必要がない。
   */
  private run(req: ExecReq): { columns: string[]; values: Value[][]; changes: Change[] } {
    if (!req.write) return { ...this.readLimited(req), changes: [] };
    const captured = this.runCaptured(req);
    if (captured) return captured;
    // REPLACE が暗黙に消す行は recursive_triggers がないと DELETE trigger を発火しない。
    this.b.exec(`PRAGMA recursive_triggers = ON`);
    this.b.exec(`INSERT INTO __cap_on VALUES (1)`);
    const out = this.b.raw(req.sql, ...req.params);
    const changes = capturedChanges(this.b, (t) => this.def(t));
    const sk = req.write.sk;
    if (sk !== null) {
      for (const c of changes) {
        if (c.sk !== sk) throw new SqlError(`row of shard key ${c.sk} written through shard key ${sk}`);
      }
    }
    return { ...out, changes };
  }

  /** 読み取りの文を実行し、上限を超えた時点で打ち切る。全行を集めてから数えると、数える前にメモリが尽きる。 */
  private readLimited(req: ExecReq): { columns: string[]; values: Value[][] } {
    const maxRows = Math.min(req.maxRows ?? SHARD_MAX_ROWS, SHARD_MAX_ROWS);
    const maxBytes = Math.min(req.maxBytes ?? SHARD_MAX_BYTES, SHARD_MAX_BYTES);
    const { columns, rows } = this.b.iterate(req.sql, ...req.params);
    const values: Value[][] = [];
    let bytes = 0;
    for (const row of rows) {
      values.push(row);
      for (const v of row) bytes += sizeOf(v);
      if (values.length > maxRows) throw new SqlError(`result too large: more than ${maxRows} rows from one shard; narrow the query`);
      if (bytes > maxBytes) throw new SqlError(`result too large: more than ${maxBytes} bytes from one shard; narrow the query or select fewer columns`);
    }
    return { columns, values };
  }

  /** 時刻 T の状態 (と自分の未 commit write) の上で文を実行し、ROLLBACK する。 */
  async exec(req: ExecReq): Promise<ExecRes> {
    await this.ensureSchema(req.schema);
    if (req.lock && (req.write || req.lockRows)) {
      try {
        return await this.lockedExec(req, req.lock);
      } catch (e) {
        if (e instanceof ReadTooOld || e instanceof ConflictError || e instanceof NotOwner) throw e;
        throw asSqlError(e);
      }
    }
    if (req.lock) this.renew(req.lock.txn);
    await this.ensureArrived(this.sksOf(req.spans));
    this.observe(req.minTs);
    let T = req.T ?? this.issue();
    this.observe(T);
    this.assertOwned(req.spans, [], T);
    let applied = await this.settleIntents(req.spans, T);
    // 時刻が未指定の読みは、決着させた取引より後の時刻で読む。先に取った T のままだと、
    // 読み取りの開始前に確定した書き込みが見えない。push した取引の c が新しい T 以下になり得るので、
    // 決着が起きなくなるまで取り直す。
    while (req.T === undefined && applied) {
      T = this.issue();
      applied = await this.settleIntents(req.spans, T);
    }
    // T を指定した autocommit の読み (複数シャードの読み) も同じである。T は対象シャードの時計の最大値だが、
    // phase 2 が届いていない参加者の時計は commit 時刻に追いついていない。anchor の時計が進んでいると c > T になり、
    // そのまま T で読むと、開始前に確定して応答まで返った書き込みが見えない。T を取り直させる。
    if (req.T !== undefined && req.realtime && applied > T && !this.faults.noRealtimeBump) throw new ReadTooOld(`moved at ${this.hlc.value}`);
    // ここから先は await を挟まない。
    this.assertOwned(req.spans, [], T);
    this.count(req.write ? "writes" : "reads", req.spans);
    if (req.fresh && req.spans.some((s) => this.changedSince(s, T))) {
      throw new ReadTooOld(`moved at ${this.hlc.value}`);
    }
    const delta = this.deltaAfter(T);
    const overlay = (req.overlay ?? []).map((c) => ({ table: c.table, pk: c.pk, image: c.after }));
    try {
      if (delta.length === 0 && overlay.length === 0 && !req.write) {
        // 差分がなければ本体がそのまま T の状態なので、トランザクションは要らない。
        return { ...this.run(req), T, hlc: this.hlc.value, epoch: this.epoch };
      }
      const out = this.rollback(() => {
        this.restore(delta);
        if (overlay.length) setBasedRestore(this.b, (t) => this.def(t), overlay);
        return this.run(req);
      });
      return { ...out, T, hlc: this.hlc.value, epoch: this.epoch };
    } catch (e) {
      if (e instanceof ReadTooOld || e instanceof ConflictError || e instanceof NotOwner) throw e;
      throw asSqlError(e);
    }
  }

  /** シングルシャードの autocommit 書き込み。1 回の RPC で完結する。 */
  async execAuto(req: ExecReq): Promise<ExecRes> {
    await this.ensureSchema(req.schema);
    await this.ensureArrived(this.sksOf(req.spans));
    this.observe(req.minTs);
    const now = this.issue();
    this.assertOwned(req.spans, [], null);
    await this.settleIntents(req.spans, now);
    this.requireSchema(req.schema);
    this.assertOwned(req.spans, [], null);
    this.count("writes", req.spans);
    // 読む範囲に未決着の intent があると commit 時刻の順序を保証できないので no-wait で返す。
    if (!this.faults.ignoreIntentsInValidation && this.overlapping(req.spans, Number.MAX_SAFE_INTEGER).length > 0) {
      throw new ConflictError("pending intent");
    }
    try {
      if (req.write?.capture && !this.faults.triggerCapture) {
        const direct = await this.execDirect(req, now);
        if (direct) return direct;
      }
      let dry = this.rollback(() => this.run(req));
      // autocommit は取引より若いものとして順番を待つ。待っている間に行が変わるので実行し直す。
      const me: LockOwner = { txn: `auto-${now}`, start: this.deps.clock.now() };
      const deadline = this.deps.clock.now() + LOCK_WAIT_MS;
      // autocommit はロックを取らないので、起こされたら用が済み次第次の待ち手を起こす。
      const woken = new Set<string>();
      try {
        for (let key = this.blockedBy(dry.changes, me); key !== null; key = this.blockedBy(dry.changes, me)) {
          await this.waitForRow(key, me, deadline);
          woken.add(key);
          this.requireSchema(req.schema);
          this.assertOwned(req.spans, [], null);
          if (this.overlapping(req.spans, Number.MAX_SAFE_INTEGER).length > 0) throw new ConflictError("pending intent");
          dry = this.rollback(() => this.run(req));
        }
      } finally {
        for (const key of woken) queueMicrotask(() => this.wakeNext(key));
      }
      // 同じ主キーでなくても、他の取引の intent が同じ UNIQUE の値を持っていれば確定できない。
      const pending = this.faults.autoIgnoresUniqueIntents ? null : this.uniquePending(me.txn, dry.changes);
      if (pending) throw new ConflictError(pending);
      this.assertWriteSetFits(dry.changes);
      this.requireSchema(req.schema);
      const c = this.issue();
      if (dry.changes.length) this.b.tx(() => this.applyAndLog(`auto-${c}`, c, dry.changes));
      return { ...dry, T: c, hlc: this.hlc.value, epoch: this.epoch };
    } catch (e) {
      if (e instanceof ConflictError || e instanceof NotOwner) throw e;
      throw asSqlError(e);
    }
  }

  /**
   * 書き込み文を実行し、変更行を trigger ではなく RETURNING と主キーの読みで捕捉する。
   * trigger の捕捉は __cap、__capv、__cap_on へ書くので、ROLLBACK しても 1 文あたり 3 行が課金される。
   * 文の形が想定と合わなければ、その文だけを巻き戻して null を返す。呼び出し側は trigger の経路に任せる。
   */
  private runCaptured(req: ExecReq): { columns: string[]; values: Value[][]; changes: Change[] } | null {
    const capture = req.write?.capture;
    const span = req.spans[0];
    if (!capture || this.faults.triggerCapture || !span || req.spans.length !== 1) return null;
    if (capture === "update" && span.kind !== "pk") return null;
    const def = this.def(span.table);
    const sk = req.write!.sk;
    try {
      return this.b.tx(() => {
        const before = span.kind === "pk" && capture === "update" ? selectRow(this.b, def, span.pk) : null;
        const was = before && encodeKey(def, before).pk;
        const rows = this.b.exec(`${req.sql} RETURNING ${selectList(def)}`, ...req.params);
        if (capture === "update" && (rows.length > 1 || (rows.length === 1 && was !== encodeKey(def, rows[0]!).pk))) {
          throw FALLBACK;
        }
        const changes: Change[] = rows.map((row) => ({
          table: def.name, ...encodeKey(def, row),
          before: capture === "insert" ? null : capture === "delete" ? row : before,
          after: capture === "delete" ? null : row,
        }));
        if (sk !== null) {
          for (const c of changes) {
            if (c.sk !== sk) throw new SqlError(`row of shard key ${c.sk} written through shard key ${sk}`);
          }
        }
        return { columns: [], values: [], changes };
      });
    } catch (e) {
      if (e === FALLBACK) return null;
      throw e;
    }
  }

  /**
   * autocommit の高速経路。文を下書きせずに 1 回だけ実行し、そのまま確定する。
   * ROLLBACK した書き込みも課金されるので、下書きと再適用をやめると 1 行の更新が 6 行から 2 行になる。
   * 行ロックに当たったときだけ ROLLBACK して待つ。捕捉できない形なら null を返し、通常の経路に任せる。
   */
  private async execDirect(req: ExecReq, now: Ts): Promise<ExecRes | null> {
    const me: LockOwner = { txn: `auto-${now}`, start: this.deps.clock.now() };
    const deadline = this.deps.clock.now() + LOCK_WAIT_MS;
    const woken = new Set<string>();
    try {
      for (;;) {
        const hit: { key: string | null } = { key: null };
        const pending: { reason: string | null } = { reason: null };
        let out: { changes: Change[]; c: Ts } | undefined;
        try {
          out = this.b.tx(() => {
            const r = this.runCaptured(req);
            if (!r) throw FALLBACK;
            hit.key = this.blockedBy(r.changes, me);
            if (hit.key !== null) throw BLOCKED;
            pending.reason = this.faults.autoIgnoresUniqueIntents ? null : this.uniquePending(me.txn, r.changes);
            if (pending.reason) throw PENDING_UNIQUE;
            this.assertWriteSetFits(r.changes);
            const c = this.issue();
            if (r.changes.length) this.logChanges(`auto-${c}`, c, r.changes);
            return { changes: r.changes, c };
          });
        } catch (e) {
          if (e === FALLBACK) return null;
          if (e === PENDING_UNIQUE) throw new ConflictError(pending.reason!);
          if (e !== BLOCKED) throw e;
        }
        if (out) return { columns: [], values: [], changes: out.changes, T: out.c, hlc: this.hlc.value, epoch: this.epoch };
        await this.waitForRow(hit.key!, me, deadline);
        woken.add(hit.key!);
        this.requireSchema(req.schema);
        this.assertOwned(req.spans, [], null);
        if (this.overlapping(req.spans, Number.MAX_SAFE_INTEGER).length > 0) throw new ConflictError("pending intent");
      }
    } finally {
      for (const key of woken) queueMicrotask(() => this.wakeNext(key));
    }
  }

  private intentAt(table: string, pk: string): Intent | undefined {
    return this.b.exec(`SELECT * FROM __intents WHERE tbl = ? AND pk = ?`, table, pk)[0] as unknown as Intent | undefined;
  }

  // ---- 検証 ----

  private touch(table: string, pk: string, sk: string, ts: Ts): void {
    for (const k of [`p\0${table}\0${pk}`, `s\0${table}\0${sk}`, `t\0${table}`, `s\0*\0${sk}`, `t\0*`]) {
      if ((this.recent.get(k) ?? 0) < ts) this.recent.set(k, ts);
    }
  }

  /** from より後の write があるか。to より後の write も含むので保守的に abort する側へ倒れる。 */
  private changedSince(span: Span, from: Ts): boolean {
    const key =
      span.kind === "pk" ? `p\0${span.table}\0${span.pk}`
      : span.kind === "sk" ? `s\0${span.table}\0${span.sk}`
      : span.kind === "pred" && span.sk ? `s\0${span.table}\0${span.sk}`
      : `t\0${span.table}`;
    if ((this.recent.get(key) ?? 0) <= from) return false;
    return span.kind === "pred" ? this.predicateChanged(span, from) : true;
  }

  /** 検証に失敗したら理由を返す。`unique:` で始まる理由はリトライしても通らない。 */
  private validate(txn: string, T: Ts, writes: Change[], spans: Span[]): string | null {
    if (T < this.logLowWater || T < this.recentLowWater) return "T older than conflict window";
    const inf = Number.MAX_SAFE_INTEGER;
    for (const w of writes) {
      const held = this.intentAt(w.table, w.pk);
      if (held && held.txn !== txn) return `intent on ${w.table} ${w.pk}`;
      // prepare は待たない。待つと、prepare 済みの取引を待つ DML との間に閉路ができる。
      const lock = this.liveLock(this.lockKey(w.table, w.pk));
      if (lock && lock.txn !== txn) return `row locked by ${lock.txn}`;
      // ロックを持っていても検証は省かない。ロックは再起動、TTL、wound で消えているかもしれない。
      const since = this.faults.validateFromT ? T : (w.since ?? T);
      const trusted = this.faults.trustLocks && w.since !== undefined;
      if (!trusted && this.changedSince({ kind: "pk", table: w.table, pk: w.pk, sk: w.sk }, since)) return `write after T on ${w.pk}`;
      const def = this.def(w.table);
      const row = selectRow(this.b, def, w.pk);
      if (row && w.before === null) return `unique: ${w.table} ${w.pk}`;
    }
    for (const s of spans) {
      if (this.faults.trustLocks && s.since !== undefined) continue;
      if (this.changedSince(s, this.faults.validateFromT ? T : (s.since ?? T))) return `span changed after T`;
      if (this.faults.ignoreIntentsInValidation) continue;
      const hit = this.overlapping([s], inf).find((i) => i.txn !== txn);
      if (hit) return `intent inside read span (${hit.txn})`;
    }
    return this.checkUnique(txn, writes);
  }

  /** シャード内 UNIQUE。本体は SQLite に試適用して、未確定の値は intent と比べて確かめる。 */
  /**
   * 他の取引の intent が、同じ UNIQUE の値を持つ行を書こうとしているか。
   * intent は本体にないので、SQLite の制約では見つからない。見逃すと、確定済みの取引の phase 2 が
   * UNIQUE 違反で適用できなくなり、再駆動が永久に失敗する。書き込みの経路はすべてこれを通す。
   */
  private uniquePending(txn: string, writes: Change[]): string | null {
    const constrained = writes.filter((w) => w.after && this.def(w.table).uniques.length > 0);
    if (constrained.length === 0) return null;
    const others = (this.b.exec(`SELECT * FROM __intents WHERE txn <> ?`, txn) as unknown as Intent[]).map(
      (i) => decode<Change>(i.change),
    );
    for (const w of constrained) {
      for (const cols of this.def(w.table).uniques) {
        const same = others.find((o) => o.table === w.table && o.after && cols.every((c) => o.after![c] === w.after![c]));
        if (same) return `unique pending: ${w.table} ${cols.join(",")}`;
      }
    }
    return null;
  }

  /** 取引がこのシャードに書く変更が、変更ログの 1 行に収まるか。収まらなければ確定の前に拒否する。 */
  private assertWriteSetFits(writes: Change[]): void {
    if (this.faults.noWriteSetLimit || writes.length === 0) return;
    let bytes = 0;
    for (const w of writes) {
      bytes += encode(w).length;
      if (bytes > MAX_WRITE_SET_BYTES) {
        throw new SqlError(`transaction too large: it changes more than ${MAX_WRITE_SET_BYTES} bytes of rows on one shard; split it into smaller transactions`);
      }
    }
  }

  private checkUnique(txn: string, writes: Change[]): string | null {
    const constrained = writes.filter((w) => this.def(w.table).uniques.length > 0);
    if (constrained.length === 0) return null;
    const pending = this.uniquePending(txn, constrained);
    if (pending) return pending;
    try {
      this.rollback(() => applyChanges(this.b, (t) => this.def(t), constrained));
      return null;
    } catch (e) {
      return `unique: ${e instanceof Error ? e.message : String(e)}`;
    }
  }

  // ---- 書き込み ----

  private applyAndLog(txn: string, c: Ts, changes: Change[]): void {
    const logged = changes.map((ch) => {
      const before = selectRow(this.b, this.def(ch.table), ch.pk);
      return { ...ch, before };
    });
    applyChanges(this.b, (t) => this.def(t), logged);
    this.logChanges(txn, c, logged);
  }

  /** 本体へ適用済みの変更を変更ログと直近 write の索引へ記録する。 */
  private logChanges(txn: string, c: Ts, logged: Change[]): void {
    this.logInsert(c, txn, encode(logged));
    this.maxCommit = Math.max(this.maxCommit, c);
    for (const ch of logged) this.touch(ch.table, ch.pk, ch.sk, c);
    this.pruneRecent();
  }

  /** 索引が膨らんだら捨てて low-water を上げる。それより古い T の取引は保守的に abort する。 */
  private pruneRecent(): void {
    if (this.recent.size < 200_000) return;
    this.recentLowWater = this.hlc.value;
    this.recent.clear();
  }

  async commitLocal(req: Omit<PrepareReq, "anchor">): Promise<CommitRes> {
    await this.ensureSchema(req.schema);
    await this.ensureArrived(this.sksOf(req.spans, req.writes));
    // グループの到着を待っている間に DDL が適用されることがある。古い計画のまま書かない。
    this.requireSchema(req.schema);
    this.observe(req.T);
    this.assertOwned(req.spans, req.writes, req.T);
    try {
      this.assertWriteSetFits(req.writes);
    } catch (e) {
      this.releaseLocks(req.txn);
      throw e;
    }
    const reason = this.validate(req.txn, req.T, req.writes, req.spans);
    if (reason) {
      this.releaseLocks(req.txn); // 失敗した取引のロックを残すと、TTL まで全員が待つ
      return { ok: false, reason };
    }
    const c = this.issue();
    if (req.writes.length) this.b.tx(() => this.applyAndLog(req.txn, c, req.writes));
    this.releaseLocks(req.txn);
    this.count("writes", req.spans, req.writes);
    return { ok: true, c };
  }

  async prepare(req: PrepareReq): Promise<PrepareRes> {
    await this.ensureSchema(req.schema);
    await this.ensureArrived(this.sksOf(req.spans, req.writes));
    this.requireSchema(req.schema);
    return this.prepareSync(req);
  }

  private prepareSync(req: PrepareReq): PrepareRes {
    const dup = this.b.exec(`SELECT prepare_ts FROM __intents WHERE txn = ? LIMIT 1`, req.txn)[0];
    if (dup) return { ok: true, prepareTs: dup.prepare_ts as Ts };
    // phase 2 で初めて上限に当たると、確定した取引が適用できなくなる。intent を置く前に拒否する。
    try {
      this.assertWriteSetFits(req.writes);
    } catch (e) {
      this.releaseLocks(req.txn);
      return { ok: false, reason: (e as Error).message };
    }
    this.observe(req.T);
    try {
      this.assertOwned(req.spans, req.writes, req.T);
    } catch (e) {
      // 参加者が非オーナーなら取引は abort で、Worker が経路を更新して再実行する。
      this.releaseLocks(req.txn);
      return { ok: false, reason: e instanceof Error ? e.message : String(e) };
    }
    this.count("writes", req.spans, req.writes);
    const reason = this.validate(req.txn, req.T, req.writes, req.spans);
    if (reason) {
      this.releaseLocks(req.txn);
      return { ok: false, reason };
    }
    const prepareTs = this.issue();
    if (req.writes.length) {
      this.b.tx(() => {
        for (const w of req.writes) {
          this.b.exec(
            `INSERT INTO __intents(tbl, pk, sk, txn, anchor, prepare_ts, change) VALUES (?, ?, ?, ?, ?, ?, ?)`,
            w.table, w.pk, w.sk, req.txn, req.anchor, prepareTs, encode(w),
          );
        }
      });
    }
    this.releaseLocks(req.txn); // 以後は intent が同じ行を守る
    // anchor が決着を送り損ねても、参加者が自分で決着させる。
    this.deps.scheduleRedrive?.();
    return { ok: true, prepareTs };
  }

  async refresh(req: { txn: string; spans: Span[]; from: Ts; to: Ts }): Promise<{ ok: boolean; reason?: string }> {
    // 先に HLC を to まで進める。これ以後に置かれる intent は prepare_ts > to になる。
    if (!this.faults.refreshNoBump) this.observe(req.to);
    // DDL や変更ログの切り詰めより古い窓は、変更の有無を確かめられない。
    if (req.from < this.ddlFloor || req.from < this.logLowWater) return { ok: false, reason: "refresh: window too old" };
    try {
      // from より後に移動してきたグループは、親での変更を確かめられないので abort する。
      this.assertOwned(req.spans, [], req.from);
    } catch (e) {
      return { ok: false, reason: e instanceof Error ? e.message : String(e) };
    }
    for (const s of req.spans) {
      if (this.changedSince(s, Math.max(req.from, s.since ?? 0))) return { ok: false, reason: "refresh: span changed" };
      if (this.faults.ignoreIntentsInValidation) continue;
      const hit = this.overlapping([s], req.to).find((i) => i.txn !== req.txn);
      if (hit) return { ok: false, reason: `refresh: intent ${hit.txn}` };
    }
    return { ok: true };
  }

  async commit(req: CommitReq): Promise<CommitRes> {
    await this.ensureSchema(req.schema);
    const done = this.b.exec(`SELECT status, c FROM __txn WHERE txn = ?`, req.txn)[0];
    if (done) return done.status === "committed" ? { ok: true, c: done.c as Ts } : { ok: false, reason: "aborted" };
    // 決着の記録は保持時間の後に消す。消した tombstone の後に同じ取引の COMMIT が届いて確定すると、
    // 中止と判断して intent を無視した読み手と矛盾する (specs/m10_txn_record_gc.qnt の反例)。
    // 保持時間の半分より古い取引の COMMIT を受け付けなければ、消した後に確定することはない。
    if (this.deps.clock.now() - tsToPhysical(req.T) > (this.deps.txnRetainMs ?? TXN_RETAIN_MS) / 2) {
      return { ok: false, reason: "conflict: transaction older than the commit window" };
    }
    const me = req.participants.find((p) => p.shard === this.id);
    if (me) await this.ensureArrived(this.sksOf(me.spans, me.writes));

    let settle = () => {};
    const settled = new Promise<void>((r) => (settle = r));
    const flight: InFlight = { pushed: 0, decided: false, settled, settle };
    this.inflight.set(req.txn, flight);
    try {
      return await this.drive(req, flight);
    } finally {
      this.inflight.delete(req.txn);
      flight.settle();
    }
  }

  private async drive(req: CommitReq, flight: InFlight): Promise<CommitRes> {
    const self = req.participants.find((p) => p.shard === this.id);
    if (!self) throw new SqlError("anchor must be a participant");
    let others = req.participants.filter((p) => p.shard !== this.id);
    if (this.faults.skipReadOnlyPrepare) others = others.filter((p) => p.writes.length > 0);

    const acks = await Promise.all(
      others.map((p) =>
        this.deps.peer(p.shard).prepare({
          txn: req.txn, T: req.T, writes: p.writes, spans: p.spans, anchor: this.id, schema: req.schema,
        }),
      ),
    );
    const failed = acks.find((a) => !a.ok);
    if (failed && !failed.ok) return this.decideAbort(req, failed.reason);
    const stamps = acks.map((a) => (a as { prepareTs: Ts }).prepareTs);

    // ここから c の確定までは await を挟まない。
    // 参加者の応答を待っている間に、この anchor に DDL が適用されていれば、取引は古い表定義で計画されている。
    if (!this.faults.noSchemaRecheck && req.schema !== this.schema) {
      return this.decideAbort(req, `not owner: stale schema ${req.schema} < ${this.schema}`);
    }
    if (!this.faults.anchorNoAbsorb) this.observe(Math.max(0, ...stamps, flight.pushed));
    const mine = this.prepareSync({
      txn: req.txn, T: req.T, writes: self.writes, spans: self.spans, anchor: this.id, schema: req.schema,
    });
    if (!mine.ok) return this.decideAbort(req, mine.reason);
    const c = this.faults.anchorNoAbsorb
      ? Math.max(mine.prepareTs, ...stamps, flight.pushed + 1)
      : mine.prepareTs;
    flight.decided = true;

    const stale = others.flatMap((p, i) => {
      const spans = this.faults.predicateProtected
        ? p.spans.filter((s) => !p.writes.some((w) => w.table === s.table))
        : unprotectedSpans(p.spans, p.writes);
      return spans.length > 0 && stamps[i]! < c ? [{ p, spans, from: stamps[i]! }] : [];
    });
    const refreshed = await Promise.all(
      stale.map((s) => this.deps.peer(s.p.shard).refresh({ txn: req.txn, spans: s.spans, from: s.from, to: c })),
    );
    const bad = refreshed.find((r) => !r.ok);
    if (bad) return this.decideAbort(req, bad.reason ?? "refresh failed");

    this.b.exec(
      `INSERT INTO __txn(txn, status, c, participants, at) VALUES (?, 'committed', ?, ?, ?)`,
      req.txn, c, JSON.stringify(req.participants.map((p) => p.shard)), this.deps.clock.now(),
    );
    await this.b.sync(); // record の確定を待ってから phase 2 を送る。
    this.deps.scheduleRedrive?.();
    this.spawn(this.phase2(req.txn, c, req.participants));
    return { ok: true, c };
  }

  private decideAbort(req: CommitReq, reason: string): CommitRes {
    this.b.exec(`INSERT OR IGNORE INTO __txn(txn, status, done, at) VALUES (?, 'aborted', 1, ?)`, req.txn, this.deps.clock.now());
    for (const p of req.participants) {
      this.spawn(p.shard === this.id ? this.abort({ txn: req.txn }) : this.deps.peer(p.shard).abort({ txn: req.txn }));
    }
    return { ok: false, reason };
  }

  private async phase2(txn: string, c: Ts, participants: Pick<Participant, "shard">[]): Promise<void> {
    await this.finalize({ txn, c });
    await Promise.all(
      participants.filter((p) => p.shard !== this.id).map((p) => this.deps.peer(p.shard).finalize({ txn, c })),
    );
    this.b.exec(`UPDATE __txn SET done = 1 WHERE txn = ?`, txn);
  }

  private spawn(p: Promise<unknown>): void {
    const guarded = p.catch(() => {}); // 失敗は redrive が回収する。
    this.deps.background?.(guarded);
  }

  /** 移動済みグループの intent は親で適用しない。応答が飛行中だと、適用した分が子に届かず消えるからである。 */
  private localIntents(txn: string): Intent[] {
    const rows = this.b.exec(`SELECT * FROM __intents WHERE txn = ?`, txn) as unknown as Intent[];
    return this.faults.applyAfterMoved ? rows : rows.filter((r) => !this.moved.has(r.sk));
  }

  private forwards(txn: string): Map<string, string[]> {
    const out = new Map<string, string[]>();
    if (this.faults.applyAfterMoved) return out;
    for (const r of this.b.exec(`SELECT g, dest FROM __moved_txn WHERE txn = ?`, txn)) {
      out.set(r.dest as string, [...(out.get(r.dest as string) ?? []), r.g as string]);
    }
    return out;
  }

  async finalize(req: { txn: string; c: Ts; groups?: string[] }): Promise<void> {
    if (req.groups) await this.ensureArrived(req.groups);
    this.observe(req.c);
    const rows = this.localIntents(req.txn);
    if (rows.length) {
      this.b.tx(() => {
        this.applyAndLog(req.txn, req.c, rows.map((r) => decode<Change>(r.change)));
        for (const r of rows) this.b.exec(`DELETE FROM __intents WHERE tbl = ? AND pk = ?`, r.tbl, r.pk);
      });
    }
    this.releaseLocks(req.txn);
    for (const r of rows) this.wakeAll(this.lockKey(r.tbl, r.pk));
    for (const [dest, groups] of this.forwards(req.txn)) {
      await this.deps.peer(dest).finalize({ txn: req.txn, c: req.c, groups });
    }
  }

  async abort(req: { txn: string; groups?: string[] }): Promise<void> {
    if (req.groups) await this.ensureArrived(req.groups);
    this.releaseLocks(req.txn);
    for (const r of this.localIntents(req.txn)) {
      this.b.exec(`DELETE FROM __intents WHERE tbl = ? AND pk = ?`, r.tbl, r.pk);
      this.wakeAll(this.lockKey(r.tbl, r.pk));
    }
    for (const [dest, groups] of this.forwards(req.txn)) {
      await this.deps.peer(dest).abort({ txn: req.txn, groups });
    }
  }

  // ---- anchor への照会 ----

  private decided(txn: string): TxnStatus | null {
    const r = this.b.exec(`SELECT status, c FROM __txn WHERE txn = ?`, txn)[0];
    if (!r) return null;
    return r.status === "committed" ? { status: "committed", c: r.c as Ts } : { status: "aborted" };
  }

  async queryTxn(req: { txn: string; pushTo: Ts }): Promise<TxnStatus> {
    const known = this.decided(req.txn);
    if (known) return known;
    const flight = this.inflight.get(req.txn);
    // push は c の決定前だけ受理する。決定後に受理しても c は動かず、読み手が intent を誤って無視する。
    if (flight && (!flight.decided || this.faults.pushAfterDecide)) {
      flight.pushed = Math.max(flight.pushed, req.pushTo);
      return { status: "pushed" };
    }
    if (flight) {
      await flight.settled; // c の決定後は決着まで保留する。
      return this.decided(req.txn) ?? { status: "aborted" };
    }
    // 記録がなく in-flight でもない。presumed abort を tombstone で確定させる。
    this.b.exec(`INSERT OR IGNORE INTO __txn(txn, status, done, at) VALUES (?, 'aborted', 1, ?)`, req.txn, this.deps.clock.now());
    return this.decided(req.txn)!;
  }

  async status(req: { txn: string }): Promise<TxnStatus> {
    const flight = this.inflight.get(req.txn);
    if (flight) await flight.settled;
    return this.queryTxn({ txn: req.txn, pushTo: 0 });
  }

  // ---- 保守 ----

  /** alarm の本体。phase 2 の再駆動と、取り残された intent の掃除を行う。 */
  /**
   * 未完了の仕事が残っていれば true を返す。呼び出し側 (DO の alarm) は true なら次の alarm を予約する。
   * 参加者の intent は、anchor が再起動で決着を送り損ねると読み手が来るまで残る。残った intent は変更ログの GC を止めるので、
   * 読み手を待たずにここで決着させる。
   */
  /** 直近の redrive で失敗した処理の理由。運用の診断に使う。 */
  lastRedriveErrors: string[] = [];

  async redrive(): Promise<boolean> {
    let more = false;
    const errors: string[] = [];
    const attempt = async (fn: () => Promise<unknown>) => {
      try {
        await fn();
      } catch (e) {
        more = true;
        if (errors.length < 10) errors.push(String((e as Error)?.message ?? e).slice(0, 160));
      }
    };
    for (const r of this.b.exec(`SELECT txn, c, participants FROM __txn WHERE status = 'committed' AND done = 0`)) {
      const shards = JSON.parse(r.participants as string) as string[];
      await attempt(() => this.phase2(r.txn as string, r.c as Ts, shards.map((shard) => ({ shard }))));
    }
    for (const r of this.incoming) await attempt(() => this.drain({ start: r.start, end: r.end }));
    // 進行中の取引の intent には触れない。anchor がまだ決着を送っている最中かもしれないからである。
    const cutoff = physicalToTs(this.deps.clock.now() - ORPHAN_AGE_MS);
    const orphans = this.b.exec(`SELECT DISTINCT txn, anchor FROM __intents WHERE prepare_ts < ?`, cutoff) as unknown as Intent[];
    for (const o of orphans) {
      await attempt(async () => {
        const res = await this.ask(o.anchor, o.txn, 0);
        if (res.status === "committed") await this.finalize({ txn: o.txn, c: res.c });
        else if (res.status === "aborted") await this.abort({ txn: o.txn });
      });
    }
    const left = this.b.exec(`SELECT (SELECT count(*) FROM __intents) + (SELECT count(*) FROM __txn WHERE status = 'committed' AND done = 0) n`)[0]?.n as number;
    this.lastRedriveErrors = errors;
    return more || left > 0 || this.incoming.length > 0;
  }

  /** 分析パスへ渡す変更を読み出す。flushTs は未解決 intent の prepare_ts 未満に抑える。 */
  async flush(req: { upTo?: Ts }): Promise<FlushRes> {
    const minPrepare = this.b.exec(`SELECT min(prepare_ts) v FROM __intents`)[0]?.v as number | null;
    const now = this.issue();
    const limit = Math.min(req.upTo ?? now, minPrepare === null ? now : minPrepare - 1);
    const rows = this.logScan(`WHERE commit_ts > ? AND commit_ts <= ?`, [this.flushedTs, limit]);
    const entries = rows.map((r) => ({
      commitTs: r.commit_ts as Ts, txn: r.txn as string, changes: decode<Change[]>(r.blob as string),
    }));
    this.flushedTs = Math.max(this.flushedTs, limit);
    this.metaSet("flushed", this.flushedTs);
    return { flushTs: this.flushedTs, entries };
  }
}
