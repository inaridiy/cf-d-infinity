// Service Binding の向こうにある DinfDatabase を、D1 と同じ形で使うための薄いクライアント。
// アプリの Worker に入るのはこのファイルだけで、プランナーやシャードのコードは含まない。
// 文は手元で組み立て、実行のときだけ RPC を呼ぶ。D1 と同じく prepare と bind は同期で返る。
import type { Row, Value } from "./types";

/** RPC が返す 1 文の結果。 */
export interface RemoteResult {
  columns: string[];
  rows: Row[];
  values: Value[][];
  changes: number;
  lastInsertRowid: number | null;
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
  query(sql: string, params?: unknown[], token?: number): PromiseLike<RemoteResult>;
  batch(statements: RemoteStatement[], token?: number): PromiseLike<RemoteResult[]>;
  begin(mode?: TransactionMode, token?: number): PromiseLike<RemoteTransaction>;
}

export interface D1Meta {
  changes: number;
  rows_read: number;
  rows_written: number;
  duration: number;
  last_row_id: number;
  changed_db: boolean;
  size_after: number;
}
export interface D1Result<T = Row> {
  success: true;
  results: T[];
  meta: D1Meta;
}

const d1 = <T>(r: RemoteResult): D1Result<T> => ({
  success: true,
  results: r.rows as T[],
  meta: {
    changes: r.changes, rows_read: r.rows.length, rows_written: r.changes, duration: 0,
    last_row_id: r.lastInsertRowid ?? 0, changed_db: r.changes > 0, size_after: 0,
  },
});

export class Statement {
  constructor(private conn: Connection, readonly sql: string, readonly params: unknown[] = []) {}

  bind(...values: unknown[]): Statement {
    return new Statement(this.conn, this.sql, values);
  }
  async all<T = Row>(): Promise<D1Result<T>> {
    return d1<T>(await this.conn.run(this.sql, this.params));
  }
  run<T = Row>(): Promise<D1Result<T>> {
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

export class Transaction {
  private open = true;
  constructor(private conn: Connection, private tx: RemoteTransaction) {}

  async execute(sql: string, params: unknown[] = []): Promise<RemoteResult> {
    return this.conn.seen(await this.tx.execute(sql, params));
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
export class Connection {
  private token = 0;
  constructor(private binding: DatabaseBinding, token = 0) {
    this.token = token;
  }

  /** 結果の時刻を覚える。 */
  seen<T extends { token: number }>(r: T): T {
    if (r.token > this.token) this.token = r.token;
    return r;
  }
  async run(sql: string, params: unknown[]): Promise<RemoteResult> {
    return this.seen(await this.binding.query(sql, params, this.token));
  }

  prepare(sql: string): Statement {
    return new Statement(this, sql);
  }
  /** D1 と同じく全文を 1 取引で実行する。シャードを跨いでも原子的である。 */
  async batch<T = Row>(statements: Statement[]): Promise<D1Result<T>[]> {
    const out = await this.binding.batch(statements.map((s) => ({ sql: s.sql, params: s.params })), this.token);
    return out.map((r) => d1<T>(this.seen(r)));
  }
  /**
   * 対話的な取引を始める。"write" は BEGIN IMMEDIATE で、書く行にロックを取る。
   * "deferred" は楽観的で、読んだ行が変わっていると commit が SQLITE_BUSY で失敗する。
   */
  async begin(mode: TransactionMode = "write"): Promise<Transaction> {
    return new Transaction(this, await this.binding.begin(mode, this.token));
  }
  /** fn を 1 取引として実行する。fn が投げたら rollback する。リトライはしない。 */
  async transaction<T>(fn: (tx: Transaction) => Promise<T>, mode: TransactionMode = "write"): Promise<T> {
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
  withSession(bookmark?: string): Connection & { getBookmark(): string } {
    // D1 の bookmark など、この DB のものでない値は時刻として読めない。その場合は制約なしで始める。
    const parsed = bookmark && /^\d+$/.test(bookmark) ? Number(bookmark) : 0;
    const known = Number.isSafeInteger(parsed) ? parsed : 0;
    const session = new Connection(this.binding, Math.max(this.token, known)) as Connection & { getBookmark(): string };
    session.getBookmark = () => String(session.token);
    return session;
  }
}

/** `env.DINF_DB` (DinfDatabase への Service Binding) から接続を作る。 */
export function connect(binding: unknown): Connection {
  return new Connection(binding as DatabaseBinding);
}
