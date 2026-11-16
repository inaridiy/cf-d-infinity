// 入口の守り (2026-11-12 の入口の安全の確認、指摘 4 から 8)。HTTP と WebSocket の要求の大きさと件数の上限、hello の期限、
// トークンの比べ方、管理の入口の入力の検証を、ここで決める。上限は README の Limitations に書く。
import { kindOf, toValue } from "./client/d1";
import { SqlError, type Value } from "./types";

export const ENTRY_LIMITS = {
  /** 1 回の HTTP の本文の文字数。 */
  bodyChars: 8 * 1024 * 1024,
  /** 1 回の要求の文の数 (`/batch` の文、Hrana の pipeline の要求、batch の段)。 */
  statements: 1000,
  /** 1 つの文の文字数。DO の SQLite は 100 KB を超える文を受け付けないが、Worker の SQLite で答える文もあるので、余裕を見る。 */
  sqlChars: 1024 * 1024,
  /** WebSocket の 1 つのメッセージの文字数かバイト数。 */
  wsMessage: 8 * 1024 * 1024,
  /** 1 つの WebSocket で開けるストリームの数。 */
  wsStreams: 64,
  /** 1 つの接続 (WebSocket か baton) が保存できる文の数。 */
  storedSql: 1000,
  /** WebSocket を開いてから hello が届くまでの期限 (ms)。 */
  helloMs: 10_000,
};

/** 入口で断る誤り。status は HTTP の状態の番号である。 */
export class BadRequest extends Error {
  constructor(readonly status: number, message: string) {
    super(message);
    this.name = "BadRequest";
  }
}

/** トークンを一定時間で比べる。長さの違いだけは漏れる。 */
export function sameToken(a: string, b: string): boolean {
  if (a.length !== b.length) return false;
  let x = 0;
  for (let i = 0; i < a.length; i++) x |= a.charCodeAt(i) ^ b.charCodeAt(i);
  return x === 0;
}

const INT64_MIN = -(2n ** 63n);
const INT64_MAX = 2n ** 63n - 1n;

/**
 * 小数点か指数のある JSON の数の literal で、値が安全な整数のもの (`5.0`、`1e5`)。文面では REAL だが、JS の数としては D1 の規則
 * (安全な整数は INTEGER) で INTEGER になるので、numberLiterals が包んで印にする。印はこのクラスで、numberLiterals だけが作る。
 * JSON の本文にも structured clone にも作れないので、利用者は偽れない (Service Binding で届いた同じ形の object は、toValue が断る)。
 */
class RealLiteral {
  constructor(readonly value: number) {}
}

/**
 * HTTP の /sql と /batch の本文の reviver (docs/design-values.md の「D1 互換の API、Service Binding、HTTP の JSON」)。JSON の数の
 * literal を、元の文面 (reviver の context.source) で読む。JSON.parse は文面を JS の数に丸めるので、値からは型が分からない
 * (`5.0` は 5 に、`9223372036854775807` は隣の double になる)。
 *   - 数字だけの literal は INTEGER。安全な整数の外で 64 ビットに収まるものは、文面から bigint にする。64 ビットに収まらないものは、
 *     SQLite がその literal を読むのと同じく REAL で、JS の数のままにする。
 *   - 小数点か指数のある literal は REAL。値が安全な整数のものは、RealLiteral で包む (jsonValue が REAL として外す)。
 * 引数は配列の要素にだけあるので、配列の要素の数だけを読み替える。本文の token などの数は、JS の数のまま返す。
 * 元の文面を渡さない実行環境 (JSON.parse の source text access のない V8) では、数を JS の数のまま返し、jsonValue が D1 の規則
 * (安全な整数は INTEGER、ほかは REAL) で読む。そこでは `5.0` も INTEGER になる (2026-11-16。docs/sql-language.md の「引数の型」)。
 */
export function numberLiterals(this: unknown, _key: string, value: unknown, context?: { source?: string }): unknown {
  if (typeof value !== "number" || !Array.isArray(this)) return value;
  const source = context?.source;
  if (typeof source !== "string") return value;
  if (/^-?[0-9]+$/.test(source)) {
    if (Number.isSafeInteger(value)) return value;
    const big = BigInt(source);
    return big >= INT64_MIN && big <= INT64_MAX ? big : value;
  }
  return Number.isSafeInteger(value) ? new RealLiteral(value) : value;
}

/**
 * HTTP の本文の引数 1 つを値にする。numberLiterals の印は REAL、ほかの数と bigint は D1 互換の API と同じ toValue で読む
 * (印の付かなかった数は、数字だけの literal か、値が安全な整数でない数である)。JSON の配列と object は値ではないので断る。
 * JSON には BLOB を書く形がない。
 */
function jsonValue(v: unknown, i: number): Value {
  if (v instanceof RealLiteral) return v.value;
  if (typeof v === "object" && v !== null) {
    throw new SqlError(`parameter ${i + 1} is ${kindOf(v)}; a parameter in JSON must be null, true, false, a number or a string (write a BLOB as x'...' in the statement, or use Hrana)`);
  }
  return toValue(v, i);
}

/** HTTP の /sql と /batch の引数 (numberLiterals で読んだ本文の params) を値にする。配列でなければ 400 で断る。 */
export function jsonParams(params: unknown): Value[] {
  if (params === undefined || params === null) return [];
  if (!Array.isArray(params)) throw new BadRequest(400, "params must be an array");
  return params.map((v, i) => jsonValue(v, i));
}

/**
 * 本文を JSON として読む。大きすぎれば 413、JSON でなければ 400 で断る。reviver は、利用者の値を運ぶ本文 (/sql と /batch) にだけ
 * 渡す (numberLiterals)。Hrana の本文は型を書いた値 (`float` の数は REAL) を運ぶので、渡さない。
 */
export async function readJson(request: Request, reviver?: typeof numberLiterals): Promise<unknown> {
  const declared = Number(request.headers.get("content-length") ?? 0);
  if (declared > ENTRY_LIMITS.bodyChars) throw new BadRequest(413, `request body is larger than ${ENTRY_LIMITS.bodyChars} bytes`);
  const text = await request.text();
  if (text.length > ENTRY_LIMITS.bodyChars) throw new BadRequest(413, `request body is larger than ${ENTRY_LIMITS.bodyChars} characters`);
  try {
    return JSON.parse(text, reviver as Parameters<typeof JSON.parse>[1]);
  } catch {
    throw new BadRequest(400, "request body is not JSON");
  }
}

/** 1 回の要求の文の数を確かめる。 */
export function checkCount(n: number, what: string): void {
  if (n > ENTRY_LIMITS.statements) throw new BadRequest(413, `${what}: at most ${ENTRY_LIMITS.statements} per request`);
}

/** 1 つの文の長さを確かめる。 */
export function checkSql(sql: unknown): string {
  if (typeof sql !== "string") throw new BadRequest(400, "sql must be a string");
  if (sql.length > ENTRY_LIMITS.sqlChars) throw new BadRequest(413, `a statement is longer than ${ENTRY_LIMITS.sqlChars} characters`);
  return sql;
}

/** 管理の入口が受け取るクラスタの名前。Durable Object の名前になるので、形を決める。 */
export function clusterName(name: unknown): string {
  if (name === undefined) return "shard";
  if (typeof name !== "string" || !/^[A-Za-z0-9_-]{1,64}$/.test(name)) throw new BadRequest(400, "cluster must be 1 to 64 letters, digits, '_' or '-'");
  return name;
}

/** 管理の入口が受け取るシャードの名前。`<クラスタ>-<番号>` の形でなければ、別のクラスタの Meta を見るシャードができる。 */
export function shardName(cluster: string, id: unknown): string {
  if (typeof id !== "string" || !new RegExp(`^${cluster.replace(/[-]/g, "\\-")}-[0-9]{1,6}$`).test(id)) {
    throw new BadRequest(400, `shard must look like ${cluster}-<number>`);
  }
  return id;
}

/** 管理の入口が受け取る、初めのシャードの数。 */
export function shardCount(n: unknown): number | undefined {
  if (n === undefined) return undefined;
  if (typeof n !== "number" || !Number.isInteger(n) || n < 1 || n > 4096) throw new BadRequest(400, "shards must be an integer from 1 to 4096");
  return n;
}
