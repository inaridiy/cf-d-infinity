import { SqlError, type Row, type Value } from "../types";
import type { Db, QueryResult } from "./db";
import { intModeOf, rowidOut, rowsOut, valuesOut, type IntMode } from "./results";

interface Meta {
  changes: number;
  rows_read: number;
  rows_written: number;
  duration: number;
  /**
   * intMode の形の INTEGER。行を入れなかった文は 0 (D1 と同じ)。"number" で JS の数にできない rowid も、丸めずに 0 にする
   * (返す rowid がない。Service Binding と同じ)。
   */
  last_row_id: number | bigint | string;
  changed_db: boolean;
  size_after: number;
}
export interface D1LikeResult<T = Row> {
  success: true;
  results: T[];
  meta: Meta;
}

export interface D1Options {
  /** 結果の INTEGER の形 (src/client/results.ts)。既定は "number"。 */
  intMode?: IntMode;
}

const meta = (r: QueryResult, mode: IntMode): Meta => ({
  changes: r.changes, rows_read: r.values.length, rows_written: r.changes, duration: 0,
  last_row_id: rowidOut(r.lastInsertRowid, mode) ?? (mode === "bigint" ? 0n : mode === "string" ? "0" : 0), changed_db: r.changes > 0, size_after: 0,
});

const INT64_MIN = -(2n ** 63n);
const INT64_MAX = 2n ** 63n - 1n;

/** 値でない引数の種類。誤りの文面に書く。 */
export const kindOf = (v: unknown): string => (Array.isArray(v) ? "an array" : typeof v === "object" ? "an object" : `a ${typeof v}`);

/**
 * 引数の値 (docs/design-values.md の「D1 互換の API、Service Binding、HTTP の JSON」)。D1 互換の API と Service Binding が使い、
 * HTTP の本文の値も最後にここを通る (src/entry.ts の jsonParams)。型と 64 ビットの範囲を、文を実行する前のここで閉じる
 * (Hrana の fromH と同じ)。前は最後の枝が素通しで、配列がキー文字列と要素の符号に BLOB として入り、object は符号の中の TypeError
 * になり、64 ビットの外の bigint は束縛のときに RangeError で落ちた (2026-11-16、計画書の未解決の問題 47)。
 *   - undefined と null は NULL。真偽値は INTEGER の 1 と 0。文字列は TEXT。
 *   - JS の数は、安全な整数なら INTEGER、ほかは REAL (持ち主の判断の 2。渡された double をそのまま入れる)。
 *   - bigint は INTEGER。64 ビットに収まらなければ断る。
 *   - Uint8Array、ArrayBuffer、型つき配列と DataView は、そのバイトの BLOB (D1 と同じ)。型つき配列は Uint8Array にして、要素では
 *     なくバイトを運ぶ (前は、workerd で Uint16Array が要素ごとに 1 バイトへ切られ、キー文字列は要素から作られた)。
 *   - ほか (配列、object、symbol、関数) は、利用者の誤り (SqlError) として断る。
 * i は引数の位置 (0 から)。誤りの文面には、SQLite と同じく 1 から数えた番号で書く。
 */
export function toValue(v: unknown, i = 0): Value {
  switch (typeof v) {
    case "undefined": return null;
    case "boolean": return v ? 1n : 0n;
    case "number": return Number.isSafeInteger(v) ? BigInt(v) : v;
    case "string": return v;
    case "bigint":
      if (v < INT64_MIN || v > INT64_MAX) throw new SqlError(`parameter ${i + 1}: the integer ${v} does not fit in 64 bits`);
      return v;
  }
  if (v === null) return null;
  if (v instanceof Uint8Array) return v;
  if (v instanceof ArrayBuffer) return new Uint8Array(v.slice(0));
  if (ArrayBuffer.isView(v)) return new Uint8Array(v.buffer.slice(v.byteOffset, v.byteOffset + v.byteLength));
  throw new SqlError(`parameter ${i + 1} is ${kindOf(v)}; a parameter must be null, a boolean, a number, a bigint, a string, or bytes (a Uint8Array, an ArrayBuffer or a typed array)`);
}

export class Statement {
  constructor(private db: Db, readonly sql: string, readonly params: Value[] = [], private mode: IntMode = "number") {}

  /** 値でない引数は、D1 と同じく、ここで (文を実行する前に、同期で) 断る。 */
  bind(...values: unknown[]): Statement {
    return new Statement(this.db, this.sql, values.map((v, i) => toValue(v, i)), this.mode);
  }
  async all<T = Row>(): Promise<D1LikeResult<T>> {
    const r = await this.db.query(this.sql, this.params);
    return { success: true, results: rowsOut(r.columns, r.values, this.mode) as T[], meta: meta(r, this.mode) };
  }
  async run<T = Row>(): Promise<D1LikeResult<T>> {
    return this.all<T>();
  }
  async first<T = Row>(column?: string): Promise<T | null> {
    // 全部の行を変える。Service Binding (src/entrypoint.ts) と同じく、誤りにするかどうかは結果の全体で決まる。
    const row = (await this.all<Row>()).results[0];
    if (!row) return null;
    return (column === undefined ? row : row[column]) as T;
  }
  async raw<T = Value[]>(opts?: { columnNames?: boolean }): Promise<T[]> {
    const r = await this.db.query(this.sql, this.params);
    const values = valuesOut(r.values, this.mode);
    return opts?.columnNames ? [r.columns as T, ...(values as T[])] : (values as T[]);
  }
}

/** D1Database と同じ形の入口。Drizzle の D1 ドライバなどがそのまま使える。 */
export class D1Compatible {
  private mode: IntMode;
  constructor(private db: Db, opts: D1Options = {}) {
    this.mode = intModeOf(opts.intMode);
  }

  prepare(sql: string): Statement {
    return new Statement(this.db, sql, [], this.mode);
  }
  /**
   * D1 と同じく全文を 1 取引で実行する。ここではシャードを跨いでも原子的である。
   * 表定義を変える文を含む batch だけは、その位置で区切り、区切りごとに 1 取引で実行する (Db.batch)。
   */
  async batch<T = Row>(statements: Statement[]): Promise<D1LikeResult<T>[]> {
    const out = await this.db.batch(statements.map((s) => ({ sql: s.sql, params: s.params })));
    return out.map((r) => ({ success: true, results: rowsOut(r.columns, r.values, this.mode) as T[], meta: meta(r, this.mode) }));
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
