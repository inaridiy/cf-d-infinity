// Service Binding の入口。binding を持つ Worker だけが呼べるので、トークンは要らない。
import { RpcTarget, WorkerEntrypoint } from "cloudflare:workers";
import type { RemoteResult, RemoteStatement, TransactionMode } from "./binding";
import type { Db, QueryResult } from "./client/db";
import type { Value } from "./types";
import { clusterStatus, dbFor, exportRows, handle, importRows, schemaSql, slowQueries, type Env, type ExportCursor, type SlowQuery } from "./worker";

const toValue = (v: unknown): Value =>
  v === undefined || v === null ? null : typeof v === "boolean" ? Number(v) : (v as Value);
const values = (params: unknown[] = []): Value[] => params.map(toValue);
const pack = (r: QueryResult, db: Db): RemoteResult => ({
  columns: r.columns, rows: r.rows, values: r.values, changes: r.changes, lastInsertRowid: r.lastInsertRowid, token: db.token,
});

/**
 * 対話的な取引。状態はこの Worker のメモリにある。
 * 呼び出し元が commit も rollback もせずに終わると、変更は捨てられ、行ロックは TTL (5 秒) で消える。
 * workerd は放置された stub の dispose をすぐには呼ばないので、ここでは dispose に頼らない。
 */
class RemoteTx extends RpcTarget {
  constructor(private db: Db) {
    super();
  }
  async execute(sql: string, params?: unknown[]): Promise<RemoteResult> {
    return pack(await this.db.query(sql, values(params)), this.db);
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
  async query(sql: string, params?: unknown[], token = 0): Promise<RemoteResult> {
    const db = await dbFor(this.env, token, this.background);
    return pack(await db.query(sql, values(params)), db);
  }
  /** 全文を 1 取引で実行する。競合は内部でやり直す。 */
  async batch(statements: RemoteStatement[], token = 0): Promise<RemoteResult[]> {
    const db = await dbFor(this.env, token, this.background);
    const out = await db.transaction(async (tx) => {
      const results: QueryResult[] = [];
      for (const s of statements) results.push(await tx.query(s.sql, values(s.params)));
      return results;
    });
    return out.map((r) => pack(r, db));
  }
  async begin(mode: TransactionMode = "write", token = 0): Promise<RemoteTx> {
    const db = await dbFor(this.env, token, this.background);
    await db.query(mode === "write" ? "BEGIN IMMEDIATE" : "BEGIN");
    return new RemoteTx(db);
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
    // trigger は DDL の履歴に文面が残らないので、現在の表定義から足す。
    const cat = await (await dbFor(this.env, 0)).catalog();
    return [...(await schemaSql(this.env)), ...Object.values(cat.triggers).map((t) => t.sql)];
  }
  /** 利用者の表の名前。内部の表 (グローバル index の実体) は含まない。 */
  async tables(): Promise<string[]> {
    const db = await dbFor(this.env, 0);
    return Object.keys((await db.catalog()).tables).filter((t) => !t.startsWith("__"));
  }
  /**
   * 表の行を少しずつ返す。論理エクスポートに使う。cursor が null になったら終わりである。
   * 時点はそろえないので、書き込みを止めていなければ、取引の途中の状態が混じり得る。
   * BLOB は JSON で運べないので、{ $blob: 16 進 } に変える。
   */
  async exportRows(table: string, cursor: ExportCursor | null, limit = 1000) {
    const page = await exportRows(this.env, table, cursor, limit);
    const hex = (v: Uint8Array) => Array.from(v, (b) => b.toString(16).padStart(2, "0")).join("");
    return { ...page, rows: page.rows.map((r) => r.map((v) => (v instanceof Uint8Array ? { $blob: hex(v) } : v))) };
  }
  /** export が書き出した行を入れる。BLOB は { $blob: 16 進 } で受ける。 */
  async importRows(table: string, columns: string[], rows: unknown[][]): Promise<number> {
    return importRows(await dbFor(this.env, 0, this.background), table, columns, rows);
  }
  /** `env.DB.fetch()` は HTTP の入口 (Hrana、/sql、/admin) と同じで、トークンを検査する。 */
  override fetch(request: Request): Promise<Response> {
    return handle(request, this.env, this.ctx);
  }
}
