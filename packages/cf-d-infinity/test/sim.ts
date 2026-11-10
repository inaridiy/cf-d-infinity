import { DatabaseSync } from "node:sqlite";
import { Db, type Cluster } from "../src/client/db";
import { MetaCore } from "../src/meta";
import { ShardCore } from "../src/shard/core";
import type { Backend, Faults, Row, ShardApi, Value } from "../src/types";

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

/** node:sqlite の Backend。fence() 後の操作は失敗する (DO 基盤が旧 instance を止めるのと同じ)。 */
export class SqliteBackend implements Backend {
  fenced = false;
  depth = 0;
  constructor(readonly db = new DatabaseSync(":memory:")) {}
  exec(sql: string, ...params: Value[]): Row[] {
    if (this.fenced) throw new Error("fenced instance");
    checkDoLimits(sql, params);
    const st = this.db.prepare(sql);
    return st.columns().length > 0 ? (st.all(...params) as Row[]).map((r) => ({ ...r })) : (st.run(...params), []);
  }
  iterate(sql: string, ...params: Value[]): { columns: string[]; rows: Iterable<Value[]> } {
    if (this.fenced) throw new Error("fenced instance");
    checkDoLimits(sql, params);
    const st = this.db.prepare(sql);
    const columns = st.columns().map((c) => c.name);
    if (columns.length === 0) {
      st.run(...params);
      return { columns, rows: [] };
    }
    st.setReturnArrays(true);
    return { columns, rows: st.iterate(...params) as unknown as Iterable<Value[]> };
  }
  raw(sql: string, ...params: Value[]): { columns: string[]; values: Value[][] } {
    if (this.fenced) throw new Error("fenced instance");
    checkDoLimits(sql, params);
    const st = this.db.prepare(sql);
    const columns = st.columns().map((c) => c.name);
    if (columns.length === 0) {
      st.run(...params);
      return { columns, values: [] };
    }
    st.setReturnArrays(true);
    return { columns, values: st.all(...params) as unknown as Value[][] };
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
    await new Promise((r) => setTimeout(r, Math.random() * 2));
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
  jitter: (() => number) | null = null;
  /**
   * 応答の配送を止める。処理は終わっていて、結果だけが呼び出し側へ届かない状態を作る。
   * 本番の RPC の応答は output gate と網の遅延を経るので、この間に別の要求が同じシャードで処理される。
   * 既定では何もしない。
   */
  reply: (m: Rpc) => Promise<void> | void = () => {};
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
}

/** Worker と DO の間の RPC だけをシミュレートしたクラスタ。ShardCore は本物を動かす。 */
export class SimCluster implements Cluster {
  /** 起動時のシャード。増設後の一覧は catalog の routing を見る。 */
  shardIds: string[];
  net = new SimNet();
  time = 1_000_000;
  /** 全シャードの時計をまとめて進める量 (ms)。時計の出所が実時間でも効く。 */
  ahead = 0;
  cores = new Map<string, ShardCore>();
  backends = new Map<string, SqliteBackend>();
  meta: MetaCore;
  background = new Set<Promise<unknown>>();
  /** alarm を予約したシャード。DO の alarm の代わりに fireAlarms で発火させる。 */
  alarms = new Set<string>();

  constructor(private o: SimOptions = {}) {
    this.shardIds = Array.from({ length: o.shards ?? 4 }, (_, i) => `s${i}`);
    this.meta = new MetaCore(new SqliteBackend(), this.shardIds);
    for (const id of this.shardIds) this.core(id);
  }

  /** DO と同じく、触った時に存在し始める。 */
  private core(id: string): ShardCore {
    if (!this.cores.has(id)) {
      this.backends.set(id, new SqliteBackend());
      this.boot(id);
    }
    return this.cores.get(id)!;
  }

  private boot(id: string): void {
    this.cores.set(id, new ShardCore({
      id,
      backend: this.backends.get(id)!,
      clock: { now: () => (this.o.now?.() ?? this.time) + this.ahead + (this.o.skewMs?.(id) ?? 0) },
      peer: (to) => this.stub(id, to),
      meta: { ddlSince: (v) => this.meta.ddlSince(v), revokeDdl: (v, reason) => this.meta.revokeDdl(v, reason) },
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
    this.backends.set(id, fresh);
    this.boot(id);
  }

  private stub(from: string, to: string): ShardApi {
    return new Proxy({} as ShardApi, {
      get: (_t, method: keyof ShardApi) => async (req: unknown) => {
        const m: Rpc = { from, to, method, req };
        this.net.log.push(m);
        await this.net.gate(m);
        if (this.net.drop(m)) throw new Error(`rpc dropped: ${String(method)}`);
        const delay = this.net.jitter?.() ?? 0;
        await new Promise((r) => (delay > 0 ? setTimeout(r, delay) : setImmediate(r)));
        // JSON を通して、DO の RPC と同じく参照を共有しないようにする。
        const core = this.core(to);
        const out = await (core[method] as (r: unknown) => Promise<unknown>).call(core, structuredClone(req));
        const hold = this.net.reply(m);
        if (hold) await hold;
        return out === undefined ? undefined : structuredClone(out);
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
  switchRange(move: { start: number; end: number; to: string }) {
    return this.meta.switchRange(move);
  }
  publishIndex(table: string, name: string, basedOn?: number) {
    return this.meta.publishIndex(table, name, basedOn);
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
