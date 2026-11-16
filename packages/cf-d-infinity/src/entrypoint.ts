// Service Binding の入口。binding を持つ Worker だけが呼べるので、トークンは要らない。
import { RpcTarget, WorkerEntrypoint } from "cloudflare:workers";
import type { IntMode, RemoteResult, RemoteStatement, TransactionMode } from "./binding";
import type { Db, QueryResult } from "./client/db";
import { toValue } from "./client/d1";
import { intModeOf, rowidOut, rowsOut, valuesOut } from "./client/results";
import { SqlError, type Value } from "./types";
import { decodeElem } from "./value";
import { clusterStatus, dbFor, exportRows, handle, importRows, schemaSql, slowQueries, type Env, type ExportCursor, type SlowQuery } from "./worker";

/** 引数を値にする (src/client/d1.ts の toValue)。値でない引数は、文を実行する前に断る。 */
const values = (params: unknown = []): Value[] => {
  if (!Array.isArray(params)) throw new SqlError("params must be an array");
  return params.map((v, i) => toValue(v, i));
};
/**
 * 結果は D1 と同じ形で返す。INTEGER の形は、呼び出し元が選んだ intMode である (src/client/results.ts。既定は JS の数で、JS の数で
 * 正確に表せない INTEGER は誤りにする)。structured clone は bigint を運ぶので、"bigint" の結果もそのまま RPC で返る。
 */
const pack = (r: QueryResult, db: Db, mode: IntMode): RemoteResult => ({
  columns: r.columns, rows: rowsOut(r.columns, r.values, mode), values: valuesOut(r.values, mode), changes: r.changes,
  lastInsertRowid: rowidOut(r.lastInsertRowid, mode), token: db.token,
});

/**
 * 対話的な取引。状態はこの Worker のメモリにある。
 * 呼び出し元が commit も rollback もせずに終わると、変更は捨てられ、行ロックは TTL (5 秒) で消える。
 * workerd は放置された stub の dispose をすぐには呼ばないので、ここでは dispose に頼らない。
 */
class RemoteTx extends RpcTarget {
  constructor(private db: Db, private mode: IntMode) {
    super();
  }
  async execute(sql: string, params?: unknown[]): Promise<RemoteResult> {
    return pack(await this.db.query(sql, values(params)), this.db, this.mode);
  }
  async commit(): Promise<{ token: number }> {
    await this.db.query("COMMIT");
    return { token: this.db.token };
  }
  async rollback(): Promise<void> {
    if (this.db.inTransaction) await this.db.query("ROLLBACK");
  }
}

/**
 * アプリの Worker が Service Binding で呼ぶ入口。
 * wrangler.jsonc の `services` に `{ "binding": "DINF_DB", "service": "<Worker 名>", "entrypoint": "DinfDatabase" }` を書き、
 * アプリからは `connect(env.DINF_DB)` で使う。
 */
export class DinfDatabase extends WorkerEntrypoint<Env> {
  private background = (p: Promise<unknown>) => this.ctx.waitUntil(p);
  /** intMode は結果の INTEGER の形である (src/binding.ts の IntMode)。知らない値は、文を実行する前に断る。 */
  async query(sql: string, params?: unknown[], token = 0, intMode?: IntMode): Promise<RemoteResult> {
    const mode = intModeOf(intMode);
    const db = await dbFor(this.env, token, this.background);
    return pack(await db.query(sql, values(params)), db, mode);
  }
  /**
   * 引数を要素 (src/value.ts。`i5`、`r5.0`、`tabc`、`b00FF`、null) で受け取る query。CLI の使い捨ての Worker が使う (bin/cli.js)。
   * JS の数では REAL の 5.0 と INTEGER の 5 を見分けられず、query は D1 の規則で安全な整数の数を INTEGER にする。要素は型を
   * 書くので、REAL は REAL のまま束縛される。要素でない引数と、64 ビットに収まらない INTEGER は、文を実行する前に断る。
   */
  async queryElements(sql: string, params: unknown[] = [], token = 0, intMode?: IntMode): Promise<RemoteResult> {
    const mode = intModeOf(intMode);
    if (!Array.isArray(params)) throw new SqlError("params must be an array");
    const vals = params.map((e, i): Value => {
      let v: Value;
      try {
        if (e !== null && typeof e !== "string") throw new Error();
        v = decodeElem(e);
      } catch {
        throw new SqlError(`parameter ${i + 1} is not an element (i<digits>, r<real>, t<text>, b<hex> or null)`);
      }
      return typeof v === "bigint" ? toValue(v, i) : v;
    });
    const db = await dbFor(this.env, token, this.background);
    return pack(await db.query(sql, vals), db, mode);
  }
  /** 全文を 1 取引で実行する。競合は内部でやり直す。表定義を変える文を含むと、その位置で区切る (Db.batch)。 */
  async batch(statements: RemoteStatement[], token = 0, intMode?: IntMode): Promise<RemoteResult[]> {
    const mode = intModeOf(intMode);
    const db = await dbFor(this.env, token, this.background);
    const out = await db.batch(statements.map((s) => ({ sql: s.sql, params: values(s.params) })));
    return out.map((r) => pack(r, db, mode));
  }
  async begin(mode: TransactionMode = "write", token = 0, intMode?: IntMode): Promise<RemoteTx> {
    const ints = intModeOf(intMode);
    const db = await dbFor(this.env, token, this.background);
    await db.query(mode === "write" ? "BEGIN IMMEDIATE" : "BEGIN");
    return new RemoteTx(db, ints);
  }
  /** 遅い文の記録を新しい順に返す。下限は DINF_SLOW_QUERY_MS で決まる。 */
  slowQueries(limit = 50): Promise<SlowQuery[]> {
    return slowQueries(this.env, limit);
  }
  /** シャード、範囲表、各シャードの健全性と問題点、Autoscaler の履歴を返す。 */
  status() {
    return clusterStatus(this.env);
  }
  /** 利用者が実行した DDL を、実行した順に返す。 */
  async schemaSql(): Promise<string[]> {
    return schemaSql(this.env);
  }
  /** 利用者の表の名前。内部の表 (グローバル index の実体) は含まない。 */
  async tables(): Promise<string[]> {
    const db = await dbFor(this.env, 0);
    return Object.keys((await db.catalog()).tables).filter((t) => !t.startsWith("__"));
  }
  /**
   * 表の行を少しずつ返す。論理エクスポートに使う。cursor が null になったら終わりである。
   * 時点はそろえないので、書き込みを止めていなければ、取引の途中の状態が混じり得る。
   * 行は要素のタプルで返し、頁は形式の版を運ぶ (src/transfer.ts の exportPage)。JSON をそのまま通せる。
   */
  async exportRows(table: string, cursor: ExportCursor | null, limit = 1000) {
    return exportRows(this.env, table, cursor, limit);
  }
  /** export が書き出した行を入れる。行は要素のタプルで、format は書き出しの形式の版である (src/transfer.ts の importRows)。 */
  async importRows(table: string, columns: string[], rows: unknown[][], format?: number): Promise<number> {
    return importRows(await dbFor(this.env, 0, this.background), table, columns, rows, format);
  }
  /** `env.DB.fetch()` は HTTP の入口 (Hrana、/sql、/admin) と同じで、トークンを検査する。 */
  override fetch(request: Request): Promise<Response> {
    return handle(request, this.env, this.ctx);
  }
}
