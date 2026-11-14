// パーサの突き合わせの道具。
//
// 2026-11-14 に、GPL のパーサ (sql-parser-cst) を自前のパーサ (src/sql/parser.ts) に入れ替えた。計画の組み立て (plan.ts) と
// DDL の解釈 (ddl.ts) は、構文木の節の種類と欄をそのまま読むので、入れ替えで木の形が変わると、文の経路が黙って変わる。
// ここでは、同じ文を前のパーサ (test/parser-old.ts) と今のパーサで解析し、木の形、節ごとの文面、引数の束縛、DDL の解釈を比べる。
// 文の集まりは、試験の全部が解析した文 (PARSER_CORPUS で書き出したもの)、sqllogictest のファイル、文法を一通り踏む一覧である。
import { readdirSync, readFileSync } from "node:fs";
import { DatabaseSync } from "node:sqlite";
import * as now from "../src/sql/cst";
import { tokenize } from "../src/sql/lexer";
import type { SchemaView } from "../src/sql/ddl";
import type { TableDef, Value } from "../src/types";

// eslint-disable-next-line @typescript-eslint/no-explicit-any
type Node = any;
export type Cst = Pick<typeof now, "parseStatements" | "text" | "walk" | "paramsIn" | "bindParams" | "ident">;
/** 前の経路。解析の前に文面を書き換えていた (rewrite)。 */
export type OldCst = Cst & { rewrite(source: string): string };

/** 前のパーサ。sql-parser-cst が入っていなければ null。 */
export async function loadOld(): Promise<OldCst | null> {
  try {
    return (await import("./parser-old")) as unknown as OldCst;
  } catch {
    return null;
  }
}

// ---- 文の集まり ----

/** PARSER_CORPUS で書き出したディレクトリ (プロセスごとの、1 行 1 文の JSON) を読む。 */
export function corpusDir(dir: string): string[] {
  const out: string[] = [];
  for (const f of readdirSync(dir)) {
    if (!f.endsWith(".jsonl")) continue;
    for (const line of readFileSync(`${dir}/${f}`, "utf8").split("\n")) if (line) out.push(JSON.parse(line) as string);
  }
  return out;
}

/** sqllogictest のファイルから、statement と query の SQL を取り出す。 */
export function sltStatements(path: string): string[] {
  const lines = readFileSync(path, "utf8").split("\n");
  const out: string[] = [];
  for (let i = 0; i < lines.length; ) {
    const kw = lines[i++]!.trim().split(/\s+/)[0];
    if (kw !== "statement" && kw !== "query") continue;
    const body: string[] = [];
    while (i < lines.length && lines[i]!.trim() !== "" && lines[i]!.trim() !== "----") body.push(lines[i++]!);
    out.push(body.join("\n"));
  }
  return out;
}

/**
 * 文のトークンの境目に、空白か注釈を差し込んだ文。差し込む文面は、トークンの番号ごとに pick が決める。
 * 注釈がどの節に付くかで、節の文面が変わる (行末までの注釈が末尾に残ると、括弧で包んだ文が壊れる)。
 */
export function withTrivia(source: string, pick: (i: number) => string): string | null {
  let toks;
  try {
    toks = tokenize(source);
  } catch {
    return null;
  }
  let out = "";
  toks.forEach((t, i) => {
    out += t.ws + (t.kind === "eof" ? "" : pick(i)) + t.text;
  });
  return out;
}

/**
 * 乱数で作る式。seed が同じなら同じ式になる。
 *   separate   前のパーサと優先順位の違う組 (ビットの演算子どうし、= の仲間と < の仲間) を、1 つの式に片方しか入れない。
 *   evaluable  表 t(a, b, c, q) の上で値を求められる式にする (引数と集約を入れない。JSON の演算子は、値によって誤りになるので入れない)。
 */
export function randomExpression(seed: number, opts: { separate?: boolean; evaluable?: boolean } = {}): string {
  let a = seed >>> 0;
  const r = (): number => {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 2 ** 32;
  };
  const pick = <T,>(xs: T[]): T => xs[Math.floor(r() * xs.length)]!;
  const bits = ["&", "|", "<<", ">>"];
  const equal = ["=", "==", "!=", "<>", "IS", "IS NOT"];
  const less = ["<", "<=", ">", ">="];
  // separate のとき: 大小の演算子を使う式には、= の仲間 (= IS LIKE GLOB) を入れない。逆も同じ。
  const relational = r() < 0.5;
  const equality = !opts.separate || !relational;
  const compare = opts.separate ? (relational ? less : equal) : [...equal, ...less];
  const binary = ["||", "*", "/", "%", "+", "-", ...(opts.separate ? [pick(bits)] : bits), ...compare, "AND", "OR", "AND", "OR", ...(opts.evaluable ? [] : ["->", "->>"])];
  const atoms = opts.evaluable
    ? ["a", "b", "t.c", "\"q\"", "0", "1", "2", "3", "2.5", "'x'", "'10'", "NULL", "x'00'", "TRUE", "abs(a)", "max(a, b)", "CAST(a AS INT)", "(SELECT 1)"]
    : ["a", "b", "t.c", "1", "2.5", "'x'", "NULL", "?", ":p", "x'00'", "TRUE", "f(a)", "count(*)", "max(a, b)", "CAST(a AS INT)", "(SELECT 1)", "\"q\""];
  const atom = (): string => pick(atoms);
  const expr = (depth: number): string => {
    if (depth <= 0 || r() < 0.2) return atom();
    switch (Math.floor(r() * 12)) {
      case 0: {
        // `--` は行末までの注釈になるので、負号を重ねるときは間を空ける。
        const op = pick(["-", "+", "~", "NOT "]);
        const e = expr(depth - 1);
        return op === "-" && e.startsWith("-") ? `- ${e}` : `${op}${e}`;
      }
      case 1: return `(${expr(depth - 1)})`;
      case 2: return `${expr(depth - 1)} ${pick(["ISNULL", "NOTNULL", "NOT NULL", "COLLATE NOCASE", ...(equality ? ["IS NULL", "IS NOT NULL"] : [])])}`;
      case 3: return `${expr(depth - 1)} ${pick(["", "NOT "])}BETWEEN ${atom()} AND ${atom()}`;
      case 4: return `${expr(depth - 1)} ${pick(["", "NOT "])}IN (${atom()}, ${atom()})`;
      case 5: return equality ? `${expr(depth - 1)} ${pick(["", "NOT "])}${pick(["LIKE", "GLOB"])} ${atom()}${r() < 0.2 ? " ESCAPE '!'" : ""}` : atom();
      case 6: return `CASE WHEN ${expr(depth - 1)} THEN ${expr(depth - 1)} ELSE ${atom()} END`;
      case 7: return `coalesce(${expr(depth - 1)}, ${expr(depth - 1)})`;
      default: return `${expr(depth - 1)} ${pick(binary)} ${expr(depth - 1)}`;
    }
  };
  return expr(4);
}

// ---- SQLite の構文の判定 ----

const sqlite = new DatabaseSync(":memory:");
const SYNTAX = /syntax error|incomplete input|unrecognized token/;

/** 文面を、SQLite が構文として受け付けるか。表がないなどの、構文より後ろの誤りは、受け付けたものとして数える。 */
export function sqliteAccepts(statement: string): boolean {
  try {
    sqlite.prepare(statement);
    return true;
  } catch (e) {
    return !SYNTAX.test(e instanceof Error ? e.message : String(e));
  }
}

/** 文を `;` で分ける (文字列と注釈の中の `;` と、trigger の本体の `;` は分けない)。パーサが断った文を、SQLite に 1 文ずつ見せるのに使う。 */
export function splitStatements(source: string): string[] | null {
  let toks;
  try {
    toks = tokenize(source);
  } catch {
    return null;
  }
  const out: string[] = [];
  let from = 0;
  let trigger = false;
  let first = true;
  for (const [i, t] of toks.entries()) {
    if (first && t.kind === "word") {
      first = false;
      trigger = t.upper === "CREATE" && toks.slice(i + 1, i + 3).some((x) => x.upper === "TRIGGER");
    }
    const end = t.kind === "eof" || (t.kind === "op" && t.text === ";" && (!trigger || toks[i - 1]?.upper === "END"));
    if (!end) continue;
    const piece = source.slice(from, t.start).trim();
    if (piece) out.push(piece);
    from = t.end;
    first = true;
    trigger = false;
  }
  return out;
}

// ---- 木の比べ方 ----

const SKIP = new Set(["range", "leading", "trailing"]);
const isLeaf = (n: Node): boolean => typeof n.text === "string";

/** 文面の両端から、空白と注釈を除く。 */
export function stripEdgeTrivia(s: string): string {
  try {
    const toks = tokenize(s);
    if (toks.length < 2) return "";
    return s.slice(toks[0]!.start, toks[toks.length - 2]!.end);
  } catch {
    return s.trim();
  }
}

/** 文面から、空白と注釈を全部除く。差し込んだ空白と注釈を無視して比べるのに使う。 */
export function stripAllTrivia(s: string): string {
  try {
    return tokenize(s).map((t) => t.text).join(" ");
  } catch {
    return s;
  }
}

export interface TreeDiff {
  /** 木の形の違い。最初に見つけた場所。 */
  shape?: string;
  /** 節の文面の違い (両端の注釈を除いても違うもの)。 */
  text?: string;
  /** 節の文面が、両端の注釈の有無だけで違う節の数。 */
  edgeComments: number;
  /** 引数の節の位置の違い。 */
  range?: string;
}

/**
 * 2 つの木を比べる。range、leading、trailing は比べず、値が undefined の欄は無い欄と同じに扱う。
 * 葉でない節は、文面も比べる (計画の組み立ては、条件や句を節ごとに文面に戻して、シャードへ送る文を作る)。
 */
export function diffTrees(a: Node, b: Node, old: Cst, texts: boolean): TreeDiff {
  const out: TreeDiff = { edgeComments: 0 };
  const visit = (x: Node, y: Node, path: string): void => {
    if (out.shape) return;
    if (x === undefined || x === null || y === undefined || y === null) {
      if (x !== y) out.shape = `${path}: ${describe(x)} vs ${describe(y)}`;
      return;
    }
    if (typeof x !== "object" || typeof y !== "object") {
      if (x !== y) out.shape = `${path}: ${describe(x)} vs ${describe(y)}`;
      return;
    }
    if (Array.isArray(x) || Array.isArray(y)) {
      if (!Array.isArray(x) || !Array.isArray(y) || x.length !== y.length) {
        out.shape = `${path}: ${describe(x)} vs ${describe(y)}`;
        return;
      }
      x.forEach((e, i) => visit(e, y[i], `${path}[${i}]`));
      return;
    }
    if (x.type !== y.type) {
      out.shape = `${path}: ${describe(x)} vs ${describe(y)}`;
      return;
    }
    const keys = new Set([...Object.keys(x), ...Object.keys(y)].filter((k) => !SKIP.has(k)));
    for (const k of keys) visit(x[k], y[k], `${path}.${k}`);
    if (out.shape) return;
    if (x.type === "parameter" && (x.range[0] !== y.range[0] || x.range[1] !== y.range[1]) && !out.range) {
      out.range = `${path}: ${JSON.stringify(x.range)} vs ${JSON.stringify(y.range)}`;
    }
    if (texts && x.type && !isLeaf(x)) {
      const tx = old.text(x);
      const ty = now.text(y);
      if (tx !== ty) {
        if (stripEdgeTrivia(tx) === ty) out.edgeComments++;
        else out.text ??= `${path} (${x.type}): ${JSON.stringify(tx)} vs ${JSON.stringify(ty)}`;
      }
    }
  };
  visit(a, b, "$");
  return out;
}

function describe(n: Node): string {
  if (n === undefined) return "(none)";
  if (n === null || typeof n !== "object") return JSON.stringify(n);
  if (Array.isArray(n)) return `[${n.map(describe).join(", ")}]`;
  if (!n.type) return "{}";
  return typeof n.text === "string" ? `${n.type}(${n.text})` : n.type;
}

// ---- 引数の束縛 ----

/** 引数を束縛した結果 (値の並び、引数の節の番号の並び、束縛した後の文面)。 */
export function bound(cst: Cst, stmt: Node, named: boolean): string {
  const names = cst.paramsIn(stmt).map((p: Node) => p.text as string);
  const params: Value[] | Record<string, Value> = named
    ? Object.fromEntries(names.filter((n) => !n.startsWith("?")).map((n, i) => [i % 2 ? n : n.slice(1), `v${i}`]))
    : Array.from({ length: names.length + 2 }, (_v, i) => i + 100);
  const values = cst.bindParams(stmt, params);
  return JSON.stringify({ values, order: cst.paramsIn(stmt).map((p: Node) => p._i), text: stripEdgeTrivia(cst.text(stmt)) });
}

// ---- DDL の解釈 ----

/** DDL の文が名指す表、index、view が、ちょうど在ることにした表定義。parseDdl の本体まで進ませるためである。 */
export function stubSchema(stmt: Node): SchemaView {
  const schema: SchemaView = { tables: {}, views: {}, indexes: {} };
  const names = new Set<string>();
  now.walk(stmt, (x) => {
    if (x.type === "identifier") names.add(now.ident(x));
  });
  const table = (name: string): void => {
    const columns = ["id", ...[...names].filter((n) => n !== "id")];
    const def: TableDef = {
      name, columns, pk: ["id"], shardKey: ["id"], uniques: [], globalIndexes: [], implicitRowid: false, rowidAlias: "id",
      skAffinity: ["INTEGER"], affinity: Object.fromEntries(columns.map((c) => [c, "TEXT" as const])), collated: [], collation: {}, defaults: [],
    };
    schema.tables[name] = def;
  };
  const nameOf = (n: Node): string | undefined => (n?.type === "member_expr" ? now.ident(n.property) : n ? now.ident(n) : undefined);
  switch (stmt.type) {
    case "create_index_stmt":
    case "alter_table_stmt":
      if (nameOf(stmt.table)) table(nameOf(stmt.table)!);
      break;
    case "drop_table_stmt":
      for (const t of stmt.tables.items) if (nameOf(t)) table(nameOf(t)!);
      break;
    case "drop_index_stmt":
      table("t");
      schema.indexes[now.ident(stmt.indexes.items[0])] = { table: "t", global: false };
      break;
    case "drop_view_stmt":
      schema.views[now.ident(stmt.views.items[0])] = "CREATE VIEW v AS SELECT 1";
      break;
    default:
      break;
  }
  return schema;
}

/** 結果か、例外の文言。 */
export function outcome(f: () => unknown): string {
  try {
    return JSON.stringify(f());
  } catch (e) {
    return `error: ${e instanceof Error ? e.message : String(e)}`;
  }
}
