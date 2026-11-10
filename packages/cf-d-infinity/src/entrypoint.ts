// Service Binding の入口。binding を持つ Worker だけが呼べるので、トークンは要らない。
import { RpcTarget, WorkerEntrypoint } from "cloudflare:workers";
import type { RemoteResult, RemoteStatement, TransactionMode } from "./binding";
import type { Db, QueryResult } from "./client/db";
import type { Value } from "./types";
import { dbFor, handle, type Env } from "./worker";

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
  async query(sql: string, params?: unknown[], token = 0): Promise<RemoteResult> {
    const db = await dbFor(this.env, token);
    return pack(await db.query(sql, values(params)), db);
  }
  /** 全文を 1 取引で実行する。競合は内部でやり直す。 */
  async batch(statements: RemoteStatement[], token = 0): Promise<RemoteResult[]> {
    const db = await dbFor(this.env, token);
    const out = await db.transaction(async (tx) => {
      const results: QueryResult[] = [];
      for (const s of statements) results.push(await tx.query(s.sql, values(s.params)));
      return results;
    });
    return out.map((r) => pack(r, db));
  }
  async begin(mode: TransactionMode = "write", token = 0): Promise<RemoteTx> {
    const db = await dbFor(this.env, token);
    await db.query(mode === "write" ? "BEGIN IMMEDIATE" : "BEGIN");
    return new RemoteTx(db);
  }
  /** `env.DB.fetch()` は HTTP の入口 (Hrana、/sql、/admin) と同じで、トークンを検査する。 */
  override fetch(request: Request): Promise<Response> {
    return handle(request, this.env);
  }
}
