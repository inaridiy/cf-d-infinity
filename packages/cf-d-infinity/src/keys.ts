// 行と shard key の同一性 (計画書の不変条件 6)。キー文字列を作る関数はここだけにある。
//
// Worker は、行を置くシャードを、文の中の値から決める。シャードは、入った行の値から行のキーを作る。2 つが同じになるように、
// Worker は、値が列に入ったときに SQLite が何を入れるか (型の親和性による変換) を、src/sql/stored.ts の storedValue で決める。
import type { Value } from "./types";

const INT64_MAX = 2n ** 63n - 1n;
const INT64_MIN = -(2n ** 63n);

// ---- キー文字列 (docs/design-values.md の「キー文字列」) ----
//
// 値の並びの JSON である。BLOB は `{"$b":"小文字の 16 進"}`、無限大は `{"$f":"Infinity"}` と書く。数の書き方は 1 つの規則による。
// - INTEGER は、桁数に関わらず 10 進の数字で書く。
// - REAL は、整数の値で 64 ビットの整数の範囲 (-2^63 以上、2^63 未満) にあれば、その整数の数字で書く。そうでなければ、
//   JSON.stringify の表記で書く。
// SQLite は INTEGER と REAL を正確に比べる。REAL の 2^53 と INTEGER の 2^53 は同じキーで、INTEGER の 2^53 + 1 は別のキーである。
// JS の数の表記は、2^53 以上では double の正確な値ではないので (2^62 + 1024 は 4611686018427389000 と書かれる)、
// 整数の値の REAL は BigInt にしてから書く。こうすると、キー文字列が等しいことと、SQLite が同じキーと見なすことが、
// 2^53 を超えても一致する (test/key-conversions.test.ts)。
//
// 段 2 で、値の JSON.stringify をそのまま使う前の関数 (保存の形式 1 の keyString) と入れ替えた。いま保存できる値のキーは、
// 1 つの場合を除いて前の関数と 1 バイトも変わらない。変わるのは、絶対値が 2^53 以上で、64 ビットの整数の範囲にある、整数の値の
// REAL のうち、JS の表記が正確な値と違うものである (前の関数は test/key-string-old.ts に残し、試験が比べる)。

const lowerHex = (b: Uint8Array) => {
  let s = "";
  for (const x of b) s += (x < 16 ? "0" : "") + x.toString(16);
  return s;
};

/** REAL のキー。整数の値で 64 ビットの整数の範囲にあれば、INTEGER と同じく 10 進の数字で書く。 */
function numberKey(x: number): string {
  if (Number.isInteger(x) && x >= -(2 ** 63) && x < 2 ** 63) return BigInt(x).toString();
  if (!Number.isFinite(x)) return `{"$f":${JSON.stringify(String(x))}}`;
  return JSON.stringify(x);
}

/** キー文字列。INTEGER (bigint) と REAL (number) は同じ規則で書くので、INTEGER の 5 と REAL の 5.0 は同じキーである。 */
export function keyString(values: readonly Value[]): string {
  const parts = values.map((v) => {
    if (v === null) return "null";
    if (typeof v === "bigint") {
      if (v < INT64_MIN || v > INT64_MAX) throw new RangeError(`the integer ${v} does not fit in 64 bits`);
      return v.toString();
    }
    if (typeof v === "number") return numberKey(v);
    if (typeof v === "string") return JSON.stringify(v);
    return `{"$b":"${lowerHex(v)}"}`;
  });
  return `[${parts.join(",")}]`;
}

/**
 * キー文字列を値に戻す。整数は INTEGER (bigint) で返す。整数の値の REAL から作ったキーも INTEGER で戻るが、戻した値は
 * `WHERE 主キー IS ?` に束縛するので、REAL で入っている同じ値の行にも当たる (SQLite は INTEGER と REAL を正確に比べる)。
 *
 * JSON.parse は 2^53 以上の整数を丸めるので、reviver が受け取る元の文面 (context.source) から読む。Node 24 と workerd にある
 * (test/workerd-limits.test.ts)。ない実行環境では、丸まった整数を黙って返さずに、投げる。
 */
export function keyValues(key: string): Value[] {
  const reviver = (_k: string, x: unknown, context?: { source?: string }): unknown => {
    if (typeof x === "number") {
      const source = context?.source;
      if (source === undefined) {
        // 元の文面がない。64 ビットの整数の範囲の外の数は REAL としてしか書かれないので、そのまま返せる。範囲の中の、
        // 2^53 以上の整数は、丸まった後の値しか分からない。
        if (!Number.isInteger(x) || x >= 2 ** 63 || x < -(2 ** 63)) return x;
        if (!Number.isSafeInteger(x)) throw new Error("this runtime does not pass the source text to a JSON.parse reviver; a key with an integer beyond 2^53 cannot be read exactly");
        return BigInt(x);
      }
      if (!/^-?\d+$/.test(source)) return x;
      const big = BigInt(source);
      return big >= INT64_MIN && big <= INT64_MAX ? big : x;
    }
    if (x !== null && typeof x === "object" && !Array.isArray(x)) {
      const o = x as { $b?: unknown; $f?: unknown };
      if (typeof o.$b === "string") return Uint8Array.from(o.$b.match(/../g) ?? [], (h) => parseInt(h, 16));
      if (typeof o.$f === "string") return Number(o.$f);
    }
    return x;
  };
  return JSON.parse(key, reviver as (this: unknown, key: string, value: unknown) => unknown) as Value[];
}
