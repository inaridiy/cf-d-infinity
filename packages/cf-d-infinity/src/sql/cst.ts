// sql-parser-cst の薄いラッパー。文の意味は解釈せず、経路の決定に要る情報だけを取り出す。
import { parse, show } from "sql-parser-cst";
import type { Affinity, Value } from "../types";
import { SqlError } from "../types";

// 公開 API にない内部の予約語表を直接直す。
import { sqliteKeywords } from "sql-parser-cst/lib/keywords/sqlite.keywords.js";

// eslint-disable-next-line @typescript-eslint/no-explicit-any
export type Node = any;

/**
 * SQLite が識別子として許す語。パーサは多くを予約語として拒否するので外す。
 * 列名の plan や action のように普通のスキーマで使われる語が通らないと、置き換えの障害になる。
 * 一覧は SQLite の parse.y の %fallback ID である。
 */
const FALLBACK_ID = `ABORT ACTION AFTER ALWAYS ANALYZE ASC ATTACH BEFORE BEGIN BY CASCADE CAST COLUMN CONFLICT
  CURRENT CURRENT_DATE CURRENT_TIME CURRENT_TIMESTAMP DATABASE DEFERRED DESC DETACH DO EACH END EXCLUDE
  EXCLUSIVE EXPLAIN FAIL FILTER FIRST FOLLOWING FOR GENERATED GLOB GROUPS IF IGNORE IMMEDIATE INITIALLY
  INSTEAD KEY LAST LIKE MATCH MATERIALIZED NO NULLS OF OFFSET OTHERS OVER PARTITION PLAN PRAGMA
  PRECEDING QUERY RAISE RANGE RECURSIVE REGEXP REINDEX RELEASE RENAME REPLACE RESTRICT ROLLBACK ROW ROWS
  SAVEPOINT TEMP TEMPORARY TIES TRIGGER UNBOUNDED VACUUM VIEW VIRTUAL WINDOW WITH WITHOUT`.split(/\s+/);
for (const k of FALLBACK_ID) delete (sqliteKeywords as Record<string, boolean>)[k];

/**
 * 結合の語 (LEFT など) は SQLite では識別子にも使えるが、パーサの予約語から外すと
 * `a LEFT JOIN b` の LEFT が別名に読まれて内部結合に化ける。そこで予約語のまま残し、
 * 後ろに結合が続かないものだけを引用符で囲む。
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
        i = j; // `COUNT(ALL x)` の ALL は既定と同じ意味で、パーサが読めない
        continue;
      }
      const empty = /^IN$/i.test(word) ? /^\s*\(\s*\)/.exec(sql.slice(j)) : null;
      if (empty) {
        // `x IN ()` は SQLite の拡張で、パーサが読めない。常に偽の同じ意味の式へ置き換える。
        out += "IN (SELECT 1 WHERE 0)";
        i = j + empty[0].length;
        continue;
      }
      out += JOIN_WORD.test(word) && !FOLLOWS_JOIN.test(sql.slice(j)) ? `"${word}"` : word;
      i = j;
    } else {
      out += ch === "\r" ? " " : ch; // パーサは CR を空白として読めない
      i++;
    }
  }
  return out;
}

const OPTIONS = {
  dialect: "sqlite",
  includeRange: true,
  includeComments: true,
  includeNewlines: true,
  includeSpaces: true,
  paramTypes: ["?", "?nr", ":name", "@name", "$name"],
} as const;

export type Params = Value[] | Record<string, Value>;

export function parseStatements(source: string): Node[] {
  try {
    return (parse(preprocess(source), OPTIONS as never).statements as Node[]).filter((s) => s.type !== "empty");
  } catch (e) {
    throw new SqlError(`near syntax error: ${e instanceof Error ? e.message.split("\n")[0] : e}`);
  }
}

export const text = (n: Node): string => show(n).trim();

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
export function normalize(v: Value, a: Affinity): Value {
  if (typeof v === "string" && (a === "INTEGER" || a === "REAL" || a === "NUMERIC")) {
    const t = v.trim();
    if (t !== "" && Number.isFinite(Number(t))) return Number(t);
    return v;
  }
  if (typeof v === "number" && a === "TEXT") return String(v);
  return v;
}

/** 定数として評価できるなら値を返す。 */
export function constant(n: Node, values: Value[]): { value: Value } | null {
  switch (n?.type) {
    case "number_literal": return { value: n.value };
    case "string_literal": return { value: n.value };
    case "null_literal": return { value: null };
    case "boolean_literal": return { value: n.value ? 1 : 0 };
    case "blob_literal": return { value: Uint8Array.from(n.value) };
    case "parameter": return { value: values[n._i] ?? null };
    case "paren_expr": return n.expr?.type === "list_expr" ? null : constant(n.expr, values);
    case "prefix_op_expr": {
      if (n.operator !== "-" && n.operator !== "+") return null;
      const inner = constant(n.expr, values);
      if (!inner || typeof inner.value !== "number") return null;
      return { value: n.operator === "-" ? -inner.value : inner.value };
    }
    default: return null;
  }
}
