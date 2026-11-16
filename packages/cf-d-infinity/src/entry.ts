// 入口の守り (2026-11-12 の入口の安全の確認、指摘 4 から 8)。HTTP と WebSocket の要求の大きさと件数の上限、hello の期限、
// トークンの比べ方、管理の入口の入力の検証を、ここで決める。上限は README の Limitations に書く。
import { toValue } from "./client/d1";
import type { Value } from "./types";

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
 * JSON の整数の literal を正確に読む reviver (HTTP の /sql と /batch。docs/design-values.md の「D1 互換の API、Service Binding、
 * HTTP の JSON」)。JSON.parse は数を JS の数に丸めるので、`9223372036854775807` は隣の double になる。数字だけで書かれた literal
 * のうち、JS の安全な整数の外にあり 64 ビットに収まるものを、元の文面 (reviver の context.source) から bigint にする。bigint は
 * INTEGER として束縛される。ほかの数 (安全な整数、小数点か指数のある数、64 ビットに収まらない数) は JSON.parse の数のままで、
 * D1 互換の API と同じく、安全な整数は INTEGER、ほかは REAL になる。元の文面を受け取れない実行環境では、JS の数のままである。
 */
export function exactIntegers(_key: string, value: unknown, context?: { source?: string }): unknown {
  if (typeof value !== "number" || Number.isSafeInteger(value)) return value;
  const source = context?.source;
  if (typeof source !== "string" || !/^-?[0-9]+$/.test(source)) return value;
  const big = BigInt(source);
  return big >= INT64_MIN && big <= INT64_MAX ? big : value;
}

/** HTTP の /sql と /batch の本文の reviver。 */
export const numberLiterals = exactIntegers;

/** HTTP の /sql と /batch の引数を値にする。 */
export const jsonParams = (params: unknown): Value[] => ((params ?? []) as unknown[]).map(toValue);

/**
 * 本文を JSON として読む。大きすぎれば 413、JSON でなければ 400 で断る。reviver は、利用者の値を運ぶ本文 (/sql と /batch) にだけ
 * 渡す (exactIntegers)。Hrana の本文は型を書いた値 (`float` の数は REAL) を運ぶので、渡さない。
 */
export async function readJson(request: Request, reviver?: typeof exactIntegers): Promise<unknown> {
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
