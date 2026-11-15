// シャードの核 (kernel.ts) と殻 (core.ts) の間でやり取りする型。
//
// Durable Object は、保存の入出力のほかを await しないかぎり、1 本の糸で動く原子的な状態機械である。だから、シャードの状態を
// 読み書きする処理は、すべて同期の核に置く。核は async の関数を持たない。要求は、核の同期の 1 歩 (step) で処理する。1 歩は、
// 先頭で前提を確かめ、終えるか、待ちたいこと (Effect) を返す。殻は、返った待ちを実行して、同じ 1 歩を先頭から呼び直す。
//
//   for (;;) { const r = step(frame); if (r.done) return r.value; frame[r.into] = await perform(r.wait); }
//
// 待ちをまたいで残るのは、frame (データだけの入れ物) の中身だけである。待ちの前に確かめたこと (同期区間の印 Section) は、
// frame に入れられないので、待ちの後へ持ち越せない。待ちの後で確かめ直さないことは、frame の名前の付いた印として見える。
import type { LockOwner, ShardApi, Ts } from "../types";

/** 核の手続きの名前 (kernel.ts の programs の鍵)。 */
export type ProgramName = string;

/** 相手のシャードへの要求 1 つ。 */
export interface PeerCall {
  to: string;
  method: keyof ShardApi;
  req: unknown;
}

/**
 * 核が殻に頼む待ち。データだけで、関数も Promise も持たない。
 * 殻は、待ちを実行し、結果を frame に書いてから、同じ 1 歩を先頭から呼び直す。
 */
export type Effect =
  /** 核の別の手続きを、終わるまで走らせる。結果は、その手続きの結果である。 */
  | { kind: "call"; program: ProgramName; frame: object }
  /** 表定義の適用を始めるか、進行中の適用に合流して、終わるのを待つ。適用が失敗したら、この待ちも失敗する。 */
  | { kind: "schemaChange"; catchUp: boolean }
  /** 進行中の表定義の適用が終わるのを待つ。失敗しても、この待ちは失敗しない。 */
  | { kind: "schemaChangeOver" }
  /** グループを渡す側から引き取る。同じグループを引き取っている最中なら、それに合流する。 */
  | { kind: "pull"; groups: string[] }
  /** 取引の決着を anchor に尋ねる。anchor が自分なら、自分の手続き (queryTxn) を走らせる。結果は TxnStatus。 */
  | { kind: "ask"; anchor: string; txn: string; pushTo: Ts }
  /** 同じ 2PC の ID の確定の実行が終わるのを待つ。 */
  | { kind: "flight"; txn: string }
  /** 行のロックか intent が空くのを待つ。期限を過ぎたら ConflictError で失敗する。quiet なら、失敗しても待ちを終えるだけである。 */
  | { kind: "row"; key: string; me: LockOwner; deadline: number; quiet?: true }
  /** ここまでの書き込みが、保存先で確定するのを待つ (Backend.sync)。 */
  | { kind: "sync" }
  | { kind: "sleep"; ms: number }
  /** 相手のシャードを呼ぶ。結果は、その応答である。 */
  | { kind: "peer"; call: PeerCall }
  /** 相手のシャードを同時に呼び、全部の応答を待つ。結果は、応答の配列である。 */
  | { kind: "peers"; calls: PeerCall[] }
  /** Meta を呼ぶ。orNull は、失敗を null の結果にする。 */
  | { kind: "meta"; method: "epochsSince" | "revokeDdl" | "startSplit" | "checkSplit"; args: unknown[]; orNull?: true };

/** 待たずに始めること。殻は、1 歩が返った直後に、並んだ順に始める。 */
export type Fork =
  /** 応答の後も続ける仕事。失敗は捨てる (再駆動が拾う)。DO では ctx.waitUntil に渡す。 */
  | { kind: "background"; effect: Effect }
  /** 結果を待たず、失敗も捨てる。 */
  | { kind: "detached"; effect: Effect }
  /** いまの同期区間が終わってから、その行の次の待ち手を起こす。 */
  | { kind: "wake"; key: string };

/** 失敗を受け取る待ち (attempt) の結果。 */
export type Outcome<T> = { ok: true; value: T } | { ok: false; error: unknown };

/**
 * 核の 1 歩の結果。
 *   done: 手続きが終わった。
 *   wait: 待ちを実行して、同じ 1 歩を先頭から呼び直す。into があれば、待ちの結果を frame のその欄に書く。caught なら、待ちが
 *         失敗しても手続きを終わらせず、結果を Outcome の形で書く。
 *   tail: 待ちの結果が、そのまま手続きの結果になる。
 * forks は、どの場合も、返った直後に始める。
 */
export type Step<T, F> = (
  | { done: true; value: T }
  | { done: false; wait: Effect; into?: keyof F & string; caught?: true }
  | { done: false; tail: Effect }
) & { forks?: Fork[] };

// 1 歩の結果を作る関数。into は frame の欄の名前で、手続きの型 (Step<T, F>) が、欄があることを確かめる。
export const done = <T>(value: T, forks?: Fork[]): { done: true; value: T; forks?: Fork[] } => (forks ? { done: true, value, forks } : { done: true, value });
/** 待つ。待ちが失敗したら、手続きもその誤りで終わる。 */
export function wait(effect: Effect): { done: false; wait: Effect };
export function wait<K extends string>(effect: Effect, into: K | undefined, forks?: Fork[]): { done: false; wait: Effect; into?: K; forks?: Fork[] };
export function wait(effect: Effect, into?: string, forks?: Fork[]): { done: false; wait: Effect; into?: string; forks?: Fork[] } {
  return { done: false, wait: effect, ...(into === undefined ? {} : { into }), ...(forks ? { forks } : {}) };
}
/** 待つ。待ちが失敗しても手続きは終わらず、失敗を Outcome として frame の欄に受け取る。 */
export const attempt = <K extends string>(effect: Effect, into: K): { done: false; wait: Effect; into: K; caught: true } =>
  ({ done: false, wait: effect, into, caught: true });
/** 待ちの結果を、そのまま手続きの結果にする。 */
export const tail = (effect: Effect, forks?: Fork[]): { done: false; tail: Effect; forks?: Fork[] } =>
  (forks ? { done: false, tail: effect, forks } : { done: false, tail: effect });

/** attempt の結果を取り出す。失敗していたら、その誤りを投げる。 */
export function unwrap<T>(o: Outcome<T>): T {
  if (!o.ok) throw o.error;
  return o.value;
}

/** 核の手続き。step は 1 歩、exit は、手続きが終わるとき (結果を返すときも、誤りで終わるときも) に呼ぶ後始末である。 */
export interface Program<K, F, T> {
  step(this: K, f: F): Step<T, F>;
  exit?(this: K, f: F): Fork[];
}
