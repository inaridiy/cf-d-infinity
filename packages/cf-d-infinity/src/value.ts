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
import type { Value } from "./types";

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
