// 構文木の入口。文の意味は解釈せず、経路の決定に要る情報だけを取り出す。
// 解析は自前のパーサ (parser.ts)、文面への出し直しは printer.ts が行う。
import type { Affinity, Value } from "../types";
import { isReal, realOf } from "../value";
import { parseSql, type Node } from "./parser";
import { print } from "./printer";

export type { Node };

/**
 * 結合の語 (LEFT など) は SQLite では識別子にも使えるが、識別子として読むと `a LEFT JOIN b` の LEFT が別名に読まれて
 * 内部結合に化ける。そこでパーサは予約語として扱い (parser.ts の RESERVED)、後ろに結合が続かないものだけを、
 * 解析の前に引用符で囲む。
 *
 * 後ろに続くかどうかは文面で見るので、間に注釈があると見誤る: `a LEFT /* c *\/ JOIN b` の LEFT を引用符で囲み、
 * 内部結合にしてしまう (未解決。test/open/join-word-before-comment.test.ts)。この書き換えは前のパーサ (sql-parser-cst) の
 * 頃からのものである。パーサが結合の語を SQLite と同じ位置で識別子として読めば、書き換えは要らなくなる。
 */
const JOIN_WORD = /^(LEFT|RIGHT|FULL|INNER|OUTER|CROSS|NATURAL)$/i;
const FOLLOWS_JOIN = /^\s*(JOIN|OUTER|INNER|CROSS|LEFT|RIGHT|FULL)\b/i;

function preprocess(sql: string): string {
  let out = "";
  for (let i = 0; i < sql.length; ) {
    const ch = sql[i]!;
    if (ch === "'" || ch === '"' || ch === "`" || ch === "[") {
      const close = ch === "[" ? "]" : ch;
      let j = i + 1;
      while (j < sql.length && (sql[j] !== close || (close !== "]" && sql[j + 1] === close && ++j))) j++;
      out += sql.slice(i, j + 1);
      i = j + 1;
    } else if (sql.startsWith("--", i) || sql.startsWith("/*", i)) {
      const end = sql.startsWith("--", i) ? sql.indexOf("\n", i) : sql.indexOf("*/", i) + 1;
      const stop = end <= 0 ? sql.length : end + 1;
      out += sql.slice(i, stop);
      i = stop;
    } else if (/[A-Za-z_]/.test(ch)) {
      let j = i;
      while (j < sql.length && /[A-Za-z0-9_$]/.test(sql[j]!)) j++;
      const word = sql.slice(i, j);
      if (/^ALL$/i.test(word) && /\(\s*$/.test(out)) {
        i = j; // `COUNT(ALL x)` の ALL は既定と同じ意味なので、落とす
        continue;
      }
      const empty = /^IN$/i.test(word) ? /^\s*\(\s*\)/.exec(sql.slice(j)) : null;
      if (empty) {
        // `x IN ()` は SQLite の拡張である。常に偽の同じ意味の式へ置き換える。パーサは空の並びを読まない (parser.ts の inOperand)。
        out += "IN (SELECT 1 WHERE 0)";
        i = j + empty[0].length;
        continue;
      }
      out += JOIN_WORD.test(word) && !FOLLOWS_JOIN.test(sql.slice(j)) ? `"${word}"` : word;
      i = j;
    } else {
      out += ch === "\r" ? " " : ch; // CR は空白に揃える
      i++;
    }
  }
  return out;
}

export type Params = Value[] | Record<string, Value>;

/**
 * 試験が、解析に渡った文をすべて見るための口。本番では誰も入れない。
 * パーサを入れ替えるときの突き合わせ (test/parser-oracle.test.ts) は、試験の全部が解析した文を、ここから集めて使う。
 */
export const parseObserver: { seen?: (source: string) => void } = {};

export function parseStatements(source: string): Node[] {
  parseObserver.seen?.(source);
  return parseSql(preprocess(source));
}

/** 節の文面。節の外側の空白と注釈は付かない。 */
export const text = (n: Node): string => print(n);

export function walk(n: Node, f: (x: Node) => void): void {
  if (!n || typeof n !== "object") return;
  if (Array.isArray(n)) {
    for (const x of n) walk(x, f);
    return;
  }
  if (n.type) f(n);
  for (const k of Object.keys(n)) {
    if (k === "range" || k === "leading" || k === "trailing") continue;
    walk(n[k], f);
  }
}

export const paramsIn = (n: Node): Node[] => {
  const out: Node[] = [];
  walk(n, (x) => {
    if (x.type === "parameter") out.push(x);
  });
  return out.sort((a, b) => a.range[0] - b.range[0]);
};

/**
 * パラメータを全部 `?` に揃えて、ノードに値の位置を記録する。
 * DO の SQL API が位置指定だけを受けるので、名前付きと番号付きをここで解決する。
 */
export function bindParams(stmt: Node, params: Params): Value[] {
  const values: Value[] = [];
  const named = new Map<string, number>();
  const asArray = Array.isArray(params) ? params : null;
  const take = (i: number): number => {
    while (values.length <= i) values.push(asArray ? (asArray[values.length] ?? null) : null);
    return i;
  };
  let next = 0;
  for (const p of paramsIn(stmt)) {
    const t: string = p.text;
    let index: number;
    if (t === "?") index = next++;
    else if (/^\?\d+$/.test(t)) {
      index = Number(t.slice(1)) - 1;
      next = Math.max(next, index + 1);
    } else {
      const known = named.get(t);
      if (known !== undefined) index = known;
      else {
        index = next++;
        named.set(t, index);
      }
      if (!asArray) {
        const rec = params as Record<string, Value>;
        take(index);
        values[index] = rec[t] ?? rec[t.slice(1)] ?? null;
      }
    }
    take(index);
    p._i = index;
    p.text = "?";
  }
  return values;
}

/** ノードの文字列と、その中の `?` に対応する値を順に返す。 */
export function render(n: Node, values: Value[]): { sql: string; params: Value[] } {
  return { sql: text(n), params: paramsIn(n).map((p) => values[p._i] ?? null) };
}

export const ident = (n: Node): string => n.name ?? n.text;

export function affinityOf(type: string | null): Affinity {
  const t = (type ?? "").toUpperCase();
  if (t.includes("INT")) return "INTEGER";
  if (t.includes("CHAR") || t.includes("CLOB") || t.includes("TEXT")) return "TEXT";
  if (t === "" || t.includes("BLOB")) return "BLOB";
  if (t.includes("REAL") || t.includes("FLOA") || t.includes("DOUB")) return "REAL";
  return "NUMERIC";
}

/** 列の型親和性で値を揃える。`id = '1'` と INSERT の 1 を同じシャードへ送るためである。 */

/**
 * 数の literal の値。SQLite は、小数点か指数のある literal と、64 ビットに収まらない整数の literal を REAL にする。
 * パーサの value は JS の数なので、`5.0` は整数の 5 になる。整数の値の REAL は印を付けて返す (src/value.ts)。
 * 付けないと、TEXT の列に入る値のキーが "5" になり、SQLite が入れる "5.0" と違うシャードを指す (2026-11-13 の Codex の指摘 C7)。
 */
function numberLiteral(text: string, value: number): Value {
  if (/^0x/i.test(text)) return value;
  if (/[.eE]/.test(text)) return realOf(value);
  const big = BigInt(text.replaceAll("_", ""));
  return big > 2n ** 63n - 1n ? realOf(value) : value;
}

/** 定数として評価できるなら値を返す。 */
export function constant(n: Node, values: Value[]): { value: Value } | null {
  switch (n?.type) {
    case "number_literal": return { value: numberLiteral(n.text, n.value) };
    case "string_literal": return { value: n.value };
    case "null_literal": return { value: null };
    case "boolean_literal": return { value: n.value ? 1 : 0 };
    case "blob_literal": return { value: Uint8Array.from(n.value) };
    case "parameter": return { value: values[n._i] ?? null };
    case "paren_expr": return n.expr?.type === "list_expr" ? null : constant(n.expr, values);
    case "prefix_op_expr": {
      if (n.operator !== "-" && n.operator !== "+") return null;
      const inner = constant(n.expr, values);
      if (inner && isReal(inner.value)) return { value: n.operator === "-" ? realOf(-inner.value.real) : inner.value };
      if (!inner || typeof inner.value !== "number") return null;
      return { value: n.operator === "-" ? -inner.value : inner.value };
    }
    default: return null;
  }
}
