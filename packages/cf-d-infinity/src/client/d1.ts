import type { Row, Value } from "../types";
import type { Db, QueryResult, Txn } from "./db";

interface Meta {
  changes: number;
  rows_read: number;
  rows_written: number;
  duration: number;
  last_row_id: number;
  changed_db: boolean;
  size_after: number;
}
export interface D1LikeResult<T = Row> {
  success: true;
  results: T[];
  meta: Meta;
}

const meta = (r: QueryResult): Meta => ({
  changes: r.changes, rows_read: r.rows.length, rows_written: r.changes, duration: 0,
  last_row_id: r.lastInsertRowid ?? 0, changed_db: r.changes > 0, size_after: 0,
});

const toValue = (v: unknown): Value =>
  v === undefined || v === null ? null : typeof v === "boolean" ? Number(v) : (v as Value);

export class Statement {
  constructor(private db: Db, readonly sql: string, readonly params: Value[] = []) {}

  bind(...values: unknown[]): Statement {
    return new Statement(this.db, this.sql, values.map(toValue));
  }
  async all<T = Row>(): Promise<D1LikeResult<T>> {
    const r = await this.db.query(this.sql, this.params);
    return { success: true, results: r.rows as T[], meta: meta(r) };
  }
  async run<T = Row>(): Promise<D1LikeResult<T>> {
    return this.all<T>();
  }
  async first<T = Row>(column?: string): Promise<T | null> {
    const row = (await this.db.query(this.sql, this.params)).rows[0];
    if (!row) return null;
    return (column === undefined ? row : row[column]) as T;
  }
  async raw<T = Value[]>(opts?: { columnNames?: boolean }): Promise<T[]> {
    const r = await this.db.query(this.sql, this.params);
    return opts?.columnNames ? [r.columns as T, ...(r.values as T[])] : (r.values as T[]);
  }
  /** batch の中で同じ文を取引の一部として実行する。 */
  async inTxn(tx: Txn): Promise<QueryResult> {
    return tx.query(this.sql, this.params);
  }
}

/** D1Database と同じ形の入口。Drizzle の D1 ドライバなどがそのまま使える。 */
export class D1Compatible {
  constructor(private db: Db) {}

  prepare(sql: string): Statement {
    return new Statement(this.db, sql);
  }
  /** D1 と同じく全文を 1 取引で実行する。ここではシャードを跨いでも原子的である。 */
  async batch<T = Row>(statements: Statement[]): Promise<D1LikeResult<T>[]> {
    return this.db.transaction(async (tx) => {
      const out: D1LikeResult<T>[] = [];
      for (const s of statements) {
        const r = await s.inTxn(tx);
        out.push({ success: true, results: r.rows as T[], meta: meta(r) });
      }
      return out;
    });
  }
  /** Sessions API。bookmark は HLC トークンである。 */
  withSession(bookmark?: string): D1Compatible & { getBookmark(): string } {
    if (bookmark && bookmark !== "first-primary" && bookmark !== "first-unconstrained") {
      this.db.observe(Number(bookmark));
    }
    const session = this as unknown as D1Compatible & { getBookmark(): string };
    session.getBookmark = () => String(this.db.token);
    return session;
  }
}
