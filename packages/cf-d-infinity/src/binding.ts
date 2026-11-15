// Service Binding の向こうにある DinfDatabase を、D1 と同じ形で使うための薄いクライアント。
// アプリの Worker に入るのはこのファイルだけで、プランナーやシャードのコードは含まない。
// 文は手元で組み立て、実行のときだけ RPC を呼ぶ。D1 と同じく prepare と bind は同期で返る。
import type { Row, Value } from "./types";

/**
 * 結果の INTEGER の形 (@libsql/client と同じ)。"number" (既定) は JS の数で、JS の数で正確に表せない INTEGER (絶対値が 2^53 - 1 を
 * 超えるもの) を含む結果は誤りにする。"bigint" は INTEGER をすべて bigint で、"string" はすべて 10 進の文字列で返す。
 * REAL、TEXT、BLOB、NULL は、どれでも同じである。変換は DinfDatabase の側で行う (src/client/results.ts)。
 */
export type IntMode = "number" | "bigint" | "string";
/** intMode が返す INTEGER の JS の型。 */
export type IntOf<M extends IntMode> = M extends "bigint" ? bigint : M extends "string" ? string : number;

export interface ConnectOptions<M extends IntMode = "number"> {
  intMode?: M;
}

/** RPC が返す 1 文の結果。 */
export interface RemoteResult<M extends IntMode = IntMode> {
  columns: string[];
  rows: Row[];
  values: Value[][];
  changes: number;
  /** 行を入れなかった文は null。"number" で JS の数にできない rowid も null である。 */
  lastInsertRowid: IntOf<M> | null;
  /** この接続が見た最新の時刻 (HLC)。次の呼び出しへ渡すと、自分の書き込みが必ず見える。 */
  token: number;
}
export interface RemoteStatement {
  sql: string;
  params: unknown[];
}
export type TransactionMode = "write" | "deferred";

/** 対話的な取引。Database の側に状態があり、binding の呼び出し元は手続きだけを送る。 */
export interface RemoteTransaction {
  execute(sql: string, params?: unknown[]): PromiseLike<RemoteResult>;
  commit(): PromiseLike<{ token: number }>;
  rollback(): PromiseLike<void>;
}

/** `DinfDatabase` の入口が RPC で公開する形。`env.DINF_DB` をそのまま渡せる。 */
export interface DatabaseBinding {
  query(sql: string, params?: unknown[], token?: number, intMode?: IntMode): PromiseLike<RemoteResult>;
  batch(statements: RemoteStatement[], token?: number, intMode?: IntMode): PromiseLike<RemoteResult[]>;
  begin(mode?: TransactionMode, token?: number, intMode?: IntMode): PromiseLike<RemoteTransaction>;
}

export interface D1Meta<M extends IntMode = "number"> {
  changes: number;
  rows_read: number;
  rows_written: number;
  duration: number;
  /** 行を入れなかった文は 0 (D1 と同じ)。"number" で JS の数にできない rowid も、丸めずに 0 にする (返す rowid がない)。 */
  last_row_id: IntOf<M>;
  changed_db: boolean;
  size_after: number;
}
export interface D1Result<T = Row, M extends IntMode = "number"> {
  success: true;
  results: T[];
  meta: D1Meta<M>;
}

const d1 = <T, M extends IntMode>(r: RemoteResult, mode: M): D1Result<T, M> => ({
  success: true,
  results: r.rows as T[],
  meta: {
    changes: r.changes, rows_read: r.rows.length, rows_written: r.changes, duration: 0,
    last_row_id: (r.lastInsertRowid ?? (mode === "bigint" ? 0n : mode === "string" ? "0" : 0)) as IntOf<M>,
    changed_db: r.changes > 0, size_after: 0,
  },
});

export class Statement<M extends IntMode = "number"> {
  constructor(private conn: Connection<M>, readonly sql: string, readonly params: unknown[] = []) {}

  bind(...values: unknown[]): Statement<M> {
    return new Statement(this.conn, this.sql, values);
  }
  async all<T = Row>(): Promise<D1Result<T, M>> {
    return d1<T, M>(await this.conn.run(this.sql, this.params), this.conn.intMode);
  }
  run<T = Row>(): Promise<D1Result<T, M>> {
    return this.all<T>();
  }
  async first<T = Row>(column?: string): Promise<T | null> {
    const row = (await this.conn.run(this.sql, this.params)).rows[0];
    if (!row) return null;
    return (column === undefined ? row : row[column]) as T;
  }
  async raw<T = Value[]>(opts?: { columnNames?: boolean }): Promise<T[]> {
    const r = await this.conn.run(this.sql, this.params);
    return (opts?.columnNames ? [r.columns, ...r.values] : r.values) as T[];
  }
}

export class Transaction<M extends IntMode = "number"> {
  private open = true;
  constructor(private conn: Connection<M>, private tx: RemoteTransaction) {}

  async execute(sql: string, params: unknown[] = []): Promise<RemoteResult<M>> {
    return this.conn.seen(await this.tx.execute(sql, params)) as RemoteResult<M>;
  }
  async commit(): Promise<void> {
    this.open = false;
    this.conn.seen(await this.tx.commit());
  }
  /** 終わった取引に対して呼んでも何もしない。catch の中で無条件に呼べる。 */
  async rollback(): Promise<void> {
    if (!this.open) return;
    this.open = false;
    await this.tx.rollback();
  }
  /** `await using tx = await db.begin()` と書くと、commit せずにスコープを抜けたときに rollback する。 */
  [Symbol.asyncDispose](): Promise<void> {
    return this.rollback();
  }
}

/** D1Database と同じ形の接続。Drizzle の D1 ドライバにそのまま渡せる。 */
export class Connection<M extends IntMode = "number"> {
  private token = 0;
  /** 結果の INTEGER の形。 */
  readonly intMode: M;
  constructor(private binding: DatabaseBinding, token = 0, intMode: M = "number" as M) {
    if (intMode !== "number" && intMode !== "bigint" && intMode !== "string") throw new TypeError(`intMode must be "number", "bigint" or "string"`);
    this.token = token;
    this.intMode = intMode;
  }

  /** 結果の時刻を覚える。 */
  seen<T extends { token: number }>(r: T): T {
    if (r.token > this.token) this.token = r.token;
    return r;
  }
  async run(sql: string, params: unknown[]): Promise<RemoteResult<M>> {
    return this.seen(await this.binding.query(sql, params, this.token, this.intMode)) as RemoteResult<M>;
  }

  prepare(sql: string): Statement<M> {
    return new Statement(this, sql);
  }
  /** D1 と同じく全文を 1 取引で実行する。シャードを跨いでも原子的である。 */
  async batch<T = Row>(statements: Statement<M>[]): Promise<D1Result<T, M>[]> {
    const out = await this.binding.batch(statements.map((s) => ({ sql: s.sql, params: s.params })), this.token, this.intMode);
    return out.map((r) => d1<T, M>(this.seen(r), this.intMode));
  }
  /**
   * 対話的な取引を始める。"write" は BEGIN IMMEDIATE で、書く行にロックを取る。
   * "deferred" は楽観的で、読んだ行が変わっていると commit が SQLITE_BUSY で失敗する。
   */
  async begin(mode: TransactionMode = "write"): Promise<Transaction<M>> {
    return new Transaction(this, await this.binding.begin(mode, this.token, this.intMode));
  }
  /** fn を 1 取引として実行する。fn が投げたら rollback する。リトライはしない。 */
  async transaction<T>(fn: (tx: Transaction<M>) => Promise<T>, mode: TransactionMode = "write"): Promise<T> {
    const tx = await this.begin(mode);
    try {
      const out = await fn(tx);
      await tx.commit();
      return out;
    } catch (e) {
      await tx.rollback().catch(() => undefined);
      throw e;
    }
  }
  /** D1 の Sessions API。bookmark は HLC の時刻である。 */
  withSession(bookmark?: string): Connection<M> & { getBookmark(): string } {
    // D1 の bookmark など、この DB のものでない値は時刻として読めない。その場合は制約なしで始める。
    const parsed = bookmark && /^\d+$/.test(bookmark) ? Number(bookmark) : 0;
    const known = Number.isSafeInteger(parsed) ? parsed : 0;
    const session = new Connection(this.binding, Math.max(this.token, known), this.intMode) as Connection<M> & { getBookmark(): string };
    session.getBookmark = () => String(session.token);
    return session;
  }
}

/**
 * Drizzle の移行が記録に使う表を作る文。Drizzle の migrate() より前に 1 度実行する。
 *
 * Drizzle は、この表がなければ `id SERIAL PRIMARY KEY` で作り、記録の INSERT で id を省く。SERIAL は INTEGER ではないので、
 * SQLite では id に NULL が入る。この DB は主キーに NULL のある行を断る (行を主キーの値で名指しするため)。
 * ここで作る表は id が INTEGER PRIMARY KEY なので、番号が自動で振られる。Drizzle は id の値を使わない。
 * 表がもうあれば何もしない。
 */
export function drizzleMigrationsTable(name = "__drizzle_migrations"): string {
  return `CREATE TABLE IF NOT EXISTS "${name.replaceAll('"', '""')}" (id INTEGER PRIMARY KEY, hash text NOT NULL, created_at numeric)`;
}

/**
 * `env.DINF_DB` (DinfDatabase への Service Binding) から接続を作る。`{ intMode: "bigint" }` か `{ intMode: "string" }` を渡すと、
 * 結果の INTEGER を bigint か 10 進の文字列で返す。既定は JS の数で、JS の数で正確に表せない INTEGER を含む結果は誤りになる。
 */
export function connect<M extends IntMode = "number">(binding: unknown, opts: ConnectOptions<M> = {}): Connection<M> {
  return new Connection(binding as DatabaseBinding, 0, opts.intMode ?? ("number" as M));
}
