// libSQL の Hrana over HTTP (v3 の JSON)。@libsql/client が接続先を変えるだけで動く。
// Worker は状態を持たないので、取引の状態は baton に載せて持ち回る。
import { decode, encode } from "../shard/rows";
import { SqlError, type Value } from "../types";
import { checkCount, checkSql, ENTRY_LIMITS } from "../entry";
import type { Params } from "../sql/cst";
import type { Db, QueryResult } from "./db";
import { sleep } from "../runtime";

type HValue =
  | { type: "null" }
  | { type: "integer"; value: string }
  | { type: "float"; value: number }
  | { type: "text"; value: string }
  | { type: "blob"; base64: string };

interface Stmt {
  sql?: string;
  sql_id?: number;
  args?: HValue[];
  named_args?: { name: string; value: HValue }[];
  want_rows?: boolean;
}

type Cond =
  | { type: "ok"; step: number }
  | { type: "error"; step: number }
  | { type: "not"; cond: Cond }
  | { type: "and"; conds: Cond[] }
  | { type: "or"; conds: Cond[] }
  | { type: "is_autocommit" };

type Request =
  | { type: "execute"; stmt: Stmt }
  | { type: "batch"; batch: { steps: { condition?: Cond | null; stmt: Stmt }[] } }
  | { type: "sequence"; sql?: string; sql_id?: number }
  | { type: "describe"; sql?: string; sql_id?: number }
  | { type: "store_sql"; sql_id: number; sql: string }
  | { type: "close_sql"; sql_id: number }
  | { type: "get_autocommit" }
  | { type: "close" };

export interface PipelineReq {
  baton: string | null;
  requests: Request[];
}

const toBase64 = (b: Uint8Array) => {
  let s = "";
  for (const x of b) s += String.fromCharCode(x);
  return btoa(s);
};
const fromBase64 = (s: string) => Uint8Array.from(atob(s.padEnd(Math.ceil(s.length / 4) * 4, "=")), (c) => c.charCodeAt(0));

const INT64_MIN = -(2n ** 63n);
const INT64_MAX = 2n ** 63n - 1n;
/** 標準の base64 (RFC 4648 の 4 節)。末尾の埋め草 (`=`) は、あってもなくてもよい (前から、埋め草のない base64 も受け付けている)。 */
const BASE64 = /^(?:[A-Za-z0-9+/]{4})*(?:[A-Za-z0-9+/]{2}(?:==)?|[A-Za-z0-9+/]{3}=?)?$/;

/**
 * 引数の誤り (計画書の未解決の問題 51)。code は、sqld が引数の誤りに使う ARGS_INVALID である (Hrana の仕様は code を決めておらず、
 * サーバに任せている)。文を実行する前に断るので、何も書かない。要求ごとの誤りとして返し、同じ pipeline のほかの要求と取引 (baton) は
 * 続く。sqld は、型の印と値の合わない本文を JSON として読めず、pipeline の全体を HTTP 400 で断る。
 */
class ArgsInvalid extends SqlError {
  readonly code = "ARGS_INVALID";
}

/** 誤りの文面に書く、JS の値の種類。値そのものは書かない (長いことがある)。 */
const shown = (v: unknown): string =>
  v === undefined ? "nothing" : v === null ? "null" : Array.isArray(v) ? "an array" : typeof v === "object" ? "an object" : `a ${typeof v}`;

/**
 * Hrana の値を値にする。型の印 (`type`) で枝を選び、値の JS の型が印と合うかを確かめる (2026-11-16 まで確かめず、`float` の文字列が
 * TEXT に、`float` の配列が BLOB になり、知らない type は undefined のまま束縛へ進んだ)。合わなければ ArgsInvalid で断る。
 * label は誤りの文面に書く引数の名前で、位置の引数は 1 から数えた番号、名前つきの引数は名前である。
 */
function fromH(v: unknown, label: string): Value {
  const bad = (what: string) => new ArgsInvalid(`argument ${label} ${what}`);
  if (typeof v !== "object" || v === null || Array.isArray(v)) throw bad(`is ${shown(v)}; a Hrana value is an object with a "type"`);
  const h = v as { type?: unknown; value?: unknown; base64?: unknown };
  switch (h.type) {
    case "null": return null;
    case "integer": {
      // 整数は 10 進の文字列で届く (JSON の数は 2^53 を超えると丸まる)。INTEGER (bigint) として正確に受け取る。
      if (typeof h.value !== "string") throw bad(`is an integer with ${shown(h.value)} in "value"; an integer carries its decimal digits as a string`);
      if (!/^-?[0-9]+$/.test(h.value)) throw bad(`is an integer whose "value" ${JSON.stringify(h.value.slice(0, 40))} is not decimal digits`);
      const big = BigInt(h.value);
      if (big < INT64_MIN || big > INT64_MAX) throw new ArgsInvalid(`argument ${label}: the integer ${h.value} does not fit in 64 bits`);
      return big;
    }
    // float は REAL である (JS の数)。sqld も float を REAL として束縛する。
    case "float":
      if (typeof h.value !== "number") throw bad(`is a float with ${shown(h.value)} in "value"; a float carries a number`);
      return h.value;
    case "text":
      if (typeof h.value !== "string") throw bad(`is a text with ${shown(h.value)} in "value"; a text carries a string`);
      return h.value;
    case "blob":
      if (typeof h.base64 !== "string") throw bad(`is a blob with ${shown(h.base64)} in "base64"; a blob carries its bytes as a base64 string`);
      if (!BASE64.test(h.base64)) throw bad(`is a blob whose "base64" is not base64`);
      return fromBase64(h.base64);
  }
  const type = h.type === undefined ? "no type" : `the type ${typeof h.type === "string" ? JSON.stringify(h.type.slice(0, 40)) : shown(h.type)}`;
  throw bad(`has ${type}; the types are null, integer, float, text and blob`);
}

/** INTEGER は integer (10 進の文字列)、REAL は float で返す。整数の値の REAL も float で返り、sqld と同じである。 */
function toH(v: Value): HValue {
  if (v === null || v === undefined) return { type: "null" };
  if (typeof v === "string") return { type: "text", value: v };
  if (v instanceof Uint8Array) return { type: "blob", base64: toBase64(v) };
  if (typeof v === "bigint") return { type: "integer", value: String(v) };
  return { type: "float", value: v };
}

/**
 * 文の引数。位置の引数 (`args`) と名前つきの引数 (`named_args`) の並び自体の形も、文を実行する前に確かめる。両方があれば、位置の
 * 引数を `?1`、`?2` の名前で渡す。
 */
function args(s: Stmt): Params {
  const positional: unknown = s.args ?? [];
  const namedArgs: unknown = s.named_args ?? [];
  if (!Array.isArray(positional)) throw new ArgsInvalid(`arguments: "args" is ${shown(positional)}; it must be an array of Hrana values`);
  if (!Array.isArray(namedArgs)) throw new ArgsInvalid(`arguments: "named_args" is ${shown(namedArgs)}; it must be an array of { name, value }`);
  if (namedArgs.length === 0) return positional.map((v, i) => fromH(v, String(i + 1)));
  const named: Record<string, Value> = {};
  positional.forEach((v, i) => (named[`?${i + 1}`] = fromH(v, String(i + 1))));
  for (const a of namedArgs as unknown[]) {
    if (typeof a !== "object" || a === null || typeof (a as { name?: unknown }).name !== "string") {
      throw new ArgsInvalid(`arguments: a named argument is ${shown(a)}${typeof a === "object" && a !== null ? " without a string \"name\"" : ""}; it must be { name, value }`);
    }
    const { name, value } = a as { name: string; value?: unknown };
    named[name] = fromH(value, name);
  }
  return named;
}

function stmtResult(r: QueryResult) {
  return {
    cols: r.columns.map((name) => ({ name, decltype: null })),
    rows: r.values.map((row) => row.map(toH)),
    affected_row_count: r.changes,
    last_insert_rowid: r.lastInsertRowid === null ? null : String(r.lastInsertRowid),
    replication_index: null,
    rows_read: 0,
    rows_written: r.changes,
    query_duration_ms: 0,
  };
}

const failure = (e: unknown) => {
  const message = e instanceof Error ? e.message : String(e);
  if (e instanceof ArgsInvalid) return { message, code: e.code };
  return {
    message,
    code: /UNIQUE|NOT NULL|CHECK|constraint/i.test(message) ? "SQLITE_CONSTRAINT"
      : /^(conflict|read too old|not owner|migrating|upgrading)/.test(message) ? "SQLITE_BUSY" : "SQLITE_ERROR",
  };
};

function evalCond(c: Cond | null | undefined, results: (unknown | null)[], errors: (unknown | null)[], db: Db): boolean {
  if (!c) return true;
  switch (c.type) {
    case "ok": return results[c.step] !== null && results[c.step] !== undefined;
    case "error": return errors[c.step] !== null && errors[c.step] !== undefined;
    case "not": return !evalCond(c.cond, results, errors, db);
    case "and": return c.conds.every((x) => evalCond(x, results, errors, db));
    case "or": return c.conds.some((x) => evalCond(x, results, errors, db));
    case "is_autocommit": return !db.inTransaction;
  }
}

interface Baton {
  session: ReturnType<Db["dump"]>;
  stored: [number, string][];
}

/** 1 つの stream の上で Hrana の要求を 1 件実行する。HTTP の pipeline と WebSocket で共用する。 */
async function runRequest(db: Db, r: Request, stored: Map<number, string>): Promise<{ type: string; [k: string]: unknown }> {
  // 文の長さと、batch の段の数に上限を置く (入口の安全の確認、指摘 5)。
  const sqlOf = (s: { sql?: string; sql_id?: number }) => checkSql(s.sql ?? stored.get(s.sql_id!) ?? "");
  switch (r.type) {
    case "execute": {
      const out = await db.query(sqlOf(r.stmt), args(r.stmt));
      return { type: "execute", result: stmtResult(out) };
    }
    case "batch": {
      checkCount(r.batch.steps.length, "batch steps");
      // BEGIN から始まる batch は文が全部分かっているので、競合したら丸ごとやり直せる。
      // ただし、途中の DDL が取引を確定した後は、前のほうの文がもう効いている。やり直すと 2 度実行するので、やり直さない
      // (Db.ddl、specs/m13_txn_schema_boundary.qnt の m13_red_retry_whole)。
      const first = sqlOf(r.batch.steps[0]?.stmt ?? {});
      const replayable = !db.inTransaction && /^\s*BEGIN\b/i.test(first);
      let stepResults: (unknown | null)[] = [];
      let stepErrors: (unknown | null)[] = [];
      for (let attempt = 0; ; attempt++) {
        const boundaries = db.boundaries;
        stepResults = [];
        stepErrors = [];
        for (const [i, step] of r.batch.steps.entries()) {
          stepResults[i] = null;
          stepErrors[i] = null;
          if (!evalCond(step.condition, stepResults, stepErrors, db)) continue;
          try {
            stepResults[i] = stmtResult(await db.query(sqlOf(step.stmt), args(step.stmt)));
          } catch (e) {
            stepErrors[i] = failure(e);
          }
        }
        const busy = stepErrors.some((e) => (e as { code?: string } | null)?.code === "SQLITE_BUSY");
        const settled = db.boundaries !== boundaries && !db.faults.replayAcrossSchemaChange;
        if (!replayable || !busy || settled || attempt >= 12) break;
        // 前の試行の行ロックを手放してからやり直す。手放さないと、やり直した取引が、自分の前の試行のロックを期限まで待つ。
        await db.abandon();
        await sleep(db.rt, db.rt.random() * Math.min(50, 2 ** attempt));
      }
      return { type: "batch", result: { step_results: stepResults, step_errors: stepErrors } };
    }
    case "sequence":
      await db.query(sqlOf(r));
      return { type: "sequence" };
    case "describe":
      return { type: "describe", result: { params: [], cols: [], is_explain: false, is_readonly: /^\s*SELECT/i.test(sqlOf(r)) } };
    case "store_sql":
      // 保存した文は baton と接続に載り続けるので、数に上限を置く (入口の安全の確認、指摘 4 と 5)。
      if (!stored.has(r.sql_id) && stored.size >= ENTRY_LIMITS.storedSql) throw new SqlError(`at most ${ENTRY_LIMITS.storedSql} stored statements per connection`);
      stored.set(r.sql_id, checkSql(r.sql));
      return { type: "store_sql" };
    case "close_sql":
      stored.delete(r.sql_id);
      return { type: "close_sql" };
    case "get_autocommit":
      return { type: "get_autocommit", is_autocommit: !db.inTransaction };
    case "close":
      // 開いている取引は巻き戻す (sqld と同じ)。行ロックを残すと、ほかの接続の書き込みが期限まで待たされる。
      if (db.inTransaction) await db.abandon();
      return { type: "close" };
  }
}

export interface BatonSeal {
  seal(payload: string): Promise<string>;
  /** 署名が正しければ中身を、そうでなければ null を返す。 */
  open(baton: string): Promise<string | null>;
}

/**
 * baton に HMAC-SHA256 の署名を付ける。baton は取引の read set、write set、読み取り時刻を運ぶので、
 * 改竄されると検証を飛ばせる (たとえば write の since を未来にする)。
 */
export function batonSealer(secret: string): BatonSeal {
  const key = crypto.subtle.importKey("raw", new TextEncoder().encode(secret), { name: "HMAC", hash: "SHA-256" }, false, ["sign", "verify"]);
  const mac = async (payload: string) =>
    toBase64(new Uint8Array(await crypto.subtle.sign("HMAC", await key, new TextEncoder().encode(payload))));
  return {
    seal: async (payload) => `${payload}.${await mac(payload)}`,
    open: async (baton) => {
      const at = baton.lastIndexOf(".");
      if (at < 0) return null;
      const payload = baton.slice(0, at);
      const sig = fromBase64(baton.slice(at + 1));
      const ok = await crypto.subtle.verify("HMAC", await key, sig, new TextEncoder().encode(payload));
      return ok ? payload : null;
    },
  };
}

export async function handlePipeline(req: PipelineReq, open: (token: number) => Promise<Db>, seal?: BatonSeal) {
  let raw = req.baton;
  if (raw && seal) {
    raw = await seal.open(raw);
    if (raw === null) {
      const error = { message: "invalid baton", code: "BATON_INVALID" };
      return { baton: null, base_url: null, results: req.requests.map(() => ({ type: "error", error })) };
    }
  }
  const state: Baton | null = raw ? decode<Baton>(new TextDecoder().decode(fromBase64(raw))) : null;
  const db = await open(state?.session.token ?? 0);
  if (state) await db.restore(state.session);
  const stored = new Map(state?.stored ?? []);

  let closed = false;
  const results = [];
  for (const r of req.requests) {
    try {
      results.push({ type: "ok", response: await runRequest(db, r, stored) });
      if (r.type === "close") closed = true;
    } catch (e) {
      results.push({ type: "error", error: failure(e) });
    }
  }
  const payload = closed ? null : toBase64(new TextEncoder().encode(encode({ session: db.dump(), stored: [...stored] } satisfies Baton)));
  const baton = payload === null ? null : seal ? await seal.seal(payload) : payload;
  return { baton, base_url: null, results };
}

type WsRequest =
  | { type: "open_stream"; stream_id: number }
  | { type: "close_stream"; stream_id: number }
  | { type: "store_sql"; sql_id: number; sql: string }
  | { type: "close_sql"; sql_id: number }
  | ({ stream_id: number } & Exclude<Request, { type: "store_sql" } | { type: "close_sql" } | { type: "close" }>);

type WsMessage = { type: "hello"; jwt: string | null } | { type: "request"; request_id: number; request: WsRequest };

/**
 * Hrana over WebSocket (hrana2、JSON)。接続中のメッセージは Worker のリクエストとして課金されないので、
 * HTTP で 1 文ごとに払う $0.30 / 100 万が接続 1 回分になる。stream ごとに Db を持ち、取引の状態はメモリに置く。
 * 同じ接続のメッセージは届いた順に 1 件ずつ処理する。
 */
export function serveHranaSocket(
  ws: WebSocket,
  o: { authorize(jwt: string | null): boolean; open(): Promise<Db>; onClose?(): void; onHello?(): void },
): void {
  let authed = false;
  const streams = new Map<number, Db>();
  const stored = new Map<number, string>();
  let chain: Promise<void> = Promise.resolve();
  const send = (m: unknown) => {
    try {
      ws.send(JSON.stringify(m));
    } catch {
      // 切断後の送信は捨てる。
    }
  };
  const handle = async (m: WsMessage) => {
    if (m.type === "hello") {
      authed = o.authorize(m.jwt);
      o.onHello?.();
      if (authed) send({ type: "hello_ok" });
      else {
        send({ type: "hello_error", error: { message: "unauthorized", code: "UNAUTHORIZED" } });
        ws.close(4001, "unauthorized");
      }
      return;
    }
    if (m.type !== "request") return;
    if (!authed) {
      send({ type: "response_error", request_id: m.request_id, error: { message: "hello first", code: "UNAUTHORIZED" } });
      return;
    }
    const r = m.request;
    try {
      let response: unknown;
      switch (r.type) {
        case "open_stream":
          if (streams.size >= ENTRY_LIMITS.wsStreams) throw new SqlError(`at most ${ENTRY_LIMITS.wsStreams} streams per connection`);
          streams.set(r.stream_id, await o.open());
          response = { type: "open_stream" };
          break;
        case "close_stream": {
          const db = streams.get(r.stream_id);
          if (db?.inTransaction) await db.abandon();
          streams.delete(r.stream_id);
          response = { type: "close_stream" };
          break;
        }
        case "store_sql":
        case "close_sql":
          response = await runRequest(null as unknown as Db, r, stored);
          break;
        default: {
          const db = streams.get(r.stream_id);
          if (!db) throw new Error(`no such stream: ${r.stream_id}`);
          response = await runRequest(db, r as Request, stored);
        }
      }
      send({ type: "response_ok", request_id: m.request_id, response });
    } catch (e) {
      send({ type: "response_error", request_id: m.request_id, error: failure(e) });
    }
  };
  ws.addEventListener("message", (ev) => {
    const size = typeof ev.data === "string" ? ev.data.length : (ev.data as ArrayBuffer).byteLength;
    if (size > ENTRY_LIMITS.wsMessage) {
      ws.close(1009, "message too big");
      return;
    }
    let m: WsMessage;
    try {
      m = JSON.parse(typeof ev.data === "string" ? ev.data : new TextDecoder().decode(ev.data as ArrayBuffer)) as WsMessage;
    } catch {
      ws.close(1003, "bad message");
      return;
    }
    chain = chain.then(() => handle(m));
  });
  ws.addEventListener("close", () => {
    // 接続が切れた。閉じる要求は来ないので、ここで取引を捨ててロックを手放す (待たない)。
    for (const db of streams.values()) if (db.inTransaction) void db.abandon();
    streams.clear();
    o.onClose?.();
  });
}
