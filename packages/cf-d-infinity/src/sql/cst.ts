// 構文木の入口。文の意味は解釈せず、経路の決定に要る情報だけを取り出す。
// 解析は自前のパーサ (parser.ts)、文面への出し直しは printer.ts が行う。
import type { Affinity, Value } from "../types";
import { parseSql, type Node } from "./parser";
import { print } from "./printer";

export type { Node };

export type Params = Value[] | Record<string, Value>;

/**
 * 試験が、解析に渡った文をすべて見るための口。本番では誰も入れない。
 * パーサを入れ替えるときの突き合わせ (test/parser-oracle.test.ts) は、試験の全部が解析した文を、ここから集めて使う。
 */
export const parseObserver: { seen?: (source: string) => void } = {};

/**
 * 文を解析する。文面は、書き換えずにそのままパーサへ渡す。
 * 2026-11-14 までは、解析の前に文面を書き換えていた (結合の語を引用符で囲む、`x IN ()` をサブクエリにする、関数の引数の ALL を
 * 落とす、CR を空白にする)。書き換えは字句を知らないので、語の間の注釈で見誤り、結果の列名も SQLite と違っていた。今はどれも
 * パーサが SQLite と同じ場所で読む (parser.ts の JOIN_WORDS、inOperand、call)。
 */
export function parseStatements(source: string): Node[] {
  parseObserver.seen?.(source);
  return parseSql(source);
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

const INT64_MAX = 2n ** 63n - 1n;

/**
 * 数の literal の値 (docs/design-values.md の「型の親和性の変換」)。SQLite は、小数点か指数のある literal と、64 ビットに収まらない
 * 10 進の整数の literal を REAL にし、ほかの整数の literal を INTEGER にする。INTEGER は bigint、REAL は number で返す。
 * 16 進の literal (`0x10`) は、64 ビットの 2 の補数として読む INTEGER である (`0xffffffffffffffff` は -1)。16 桁を超える 16 進の
 * literal は SQLite が断るので、定数としては扱わない (null)。
 */
function numberLiteral(text: string): Value | null {
  const t = text.replaceAll("_", "");
  if (/^0x/i.test(t)) {
    if (t.length - 2 > 16) return null;
    return BigInt.asIntN(64, BigInt(t));
  }
  if (/[.eE]/.test(t)) return Number(t);
  const big = BigInt(t);
  return big > INT64_MAX ? Number(t) : big;
}

/** 定数として評価できるなら値を返す。 */
export function constant(n: Node, values: Value[]): { value: Value } | null {
  switch (n?.type) {
    case "number_literal": {
      const v = numberLiteral(n.text);
      return v === null ? null : { value: v };
    }
    case "string_literal": return { value: n.value };
    case "null_literal": return { value: null };
    case "boolean_literal": return { value: n.value ? 1n : 0n };
    case "blob_literal": return { value: Uint8Array.from(n.value) };
    case "parameter": return { value: values[n._i] ?? null };
    case "paren_expr": return n.expr?.type === "list_expr" ? null : constant(n.expr, values);
    case "prefix_op_expr": {
      if (n.operator !== "-" && n.operator !== "+") return null;
      // `-9223372036854775808` は、符号と数字を 1 つの literal として読む INTEGER である (SQLite と同じ)。数字だけを先に読むと、
      // 64 ビットに収まらないので REAL になる。
      if (n.operator === "-" && n.expr?.type === "number_literal" && /^0*9223372036854775808$/.test(n.expr.text.replaceAll("_", ""))) {
        return { value: -(2n ** 63n) };
      }
      const inner = constant(n.expr, values);
      if (!inner) return null;
      const v = inner.value;
      if (typeof v === "number") return { value: n.operator === "-" ? -v : v };
      if (typeof v !== "bigint") return null;
      if (n.operator === "+") return { value: v };
      // -(-2^63) は 64 ビットに収まらない。SQLite は REAL にするが、ここでは定数として扱わない。
      return v === -(2n ** 63n) ? null : { value: -v };
    }
    default: return null;
  }
}
