// 値の格納の型 (計画書の不変条件 11)。
//
// SQLite は INTEGER の 5 と REAL の 5.0 を区別する (`typeof`、割り算、TEXT の列に入れたときの文字列)。JS の数は区別しない。
// そこで、整数でない JS の数は REAL、整数の JS の数は INTEGER とし、整数の値を持つ REAL だけを印のついた値 (`Real`) で表す。
// 印は素のオブジェクトなので、RPC (structured clone) と JSON をそのまま通る。
//
// 束縛するときは、SQLite ごとに数の束縛の仕方が違う。DO の SQLite (と、シミュレータの node:sqlite) は JS の数をすべて REAL として
// 束縛する。sql.js (Worker の SQLite) は 32 ビットに収まる整数を INTEGER として束縛する。どちらでも値の型が保たれるように、文の中の引数の
// 位置を字句で見つけ、型を変える式で包む (`bindTyped`)。包む式は型の親和性を持たない形にする。`CAST(? AS INTEGER)` だけだと
// 列と同じ親和性を持ち、`'05' = ...` の比べ方が変わる。`(CAST(? AS INTEGER)+0)` は、比べ方、typeof、文字列への変換のどれも、
// 素の INTEGER の引数と同じに振る舞う (2026-11-12 に node:sqlite で確かめた)。
import { SqlError, type Value } from "./types";

/** 整数の値を持つ REAL。整数でない REAL は、ただの JS の数で表す。 */
export interface Real {
  readonly real: number;
}

/** JS の数を REAL として表す。整数の値なら印をつける。 */
export const realOf = (n: number): number | Real => (Number.isInteger(n) ? { real: n } : n);

export const isReal = (v: unknown): v is Real =>
  typeof v === "object" && v !== null && !(v instanceof Uint8Array) && typeof (v as Real).real === "number";

/** INTEGER として扱う値か。64 ビットに収まる整数の JS の数である。それより大きい整数の値は REAL としてしか入らない。 */
export const isIntegerValue = (v: Value): v is number => typeof v === "number" && Number.isInteger(v) && Math.abs(v) < 2 ** 63;

/** 数としての値。INTEGER と REAL の区別を捨てる。数でなければ null。 */
export const numberOf = (v: Value): number | null => (typeof v === "number" ? v : isReal(v) ? v.real : null);

/**
 * 数を束縛する仕方。"real": すべての数を REAL として束縛する (DO、node:sqlite)。
 * "integer": 32 ビットに収まる整数を INTEGER、ほかの数を REAL として束縛する (sql.js の `val === (val | 0)`)。
 */
export type NumberBinding = "real" | "integer";

interface Placeholder {
  start: number;
  end: number;
  /** 引数の番号 (1 から)。 */
  index: number;
}

/**
 * 文の中の引数の位置を、SQLite の番号の付け方で返す。`?` は、それまでに付いた最大の番号の次。`?NNN` は NNN。
 * `:name`、`@name`、`$name` は、初めて現れたときに次の番号が付き、同じ名前は同じ番号である。
 * 文字列、識別子の引用、注釈の中は飛ばす。
 */
export function placeholders(sql: string): Placeholder[] {
  const out: Placeholder[] = [];
  const names = new Map<string, number>();
  let max = 0;
  let i = 0;
  const n = sql.length;
  const isName = (c: string) => /[A-Za-z0-9_$]/.test(c) || c.charCodeAt(0) > 127;
  while (i < n) {
    const c = sql[i]!;
    if (c === "'" || c === '"' || c === "`") {
      const j = sql.indexOf(c, i + 1);
      if (j < 0) return out;
      // 引用の中の 2 重の引用符は、閉じずに続く。
      i = j + 1;
      while (i < n && sql[i] === c) {
        const k = sql.indexOf(c, i + 1);
        if (k < 0) return out;
        i = k + 1;
      }
      continue;
    }
    if (c === "[") {
      const j = sql.indexOf("]", i + 1);
      if (j < 0) return out;
      i = j + 1;
      continue;
    }
    if (c === "-" && sql[i + 1] === "-") {
      const j = sql.indexOf("\n", i + 2);
      i = j < 0 ? n : j + 1;
      continue;
    }
    if (c === "/" && sql[i + 1] === "*") {
      const j = sql.indexOf("*/", i + 2);
      i = j < 0 ? n : j + 2;
      continue;
    }
    if (c === "?") {
      let j = i + 1;
      while (j < n && /[0-9]/.test(sql[j]!)) j++;
      const index = j > i + 1 ? Number(sql.slice(i + 1, j)) : max + 1;
      max = Math.max(max, index);
      out.push({ start: i, end: j, index });
      i = j;
      continue;
    }
    if ((c === ":" || c === "@" || c === "$") && i + 1 < n && isName(sql[i + 1]!) && !(i > 0 && isName(sql[i - 1]!))) {
      let j = i + 1;
      while (j < n && isName(sql[j]!)) j++;
      const name = sql.slice(i, j);
      let index = names.get(name);
      if (index === undefined) {
        index = max + 1;
        names.set(name, index);
        max = index;
      }
      out.push({ start: i, end: j, index });
      i = j;
      continue;
    }
    if (isName(c)) {
      // 識別子や数の literal の途中の `$` などを、引数と取り違えない。
      while (i < n && isName(sql[i]!)) i++;
      continue;
    }
    i++;
  }
  return out;
}

const INTEGER_WRAP = (p: string) => `(CAST(${p} AS INTEGER)+0)`;
const REAL_WRAP = (p: string) => `(CAST(${p} AS REAL)+0.0)`;

/** 包む必要のある引数か。"i": INTEGER へ、"r": REAL へ。 */
function wrapOf(v: Value, binding: NumberBinding): "i" | "r" | null {
  if (binding === "real") return isIntegerValue(v) ? "i" : null;
  if (isReal(v)) return (v.real | 0) === v.real ? "r" : null;
  return isIntegerValue(v) && (v | 0) !== v ? "i" : null;
}

/** 包んだ文。文ごとに、包む引数の並び (mask) ごとに覚える。キーに文の全体をつなげた文字列を作ると、呼び出しのたびに費用がかかる。 */
const cache = { real: new Map<string, Map<string, Rewritten>>(), integer: new Map<string, Map<string, Rewritten>>() };
interface Rewritten { sql: string; columns: Map<string, string> }
const CACHE_MAX = 512;

/**
 * 値の型が保たれるように、文と引数を、束縛する SQLite に合わせて書き換える。
 * 返す columns は、包む前の文での列名への写しである。包んだ引数が結果の列の式に入ると、SQLite は書き換えた後の文面を
 * 列名にする。呼び出し側は、結果の列名をこれで戻す (`SELECT ?` の列名は `?` のまま)。
 */
export function bindTyped(sql: string, params: Value[], binding: NumberBinding): { sql: string; params: Value[]; columns: Map<string, string> | null } {
  if (params.length === 0) return { sql, params, columns: null };
  let mask: string | null = null;
  let hasReal = false;
  for (let i = 0; i < params.length; i++) {
    const v = params[i]!;
    if (isReal(v)) hasReal = true;
    const w = wrapOf(v, binding);
    if (w !== null) {
      mask ??= "-".repeat(i);
      mask += w;
    } else if (mask !== null) mask += "-";
  }
  const bound = hasReal ? params.map((v) => (isReal(v) ? v.real : v)) : params;
  if (mask === null) return { sql, params: bound, columns: null };
  const bySql = cache[binding];
  let byMask = bySql.get(sql);
  if (!byMask) {
    if (bySql.size >= CACHE_MAX) bySql.delete(bySql.keys().next().value!);
    byMask = new Map();
    bySql.set(sql, byMask);
  }
  let hit = byMask.get(mask);
  if (!hit) {
    let out = "";
    let at = 0;
    const columns = new Map<string, string>();
    for (const p of placeholders(sql)) {
      const w = mask[p.index - 1];
      if (w !== "i" && w !== "r") continue;
      const token = sql.slice(p.start, p.end);
      const wrapped = w === "i" ? INTEGER_WRAP(token) : REAL_WRAP(token);
      out += sql.slice(at, p.start) + wrapped;
      at = p.end;
      columns.set(wrapped, token);
    }
    out += sql.slice(at);
    hit = { sql: out, columns };
    if (byMask.size >= 16) byMask.delete(byMask.keys().next().value!);
    byMask.set(mask, hit);
  }
  return { sql: hit.sql, params: bound, columns: hit.columns };
}

/** bindTyped が包んだ引数の文面を、結果の列名から戻す。 */
export function restoreColumns(columns: string[], map: Map<string, string> | null): string[] {
  if (!map || map.size === 0) return columns;
  return columns.map((c) => {
    let name = c;
    for (const [wrapped, token] of map) if (name.includes(wrapped)) name = name.split(wrapped).join(token);
    return name;
  });
}

/**
 * 2^53 を超える INTEGER を保存しようとした書き込みの誤り (計画書の K1、2026-11-13 の持ち主の決定)。D∞ の値は JS の数で、
 * DO の SQLite も読み出しで JS の数にするので、その値は正確に運べない。値で決まる拒否なので、置き場所に依らない。
 */
export const wideIntegerError = (where: string): SqlError =>
  new SqlError(`unsupported: an INTEGER beyond ±${Number.MAX_SAFE_INTEGER} (2^53 - 1) in ${where} cannot be stored exactly; store such values (for example 64-bit ids) as TEXT`);

/** 値を、その typeof と一緒に読む文。`expr` は 1 つの値の式である。結果は [typeof, 値] の 1 行になる (fromTyped で戻す)。 */
export const typedScalarSql = (expr: string): string =>
  `SELECT typeof("__dinf_v"), "__dinf_v" FROM (SELECT ${expr} AS "__dinf_v")`;

/**
 * 読んだか計算した値を、束縛し直してよい値にする。Worker が結果を引数に戻して書く場所は、すべてここを通す
 * (INSERT … SELECT の行、VALUES の中のサブクエリ、計画が計算するキーの式)。読んだ結果では、整数の値の REAL (5.0) が JS の 5 に
 * なる (DO の SQLite は読み出しで区別しない) ので、typeof が real なら印を付ける。2^53 を超える整数は、桁が落ちているので断る
 * (2026-11-13 の Codex の 2 回目の見直し、指摘 3、4)。
 */
export function fromTyped(v: Value, t: unknown, where = "the statement"): Value {
  if (t === "real" && typeof v === "number") return realOf(v);
  if (t === "integer" && typeof v === "number" && !Number.isSafeInteger(v)) throw wideIntegerError(where);
  return v;
}

// ---- 要素とタプル (docs/design-values.md の「値の型と符号」。値の作り直しの段 1) ----
//
// 段 2 から、行イメージ (src/shard/rows.ts) がタプルを使う。結果の列の要素の式 (selectElemSql、returningElemSql) は、段 3 で
// 型つきの読みが使い始める。
//
// 値 1 つを、JSON にもドライバの結果にも置ける形にしたものを「要素」と呼ぶ。先頭の 1 文字が格納の型で、後ろがその値である。
// INTEGER は 10 進の数字 (`i9223372036854775807`)、TEXT はその文字列 (`tabc`)、REAL は quote() の文字列 (`r5.0`)、
// BLOB は 16 進 (`b00FF`)、NULL は null。SQL の式でも JS でも同じ形に作れるので、DO の SQLite が INTEGER を丸めた数で返しても、
// 64 ビットの整数を失わない。行を、表定義の列の順に並べた要素の配列にしたものが「タプル」である。

/**
 * 作り直しの後の値。JS の型が SQLite の格納の型である。bigint は INTEGER、number は REAL (整数の値でも REAL)。
 * 段 3 で `Value` (src/types.ts) がこの形になり、この型は要らなくなる。
 */
export type TypedValue = null | bigint | number | string | Uint8Array;

/** 要素。値 1 つを文字列にしたもの。NULL は null。 */
export type Elem = string | null;

/** タプル。表定義の列の順に並べた要素。列名は持たない。 */
export type Tuple = Elem[];

const INT64_MIN = -(2n ** 63n);
const INT64_MAX = 2n ** 63n - 1n;
const upperHex = (b: Uint8Array) => {
  let s = "";
  for (const x of b) s += (x < 16 ? "0" : "") + x.toString(16).toUpperCase();
  return s;
};
const fromHex = (s: string) => {
  if (s.length % 2 !== 0 || /[^0-9A-Fa-f]/.test(s)) throw new Error(`not an element: the BLOB ${s.slice(0, 20)} is not hexadecimal`);
  const out = new Uint8Array(s.length / 2);
  for (let i = 0; i < out.length; i++) out[i] = parseInt(s.slice(2 * i, 2 * i + 2), 16);
  return out;
};

/**
 * REAL を、SQLite が REAL の literal として読む文字列にする。JS の最短の表記に、小数点も指数もなければ `.0` を足す。
 * 無限大は、quote() と同じ `9.0e+999` にする。SQL が作る要素 (quote() の表記) とは文字が違うことがあるが、どちらも
 * `Number()` で同じ double に戻る。-0.0 は 0.0 と区別しない (quote() も `0.0` と書く)。
 */
function realText(x: number): string {
  if (x === Infinity) return "9.0e+999";
  if (x === -Infinity) return "-9.0e+999";
  const s = String(x === 0 ? 0 : x);
  return /[.e]/.test(s) ? s : `${s}.0`;
}

/** 値を要素にする。NaN は、SQLite が NULL として束縛するので、NULL にする。 */
export function encodeElem(v: TypedValue): Elem {
  if (v === null) return null;
  if (typeof v === "bigint") {
    if (v < INT64_MIN || v > INT64_MAX) throw new RangeError(`the integer ${v} does not fit in 64 bits`);
    return `i${v}`;
  }
  if (typeof v === "number") return Number.isNaN(v) ? null : `r${realText(v)}`;
  if (typeof v === "string") return `t${v}`;
  return `b${upperHex(v)}`;
}

/**
 * 要素を値に戻す。型つきの読みの結果の列も、これで読む。そこでは、REAL と BLOB がドライバの値のまま届く
 * (JS の数は REAL、BLOB は BLOB)。印のない文字列は要素ではないので、投げる。包み忘れた文の結果を、黙って TEXT として読まない。
 */
export function decodeElem(e: Elem | number | Uint8Array | ArrayBuffer): TypedValue {
  if (e === null) return null;
  if (typeof e === "number") return e;
  if (typeof e !== "string") return e instanceof Uint8Array ? e : new Uint8Array(e);
  const rest = e.slice(1);
  switch (e[0]) {
    case "i":
      // BigInt() は、空の文字列を 0 に、16 進や前後の空白のある文字列も数に読む。要素の INTEGER は 10 進の数字だけである。
      if (!INTEGER_TEXT.test(rest)) break;
      return BigInt(rest);
    case "t": return rest;
    case "r": {
      // quote() は、元の double に戻せる桁数で書く。JS の Number() は正確に丸めるので、同じ double になる
      // (test/workerd-limits.test.ts が、3 つのエンジンで 2 万個の double を確かめている)。`9.0e+999` は Infinity になる。
      // Number() は、空の文字列を 0 に、16 進や前後の空白のある文字列も数に読む。要素の REAL は 10 進の小数か指数の表記だけである。
      if (!REAL_TEXT.test(rest)) break;
      return Number(rest);
    }
    case "b": return fromHex(rest);
  }
  throw new Error(`not an element: ${JSON.stringify(e.slice(0, 20))}`);
}
const INTEGER_TEXT = /^-?[0-9]+$/;
const REAL_TEXT = /^-?[0-9]+(\.[0-9]+)?(e[+-]?[0-9]+)?$/;

// 要素を作る SQL の式。c は列の参照である (`"c0"`、`new."a"`)。式の中で 2 回以上参照するので、評価のたびに値が変わる式
// (`random()` など) を渡してはならない。そういう式は、呼ぶ側が `FROM (SELECT e AS "x" LIMIT -1 OFFSET 0)` で 1 回の評価に
// 固めてから、その列を渡す (設計書の「シャードからの読み」と「利用者の RETURNING」)。

/**
 * 結果の列 (SELECT) の要素の式。INTEGER と TEXT に印を付け、REAL と BLOB は素のまま返す。ドライバが返す JS の型は 4 つ
 * (null、数、文字列、BLOB) なので、INTEGER と TEXT を印つきの文字列にすれば、残りは JS の型で見分けられる。
 * node:sqlite と sql.js のドライバは、結果の TEXT を最初の NUL で切って返す (DO のドライバは切らない)。この式の結果を
 * その 2 つから読むと、NUL を含む TEXT が切れる。その 2 つからは、タプル (JSON) で読む。
 */
export const selectElemSql = (c: string): string =>
  `CASE typeof(${c}) WHEN 'integer' THEN 'i'||${c} WHEN 'text' THEN 't'||${c} ELSE ${c} END`;

/**
 * 結果の列 (RETURNING) の要素の式。REAL にも印を付ける。INSERT の RETURNING で、整数を入れた REAL の列を素のまま返すと、
 * ドライバには INTEGER の 5 として届く (typeof は real と答える)。`'r' || quote(c)` は `r5.0` を返す。
 */
export const returningElemSql = (c: string): string =>
  `CASE typeof(${c}) WHEN 'integer' THEN 'i'||${c} WHEN 'text' THEN 't'||${c} WHEN 'real' THEN 'r'||quote(${c}) ELSE ${c} END`;

/**
 * JSON の中 (タプル) の要素の式。印は typeof の先頭の 1 文字である。NULL は `'n' || NULL` で NULL になる。
 * REAL は quote() で書く (json_array は REAL を 15 桁に丸める)。TEXT は印を前に付けてそのまま運ぶ (quote() は TEXT を最初の NUL で切る)。
 */
export const jsonElemSql = (c: string): string =>
  `substr(typeof(${c}),1,1) || CASE typeof(${c}) WHEN 'real' THEN quote(${c}) WHEN 'blob' THEN hex(${c}) ELSE ${c} END`;

/**
 * SQL 関数の引数の上限。DO の SQLite の公式の表の値である。手元の workerd は 127 個まで受け付けるが (test/workerd-limits.test.ts)、
 * 本番が 32 で断るかは確かめられないので、公式の値に合わせる。
 */
export const MAX_FUNCTION_ARGS = 32;

/**
 * タプルを作る SQL の式。cols は、表定義の列の順に並べた列の参照である。
 * 列が 32 を超えると、32 個ずつの json_array を json_array で包む。読む側 (parseTuple) が 1 段だけ平らにする。
 * 入れ子は SQL から JS へ渡す間だけの形で、保存する形はいつも平らな配列である。
 */
export function tupleSql(cols: string[]): string {
  const array = (items: string[]) => `json_array(${items.join(", ")})`;
  if (cols.length <= MAX_FUNCTION_ARGS) return array(cols.map(jsonElemSql));
  // 入れ子は 1 段だけにする。表の列の上限は 100 なので、足りる。
  if (cols.length > MAX_FUNCTION_ARGS * MAX_FUNCTION_ARGS) throw new Error(`a tuple of ${cols.length} elements has too many columns`);
  const chunks: string[] = [];
  for (let i = 0; i < cols.length; i += MAX_FUNCTION_ARGS) chunks.push(array(cols.slice(i, i + MAX_FUNCTION_ARGS).map(jsonElemSql)));
  return array(chunks);
}

/**
 * SQL が作ったタプルの JSON を読む。tupleSql の入れ子を 1 段だけ平らにする。
 * 要素は文字列か null なので、配列が混ざっていれば入れ子である。それ以外の形は、タプルではないので投げる。
 */
export function parseTuple(json: string): Tuple {
  const x: unknown = JSON.parse(json);
  if (!Array.isArray(x)) throw new Error(`not a tuple: ${json.slice(0, 40)}`);
  const isElem = (e: unknown): e is Elem => e === null || typeof e === "string";
  const out: Tuple = [];
  for (const item of x as unknown[]) {
    if (isElem(item)) out.push(item);
    else if (Array.isArray(item) && item.every(isElem)) out.push(...(item as Elem[]));
    else throw new Error(`not a tuple: ${json.slice(0, 40)}`);
  }
  return out;
}

/** 値の並びをタプルにする。 */
export const encodeTuple = (values: TypedValue[]): Tuple => values.map(encodeElem);

/** タプルを値の並びに戻す。 */
export const decodeTuple = (t: Tuple): TypedValue[] => t.map(decodeElem);

/**
 * 型のある値を、今の `Value` にする (typedOf の逆。値の作り直しの段 2 の橋)。行イメージのタプルを値に戻すときは、どれもここを通す。
 * bigint は INTEGER なので、JS の数にする。number は REAL なので、整数の値なら印を付ける。
 * 絶対値が 2^53 以上の INTEGER は、今の Value では正確に持てないので、K1 と同じ誤りにする (where は誤りに書く場所、表の名前)。
 * 段 3 で `Value` が型のある値になると、この橋は要らなくなる。
 */
export function fromTypedValue(v: TypedValue, where: string): Value {
  if (typeof v === "bigint") {
    if (v > MAX_EXACT || v < -MAX_EXACT) throw wideIntegerError(where);
    return Number(v);
  }
  if (typeof v === "number") return realOf(v);
  return v;
}
const MAX_EXACT = BigInt(Number.MAX_SAFE_INTEGER);

/**
 * 今の `Value` を、型のある値にする。今の決まりでは、64 ビットに収まる整数の JS の数は INTEGER、印つきの値 (`Real`) と
 * ほかの数は REAL である。段 3 で `Value` が型のある値になると、この橋は要らなくなる。
 */
export function typedOf(v: Value): TypedValue {
  if (isReal(v)) return v.real;
  if (typeof v === "number") return isIntegerValue(v) ? BigInt(v) : v;
  return v;
}
