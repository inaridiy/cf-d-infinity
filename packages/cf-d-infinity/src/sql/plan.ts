// 文をどこで実行するかを決める。式の意味は解釈しない。
// 1 シャードに収まる文はそのシャードの SQLite へ、それ以外は行を集めて Worker の SQLite へ渡す。
import type { Catalog } from "../meta";
import { ownerOf } from "../routing";
import { encode, fold, q, selectList } from "../shard/rows";
import type { GlobalIndexDef, TableDef, Value, WritePlan } from "../types";
import { SqlError } from "../types";
import { bindParams, constant, ident, normalize, render, text, walk, type Node, type Params } from "./cst";

export type Route =
  | { by: "sk"; sks: string[] }
  | { by: "gidx"; index: GlobalIndexDef; key: string }
  | { by: "all" };

/** シャードから行を集める 1 回の走査。 */
export interface Scan {
  table: TableDef;
  sql: string;
  params: Value[];
  /** 固定された shard key。null なら全シャードを読む。 */
  sks: string[] | null;
  /** 押し下げた条件。取引の検証は、この条件に関わる変更だけを競合にする。 */
  where?: { alias: string; sql: string; params: Value[] };
  /** sks はシャードを選ぶためだけに使い、span はシャードの表全体にする。index 経由の読みで立てる。 */
  wideSpans?: boolean;
}

export interface WriteTarget {
  route: Route;
  sql: string;
  params: Value[];
  write: WritePlan;
  pk: string | null;
  /**
   * 文を shard key に絞らずに送るときの、表ごとの走査。index 経由の UPDATE と DELETE に付く。
   * 文はシャードの表を広く読むので、span も index が挙げた shard key に絞らず、この走査の条件にする。
   */
  wide?: Scan[];
}

export type Plan =
  | {
      kind: "shard"; route: Route; sql: string; params: Value[]; tables: TableDef[]; pk: string | null;
      /** DO の SQLite が拒否する文 (6 項以上の複合 SELECT) を、Worker の SQLite で実行し直すための計画。 */
      wasm?: Extract<Plan, { kind: "gather" }>;
      /** グローバル index が 1 シャード以外に当たったときの実行計画。文をシャードごとに流すと集計が割れる。 */
      fallback?: Extract<Plan, { kind: "gather" }>;
    }
  | { kind: "gather"; scans: Scan[]; sql: string; params: Value[] }
  | { kind: "partial"; scan: Scan; columns: string[]; mergeSql: string; mergeParams: Value[] }
  | { kind: "meta"; sql: string; params: Value[] }
  | {
      kind: "write"; def: TableDef; targets: WriteTarget[]; lastRowid: number | null;
      /** 文が読む全表。サブクエリの表も検証の対象にする。 */
      tables?: TableDef[];
    }
  | { kind: "wasmWrite"; scans: Scan[]; sql: string; params: Value[]; tables: TableDef[] }
  | { kind: "insertSelect"; def: TableDef; select: Plan; head: string; columns: string[] | null; tail: string; tailParams: Value[] }
  | { kind: "ddl"; sql: string }
  | { kind: "ctas"; name: string; select: Plan; ifNotExists: boolean }
  | { kind: "noop" }
  /** 文を 1 つの取引の中で計画し直す。計画の途中で表を読む必要があるときに返す。 */
  | { kind: "inTxn" }
  | { kind: "tcl"; op: "begin" | "commit" | "rollback" | "savepoint" | "release" | "rollbackTo"; name?: string; immediate?: boolean };

export interface PlanContext {
  /** rowid を n 個採番し、先頭を返す。 */
  nextId(table: string, n: number): Promise<number>;
  /** 利用者が明示した rowid を知らせる。以後の採番はこれより大きくする。 */
  sawId(table: string, id: number): void;
  /** 定数でない値を Worker の SQLite で評価する。 */
  evaluate(sql: string, params: Value[]): Promise<Value>;
  /**
   * 表を読む式の値を、取引の読みとして求める。読んだ範囲は commit で検証される。
   * 取引の外では呼べないので、無いときは計画が `inTxn` を返し、呼び出し側が取引の中で計画し直す。
   */
  read?(sql: string, params: Value[]): Promise<Value>;
}

const lower = (s: string) => s.toLowerCase();
const same = (a: string, b: string) => lower(a) === lower(b);
const ROWID_NAMES = new Set(["rowid", "_rowid_", "oid"]);
const META = /^(sqlite_|pragma_)/i;
const AGGREGATES = new Set(["count", "sum", "min", "max", "avg", "total", "group_concat", "string_agg"]);
/** 値が入力だけで決まる関数。これ以外を含む条件は押し下げない。 */
const PURE = new Set(["abs", "lower", "upper", "length", "coalesce", "ifnull", "nullif", "substr", "trim", "ltrim", "rtrim", "round", "typeof", "instr", "hex", "replace"]);

/** 表の全行を読む走査。プランナが見落とした表を読み足すのに使う。 */
export function fullScan(def: TableDef): Scan {
  return { table: def, sql: `SELECT ${selectList(def)} FROM ${q(def.name)}`, params: [], sks: null };
}

export function findTable(cat: Catalog, name: string): TableDef | null {
  const key = Object.keys(cat.tables).find((k) => same(k, name));
  return key ? cat.tables[key]! : null;
}
function findView(cat: Catalog, name: string): string | null {
  const key = Object.keys(cat.views).find((k) => same(k, name));
  return key ? cat.views[key]! : null;
}

// ---- 走査の範囲 (scope) の解析 ----

interface Ref {
  alias: string;
  name: string;
  def: TableDef | null;
  nullable: boolean;
  /** 外部結合の ON 句のうち、この表の結合に属する条件。 */
  on: Node[];
}

interface Scope {
  node: Node;
  refs: Ref[];
  where: Node | null;
  /** 内部結合の ON 句の条件。 */
  inner: Node[];
  /** 外部結合の ON 句の条件。結合の判定にだけ使う。 */
  outer: Node[];
  /** サブクエリや CTE など、列を解決できない参照を含む。 */
  derived: boolean;
  /** FROM に解釈できない要素がある。 */
  unknown?: boolean;
}

function conjuncts(e: Node): Node[] {
  if (!e) return [];
  if (e.type === "paren_expr" && e.expr?.type !== "list_expr" && e.expr?.type !== "select_stmt") return conjuncts(e.expr);
  if (e.type === "binary_expr" && e.operator?.name === "AND") return [...conjuncts(e.left), ...conjuncts(e.right)];
  return [e];
}

const joinName = (op: Node): string =>
  typeof op === "string" ? op : Array.isArray(op) ? op.map((k) => k.name).join(" ") : op.name;

interface Names {
  cat: Catalog;
  ctes: Set<string>;
  meta: { used: boolean };
  views: Set<string>;
}

function classify(name: string, n: Names): TableDef | null {
  if (n.ctes.has(lower(name))) return null;
  if (META.test(name)) {
    n.meta.used = true;
    return null;
  }
  const def = findTable(n.cat, name);
  // 同じ名前の CTE がある表は、この参照がどちらを指すのかを追わない。表として扱わず、全行を集めて Worker の SQLite に任せる。
  if (def) return n.views.has(lower(name)) ? null : def;
  if (findView(n.cat, name) !== null) {
    n.views.add(lower(name));
    return null;
  }
  throw new SqlError(`no such table: ${name}`);
}

function fromTree(e: Node, nullable: boolean, s: Scope, n: Names): Ref[] {
  if (!e) return [];
  const add = (nameNode: Node, aliasNode: Node | null): Ref[] => {
    const name = ident(nameNode.type === "member_expr" ? nameNode.property : nameNode);
    const def = classify(name, n);
    if (!def) s.derived = true;
    const ref: Ref = { alias: aliasNode ? ident(aliasNode) : name, name, def, nullable, on: [] };
    s.refs.push(ref);
    return [ref];
  };
  switch (e.type) {
    case "identifier":
    case "member_expr":
      return add(e, null);
    case "alias":
      if (e.expr.type === "identifier" || e.expr.type === "member_expr") return add(e.expr, e.alias);
      s.derived = true;
      return [];
    case "indexed_table":
    case "not_indexed_table":
      return fromTree(e.table, nullable, s, n);
    case "paren_expr":
      if (e.expr?.type === "join_expr") return fromTree(e.expr, nullable, s, n);
      s.derived = true;
      return [];
    case "join_expr": {
      const op = lower(joinName(e.operator));
      const left = fromTree(e.left, nullable || /right|full/.test(op), s, n);
      const right = fromTree(e.right, nullable || /left|full/.test(op), s, n);
      const spec = e.specification;
      if (/natural/.test(op) || spec?.type === "join_using_specification") s.derived = true;
      if (spec?.type === "join_on_specification") {
        const conj = conjuncts(spec.expr);
        if (/left|right|full/.test(op)) {
          s.outer.push(...conj);
          // LEFT JOIN の ON のうち右の表だけの条件は、右の走査へ押せる。合わない右の行は、どのみち結果に出ない。
          // FULL JOIN では、合わない右の行も NULL で埋めた行として出るので、押すと行が欠ける。
          if (right.length === 1 && !/full/.test(op)) right[0]!.on.push(...conj);
        } else s.inner.push(...conj);
      }
      return [...left, ...right];
    }
    case "func_call":
      s.derived = true; // json_each などの表値関数
      return [];
    default:
      // 知らない形の FROM は表を見落としている恐れがある。1 シャードへ固定せず、実行前の照合に任せる。
      s.derived = true;
      s.unknown = true;
      return [];
  }
}

function clause(stmt: Node, type: string): Node | null {
  return (stmt.clauses ?? []).find((c: Node) => c.type === type) ?? null;
}

function scopesOf(root: Node, n: Names): Scope[] {
  walk(root, (x) => {
    if (x.type !== "common_table_expr") return;
    const name = lower(ident(x.table));
    // 実在の表と同じ名前の CTE は、文のほかの場所では本物の表を指していることがある。view と同じ扱いにして、
    // 表を条件なしで集め、シャードへ絞り込む経路を使わない。
    if (findTable(n.cat, name)) n.views.add(name);
    else n.ctes.add(name);
  });
  const out: Scope[] = [];
  walk(root, (x) => {
    if (x.type !== "select_stmt" && x.type !== "update_stmt" && x.type !== "delete_stmt") return;
    const s: Scope = { node: x, refs: [], where: clause(x, "where_clause")?.expr ?? null, inner: [], outer: [], derived: false };
    const from = clause(x, "from_clause");
    if (x.type === "update_stmt") {
      for (const t of clause(x, "update_clause").tables.items) fromTree(t, false, s, n);
    }
    if (x.type === "delete_stmt") {
      for (const t of clause(x, "delete_clause").tables.items) fromTree(t, false, s, n);
    }
    if (from) fromTree(from.expr, false, s, n);
    out.push(s);
  });
  return out;
}

// ---- 列の解決と経路の固定 ----

interface Col {
  ref: Ref;
  col: string;
}

function hasColumn(def: TableDef, col: string): string | null {
  const hit = def.columns.find((c) => same(c, col));
  if (hit) return hit;
  if (ROWID_NAMES.has(lower(col)) && (def.implicitRowid || def.rowidAlias)) return def.rowidAlias ?? "rowid";
  return null;
}

/** 列を解決する。解決できない、または曖昧なら null で、その条件は押し下げず経路にも使わない。 */
function colOf(e: Node, s: Scope): Col | null {
  if (e?.type === "member_expr" && e.object?.type === "identifier") {
    const ref = s.refs.find((r) => same(r.alias, ident(e.object)));
    const col = ref?.def && e.property?.type === "identifier" ? hasColumn(ref.def, ident(e.property)) : null;
    return ref && col ? { ref, col } : null;
  }
  if (e?.type !== "identifier" || s.derived) return null;
  const hits = s.refs.flatMap((ref) => {
    const col = ref.def ? hasColumn(ref.def, ident(e)) : null;
    return col ? [{ ref, col }] : [];
  });
  return hits.length === 1 ? hits[0]! : null;
}

/** col = 値、col IN (値, ...) を探す。 */
function equalities(conj: Node[], ref: Ref, col: string, s: Scope, values: Value[]): Value[] | null {
  for (const c of conj) {
    if (c.type !== "binary_expr") continue;
    const op = typeof c.operator === "string" ? c.operator : c.operator?.name;
    if (op === "=" || op === "==") {
      for (const [a, b] of [[c.left, c.right], [c.right, c.left]]) {
        const hit = colOf(a, s);
        if (hit?.ref === ref && hit.col === col) {
          const v = constant(b, values);
          if (v) return [v.value];
        }
      }
    }
    if (op === "IN" && c.right?.type === "paren_expr" && c.right.expr?.type === "list_expr") {
      const hit = colOf(c.left, s);
      if (hit?.ref === ref && hit.col === col) {
        const vs = c.right.expr.items.map((x: Node) => constant(x, values));
        if (vs.every(Boolean)) return vs.map((v: { value: Value }) => v.value);
      }
    }
  }
  return null;
}

function pinsOf(conj: Node[], ref: Ref, s: Scope, values: Value[]): string[] | null {
  const def = ref.def;
  if (!def?.skPinnable) return null;
  let keys: Value[][] = [[]];
  for (const [i, col] of def.shardKey.entries()) {
    const vs = equalities(conj, ref, col, s, values);
    if (!vs) return null;
    if (vs.some((v) => v === null)) return null; // NULL との等値は常に偽だが、経路にはしない
    const norm = vs.map((v) => fold(normalize(v, def.skAffinity[i]!), def.collation[col]));
    keys = keys.flatMap((k) => norm.map((v) => [...k, v]));
  }
  return keys.map((k) => encode(k));
}

function pkOf(conj: Node[], ref: Ref, s: Scope, values: Value[]): string | null {
  const def = ref.def!;
  const vals: Value[] = [];
  for (const col of def.pk) {
    const vs = equalities(conj, ref, col, s, values);
    if (vs?.length !== 1) return null;
    vals.push(normalize(vs[0]!, def.affinity[col] ?? "INTEGER"));
  }
  return encode(vals);
}

function joined(conj: Node[], a: Ref, b: Ref, i: number, s: Scope): boolean {
  const ca = a.def!.shardKey[i]!;
  const cb = b.def!.shardKey[i]!;
  if (a.def!.skAffinity[i] !== b.def!.skAffinity[i]) return false;
  return conj.some((c) => {
    if (c.type !== "binary_expr" || (c.operator !== "=" && c.operator !== "==")) return false;
    const l = colOf(c.left, s);
    const r = colOf(c.right, s);
    return (l?.ref === a && l.col === ca && r?.ref === b && r.col === cb) || (l?.ref === b && l.col === cb && r?.ref === a && r.col === ca);
  });
}

/** scope の全表が 1 つの shard key の値に固定されているなら、その値を返す。 */
function scopePin(s: Scope, values: Value[]): string | null | "none" {
  if (s.unknown) return null;
  const tables = s.refs.filter((r) => r.def);
  if (tables.length === 0) return "none";
  // 外部結合の ON の等値は左の行を絞らないので、経路の固定には使わない。
  const conj = [...conjuncts(s.where), ...s.inner];
  const pins = new Map<Ref, string[]>();
  for (const t of tables) {
    const p = t.nullable ? null : pinsOf(conj, t, s, values);
    if (p) pins.set(t, p);
  }
  const seed = tables.find((t) => pins.get(t)?.length === 1);
  if (!seed) return null;
  const key = pins.get(seed)![0]!;
  const connected = new Set<Ref>([seed]);
  const links = [...conj, ...s.outer];
  for (let grew = true; grew; ) {
    grew = false;
    for (const t of tables) {
      if (connected.has(t)) continue;
      const samePin = pins.get(t)?.length === 1 && pins.get(t)![0] === key;
      const viaJoin = [...connected].some(
        (c) => c.def!.shardKey.length === t.def!.shardKey.length && c.def!.shardKey.every((_, i) => joined(links, c, t, i, s)),
      );
      if (samePin || viaJoin) {
        connected.add(t);
        grew = true;
      }
    }
  }
  return connected.size === tables.length ? key : null;
}

const hasSubquery = (root: Node): boolean => {
  let found = false;
  walk(root, (x) => {
    if (x.type === "select_stmt" || x.type === "compound_select_stmt") found = true;
  });
  return found;
};

/** `x IN t` は右辺の表を読むが FROM に現れない。1 シャードに固定すると行が欠ける。 */
function hasTableOperand(root: Node): boolean {
  let found = false;
  walk(root, (x) => {
    if (x.type === "binary_expr" && /IN$/.test(joinName(x.operator) ?? "") && x.right?.type !== "paren_expr") found = true;
  });
  return found;
}

function statementPin(scopes: Scope[], values: Value[]): string | null {
  if (scopes.some((s) => hasTableOperand(s.node))) return null;
  let key: string | null = null;
  for (const s of scopes) {
    const p = scopePin(s, values);
    if (p === "none") continue;
    if (p === null || (key !== null && key !== p)) return null;
    key = p;
  }
  return key;
}

function gidxRoute(s: Scope, values: Value[]): Route | null {
  if (s.refs.length !== 1 || !s.refs[0]!.def) return null;
  // `x IN t` の t は FROM に現れないが、別のシャードの行も読む。index が挙げたシャードだけで実行すると行が欠ける。
  if (hasTableOperand(s.node)) return null;
  const ref = s.refs[0]!;
  const def = ref.def!;
  const conj = conjuncts(s.where);
  for (const ix of def.globalIndexes) {
    if (ix.state !== "public" || ix.columns.some((c) => def.collated.includes(c))) continue;
    const vals: Value[] = [];
    for (const c of ix.columns) {
      const v = equalities(conj, ref, c, s, values);
      if (v?.length !== 1 || v[0] === null) break;
      vals.push(normalize(v[0]!, def.affinity[c] ?? "BLOB"));
    }
    if (vals.length === ix.columns.length) return { by: "gidx", index: ix, key: encode(vals) };
  }
  return null;
}

// ---- 条件の押し下げ ----

/**
 * 条件が参照する表の別名を返す。押し下げられない要素を含むなら null である。
 * サブクエリ、相関する列、値が決まらない関数は押し下げると結果が変わる。
 */
function conjAliases(e: Node, s: Scope): Set<Ref> | null {
  const refs = new Set<Ref>();
  let ok = true;
  const visit = (x: Node): void => {
    if (!ok || !x || typeof x !== "object") return;
    if (Array.isArray(x)) {
      x.forEach(visit);
      return;
    }
    switch (x.type) {
      case "select_stmt":
      case "compound_select_stmt":
        ok = false;
        return;
      case "func_call":
        if (!PURE.has(lower(ident(x.name)))) ok = false;
        else visit(x.args);
        return;
      case "identifier":
      case "member_expr": {
        const c = colOf(x, s);
        if (!c) ok = false;
        else refs.add(c.ref);
        return;
      }
      case "collate_expr":
        visit(x.expr);
        return;
      case "cast_expr":
        visit(x.args);
        return;
      default:
        for (const k of Object.keys(x)) {
          if (k !== "range" && k !== "leading" && k !== "trailing") visit(x[k]);
        }
    }
  };
  visit(e);
  return ok ? refs : null;
}

/** 表の全列が NULL のとき偽か NULL になる条件。外部結合の NULL 側へ押しても結果が変わらない。 */
function nullRejecting(e: Node, s: Scope, values: Value[]): boolean {
  if (e.type === "between_expr") return !!colOf(e.left, s) && !!constant(e.begin, values) && !!constant(e.end, values);
  if (e.type !== "binary_expr") return false;
  const op = typeof e.operator === "string" ? e.operator : e.operator?.name;
  if (["=", "==", "<", "<=", ">", ">=", "<>", "!="].includes(op)) {
    return (!!colOf(e.left, s) && !!constant(e.right, values)) || (!!colOf(e.right, s) && !!constant(e.left, values));
  }
  return false;
}

function pushable(s: Scope, ref: Ref, values: Value[]): Node[] {
  const single = (c: Node) => {
    const a = conjAliases(c, s);
    // 列を参照しない条件 (WHERE NULL < NULL) も、保存側の表へは押せる。
    return !!a && ((a.size === 1 && a.has(ref)) || (a.size === 0 && !ref.nullable));
  };
  const where = conjuncts(s.where).filter(single);
  if (!ref.nullable) return [...where, ...s.inner.filter(single)];
  return [...ref.on.filter(single), ...where.filter((c) => nullRejecting(c, s, values))];
}

/** WHERE の全条件をシャードで評価できるか。部分集約と Top-N は残った条件を後から適用できない。 */
function fullyPushed(s: Scope, ref: Ref, values: Value[]): boolean {
  const pushed = new Set(pushable(s, ref, values));
  return conjuncts(s.where).every((c) => pushed.has(c));
}

function scanOf(s: Scope | null, ref: Ref | null, def: TableDef, values: Value[]): Scan {
  const name = ref?.alias ?? def.name;
  const conj = s && ref ? pushable(s, ref, values) : [];
  const from = `SELECT ${selectList(def)} FROM ${q(def.name)} AS ${q(name)}`;
  if (conj.length === 0) return { table: def, sql: from, params: [], sks: null };
  const parts = conj.map((c) => render(c, values));
  const where = parts.map((p) => `(${p.sql})`).join(" AND ");
  const params = parts.flatMap((p) => p.params);
  return {
    table: def,
    sql: `${from} WHERE ${where}`,
    params,
    sks: pinsOf(conj, ref!, s!, values),
    where: { alias: name, sql: where, params },
  };
}

function viewTables(cat: Catalog, name: string, n: Names, seen = new Set<string>()): TableDef[] {
  if (seen.has(lower(name))) return [];
  seen.add(lower(name));
  const sql = findView(cat, name);
  if (sql === null) {
    // CTE と同じ名前の表。
    const shadowed = findTable(cat, name);
    return shadowed ? [shadowed] : [];
  }
  const inner: Names = { cat, ctes: new Set(), meta: n.meta, views: new Set() };
  const stmt = parseOne(sql);
  const scopes = scopesOf(stmt, inner);
  const out = scopes.flatMap((s) => s.refs.flatMap((r) => (r.def ? [r.def] : [])));
  for (const v of inner.views) out.push(...viewTables(cat, v, n, seen));
  return out;
}

function parseOne(sql: string): Node {
  // 循環 import を避けるため、ここでだけ遅延して読む。
  return parseStatementsLazy(sql)[0];
}
import { parseStatements as parseStatementsLazy } from "./cst";

function scansFor(scopes: Scope[], n: Names, values: Value[]): Scan[] {
  const uses = new Map<string, number>();
  const extra = [...n.views].flatMap((v) => viewTables(n.cat, v, n));
  for (const s of scopes) for (const r of s.refs) if (r.def) uses.set(r.def.name, (uses.get(r.def.name) ?? 0) + 1);
  for (const d of extra) uses.set(d.name, (uses.get(d.name) ?? 0) + 2);
  const out: Scan[] = [];
  const done = new Set<string>();
  for (const s of scopes) {
    for (const r of s.refs) {
      if (!r.def || done.has(r.def.name)) continue;
      done.add(r.def.name);
      out.push(uses.get(r.def.name) === 1 ? scanOf(s, r, r.def, values) : scanOf(null, null, r.def, values));
    }
  }
  for (const d of extra) {
    if (done.has(d.name)) continue;
    done.add(d.name);
    out.push(scanOf(null, null, d, values));
  }
  return out;
}

// ---- 読み取り ----

/** 各シャードで部分集約してから、Worker の SQLite で合成する。全行を運ばずに済む。 */
function partialAggregate(stmt: Node, s: Scope, values: Value[]): Plan | null {
  if (stmt.type !== "select_stmt" || s.refs.length !== 1 || !s.refs[0]!.def) return null;
  const allowed = new Set(["select_clause", "from_clause", "where_clause", "group_by_clause", "order_by_clause", "limit_clause"]);
  if ((stmt.clauses as Node[]).some((c) => !allowed.has(c.type))) return null;
  const sel = clause(stmt, "select_clause");
  if (sel.modifiers?.length) return null;
  const ref = s.refs[0]!;
  const def = ref.def!;
  if (!fullyPushed(s, ref, values)) return null;
  const group = clause(stmt, "group_by_clause");
  const groupCols: Node[] = group?.columns?.items ?? group?.columns?.expr?.items ?? [];
  const groups = groupCols.map((g) => colOf(g, s));
  if (groups.some((g) => !g || def.collated.includes(g.col))) return null;
  const hasCollate = (n: Node) => {
    let found = false;
    walk(n, (x) => {
      if (x.type === "collate_expr") found = true;
    });
    return found;
  };
  const shardCols: string[] = [];
  const merge: string[] = [];
  const names: string[] = [];
  const shardParams: Value[] = [];
  for (const [i, item] of (sel.columns.items as Node[]).entries()) {
    const e = item.type === "alias" ? item.expr : item;
    const label = item.type === "alias" ? ident(item.alias) : text(item);
    if (e.type === "func_call") {
      const fn = lower(ident(e.name));
      if (!["count", "sum", "min", "max", "avg"].includes(fn) || e.over || e.filter) return null;
      const argList = e.args?.expr;
      if (/\bDISTINCT\b/i.test(text(e.args)) || (argList?.args?.items?.length ?? 0) !== 1) return null;
      const arg = argList.args.items[0];
      if (arg.type !== "all_columns") {
        const a = conjAliases(arg, s);
        if (!a || hasCollate(arg)) return null;
        // min と max は列の照合順序で比べる。集めた後の併合は BINARY で比べるので、照合順序のある列を含む式は押さない。
        let collatedArg = false;
        walk(arg, (x) => {
          if (x.type === "identifier" && def.collated.some((c) => same(c, ident(x)))) collatedArg = true;
        });
        if (fn !== "count" && collatedArg) return null;
      }
      const argSql = arg.type === "all_columns" ? "*" : render(arg, values);
      const argText = typeof argSql === "string" ? argSql : argSql.sql;
      const push = () => {
        if (typeof argSql !== "string") shardParams.push(...argSql.params);
      };
      if (fn === "avg") {
        shardCols.push(`SUM(${argText}) AS "__a${i}"`, `COUNT(${argText}) AS "__c${i}"`);
        push();
        push();
        merge.push(`SUM("__a${i}") * 1.0 / NULLIF(SUM("__c${i}"), 0) AS ${q(label)}`);
        names.push(`__a${i}`, `__c${i}`);
      } else {
        shardCols.push(`${fn.toUpperCase()}(${argText}) AS "__a${i}"`);
        push();
        const outer = fn === "count" ? "SUM" : fn.toUpperCase();
        merge.push(`${outer}("__a${i}") AS ${q(label)}`);
        names.push(`__a${i}`);
      }
      continue;
    }
    const c = colOf(e, s);
    const g = c && groups.findIndex((x) => x?.col === c.col);
    if (!c || g === null || g === undefined || g < 0) return null;
    shardCols.push(`${q(c.col)} AS "__g${i}"`);
    merge.push(`"__g${i}" AS ${q(label)}`);
    names.push(`__g${i}`);
  }
  // GROUP BY の列が全部選択されていないと、合成の段で群が潰れる。
  const selected = (sel.columns.items as Node[]).map((x) => colOf(x.type === "alias" ? x.expr : x, s)?.col);
  if (groups.some((g) => !selected.includes(g!.col))) return null;
  if (groups.length === 0 && merge.length === 0) return null;
  const order = clause(stmt, "order_by_clause");
  const limit = clause(stmt, "limit_clause");
  if (order) {
    let bad = false;
    walk(order, (x) => {
      if (x.type === "func_call" || x.type === "collate_expr") bad = true;
    });
    if (bad) return null;
  }
  const scan = scanOf(s, ref, def, values);
  const whereAt = scan.sql.indexOf(" WHERE ");
  const whereSql = whereAt < 0 ? "" : scan.sql.slice(whereAt);
  const groupSql = groups.length ? ` GROUP BY ${groups.map((g) => q(g!.col)).join(", ")}` : "";
  const sql = `SELECT ${shardCols.join(", ")} FROM ${q(def.name)} AS ${q(ref.alias)}${whereSql}${groupSql}`;
  const groupIdx = groups.map((g) => (sel.columns.items as Node[]).findIndex((x) => colOf(x.type === "alias" ? x.expr : x, s)?.col === g!.col));
  const groupTail = groups.length ? ` GROUP BY ${groupIdx.map((i) => `"__g${i}"`).join(", ")}` : "";
  const orderR = order ? render(order, values) : null;
  const limitR = limit ? render(limit, values) : null;
  return {
    kind: "partial",
    scan: { ...scan, sql, params: [...shardParams, ...scan.params] },
    columns: names,
    mergeSql: `SELECT ${merge.join(", ")} FROM "__p"${groupTail}${orderR ? ` ${orderR.sql}` : ""}${limitR ? ` ${limitR.sql}` : ""}`,
    mergeParams: [...(orderR?.params ?? []), ...(limitR?.params ?? [])],
  };
}

/** ORDER BY と LIMIT をシャードへ押す。各シャードの上位 n 件に全体の上位 n 件が必ず含まれる。 */
function topN(stmt: Node, s: Scope, scan: Scan, values: Value[]): Scan {
  if (stmt.type !== "select_stmt" || s.refs.length !== 1 || s.derived) return scan;
  if (!fullyPushed(s, s.refs[0]!, values)) return scan;
  const order = clause(stmt, "order_by_clause");
  const limit = clause(stmt, "limit_clause");
  const sel = clause(stmt, "select_clause");
  if (!order || !limit || sel?.modifiers?.length || clause(stmt, "group_by_clause") || clause(stmt, "having_clause")) return scan;
  let unsafe = false;
  walk(sel, (x) => {
    if ((x.type === "func_call" && (AGGREGATES.has(lower(ident(x.name))) || x.over)) || x.type === "select_stmt") unsafe = true;
  });
  const terms: Node[] = order.specifications.items;
  // ORDER BY の名前は、SELECT の別名が列名より優先される。シャードへ送る文には別名がないので、同じ名前の列で並べてしまう。
  const aliases = new Set((sel.columns.items as Node[]).flatMap((i) => (i.type === "alias" ? [lower(ident(i.alias))] : [])));
  for (const t of terms) {
    const c = colOf(t.expr, s);
    if (!c || scan.table.collated.includes(c.col)) unsafe = true;
    const e = t.expr ?? t; // 方向の指定がない項は、式そのものが入っている
    if (e.type === "identifier" && aliases.has(lower(ident(e)))) unsafe = true;
  }
  const n = constant(limit.count, values);
  const off = limit.offset ? constant(limit.offset, values) : { value: 0 };
  if (unsafe || typeof n?.value !== "number" || n.value < 0 || typeof off?.value !== "number") return scan;
  const orderSql = terms.map((t) => text(t)).join(", ");
  return { ...scan, sql: `${scan.sql} ORDER BY ${orderSql} LIMIT ${n.value + Math.max(0, off.value)}` };
}

function planRead(stmt: Node, values: Value[], cat: Catalog): Plan {
  const n: Names = { cat, ctes: new Set(), meta: { used: false }, views: new Set() };
  const scopes = scopesOf(stmt, n);
  const { sql, params } = render(stmt, values);
  const defs = [...new Set(scopes.flatMap((s) => s.refs.flatMap((r) => (r.def ? [r.def] : []))))];
  if (n.views.size === 0 && defs.length === 0) return { kind: "meta", sql, params };
  if (n.meta.used) return { kind: "meta", sql, params };
  if (n.views.size === 0) {
    const key = statementPin(scopes, values);
    if (key !== null) {
      const top = scopes.find((s) => s.node === stmt);
      const only = scopes.length === 1 && top?.refs.length === 1 ? top : null;
      const pk = only ? pkOf(conjuncts(only.where), only.refs[0]!, only, values) : null;
      const wasm = { kind: "gather" as const, scans: scansFor(scopes, n, values), sql, params };
      return { kind: "shard", route: { by: "sk", sks: [key] }, sql, params, tables: defs, pk, wasm };
    }
    if (scopes.length === 1) {
      const route = gidxRoute(scopes[0]!, values);
      if (route) {
        const fallback = { kind: "gather" as const, scans: scansFor(scopes, n, values), sql, params };
        return { kind: "shard", route, sql, params, tables: defs, pk: null, fallback };
      }
      const partial = partialAggregate(stmt, scopes[0]!, values);
      if (partial) return partial;
    }
  }
  const scans = scansFor(scopes, n, values);
  if (scopes.length === 1 && scans.length === 1 && n.views.size === 0) {
    scans[0] = topN(stmt, scopes[0]!, scans[0]!, values);
  }
  return { kind: "gather", scans, sql, params };
}

// ---- 書き込み ----

const MAX_PARAMS = 100; // DO の SQL API の上限

/**
 * trigger のある表への書き込みは Worker の SQLite で実行する。本体が他の表を読み書きするので、
 * 1 シャードでは発火できないからである。関係する表を全部集めるので、大きな表では行の上限に当たる。
 */
function triggerWrite(stmt: Node, def: TableDef, values: Value[], cat: Catalog): Plan | null {
  const seen = new Set<string>();
  const visit = (name: string): void => {
    const d = findTable(cat, name);
    if (!d || seen.has(d.name)) return;
    seen.add(d.name);
    for (const t of Object.values(cat.triggers)) if (same(t.table, d.name)) t.tables.forEach(visit);
  };
  if (!Object.values(cat.triggers).some((t) => same(t.table, def.name))) return null;
  visit(def.name);
  const n: Names = { cat, ctes: new Set(), meta: { used: false }, views: new Set() };
  for (const s of scopesOf(stmt, n)) for (const r of s.refs) if (r.def) visit(r.def.name);
  const tables = [...seen].map((t) => findTable(cat, t)!);
  const ordered = [def, ...tables.filter((t) => t !== def)];
  return { kind: "wasmWrite", scans: ordered.map((d) => scanOf(null, null, d, values)), ...render(stmt, values), tables: ordered };
}

async function planInsert(stmt: Node, values: Value[], cat: Catalog, ctx: PlanContext): Promise<Plan> {
  const head = clause(stmt, "insert_clause");
  const name = ident(head.table.type === "alias" ? head.table.expr : head.table);
  const def = findTable(cat, name);
  if (!def) throw new SqlError(`no such table: ${name}`);
  const fired = triggerWrite(stmt, def, values, cat);
  if (fired) return fired;
  const keyword = head.insertKw.name === "REPLACE" ? "REPLACE" : head.orAction ? `INSERT OR ${head.orAction.actionKw.name}` : "INSERT";
  const prefix = `${keyword} INTO ${q(def.name)}`;
  const tailClauses = (stmt.clauses as Node[]).filter((c) => c.type === "upsert_clause" || c.type === "returning_clause");
  const tail = tailClauses.map((c) => render(c, values));
  const tailSql = tail.map((t) => t.sql).join(" ");
  const tailParams = tail.flatMap((t) => t.params);
  let cols: string[] | null = head.columns ? head.columns.expr.items.map((c: Node) => ident(c)) : null;
  const body = (stmt.clauses as Node[]).find((c) => ["values_clause", "default_values", "select_stmt", "compound_select_stmt"].includes(c.type));
  if (!body) throw new SqlError("unsupported INSERT");

  if (body.type !== "values_clause" && body.type !== "default_values") {
    return {
      kind: "insertSelect", def, select: planRead(body, values, cat), head: prefix, columns: cols, tail: tailSql, tailParams,
    };
  }

  const auto = def.rowidAlias ?? (def.implicitRowid ? "rowid" : null);
  const rows: Node[][] = body.type === "default_values" ? [[]] : body.values.items.map((r: Node) => r.expr.items);
  // 値の式がサブクエリで表を読むことがある (`VALUES (?, (SELECT max(pos) + 1 FROM t ...))`)。
  // 文をそのまま挿入先のシャードへ送ると、サブクエリはそのシャードの行しか読まず、読んだ範囲は検証もされない。
  // 先に取引の読みとして値を求め、定数に置き換えてから送る。
  const reads = rows.map((r) => r.map(hasSubquery));
  if (reads.some((r) => r.some(Boolean)) && !ctx.read) return { kind: "inTxn" };
  if (tailClauses.some(hasSubquery)) throw new SqlError("subqueries in ON CONFLICT or RETURNING of an INSERT are not supported");
  const names = cols ?? (body.type === "default_values" ? [] : [...def.columns]);
  for (const r of rows) {
    if (body.type === "values_clause" && r.length !== names.length) {
      throw new SqlError(cols
        ? `${r.length} values for ${names.length} columns`
        : `table ${def.name} has ${names.length} columns but ${r.length} values were supplied`);
    }
  }
  const idAt = auto ? names.findIndex((c) => same(c, auto) || ROWID_NAMES.has(lower(c))) : -1;
  // 主キーの値が明示されない行に rowid を採番する。行の所在は主キーで決まるからである。
  const missing: number[] = [];
  const given: (Value | undefined)[] = rows.map((r, i) => {
    if (!auto) return undefined;
    if (idAt < 0) {
      missing.push(i);
      return undefined;
    }
    const v = constant(r[idAt], values);
    if (v && v.value === null) {
      missing.push(i);
      return undefined;
    }
    return v?.value;
  });
  const first = missing.length ? await ctx.nextId(def.name, missing.length) : 0;
  const assigned = new Map(missing.map((row, i) => [row, first + i]));
  let last: number | null = null;

  const outCols = auto && idAt < 0 ? [auto, ...names] : names;
  const skAt = def.shardKey.map((c) => outCols.findIndex((n2) => same(n2, c) || (c === "rowid" && ROWID_NAMES.has(lower(n2)))));
  type Built = { sk: string; pk: string | null; sql: string; params: Value[] };
  const built: Built[] = [];
  for (const [i, r] of rows.entries()) {
    const id = assigned.get(i);
    const parts: { sql: string; params: Value[]; value: () => Promise<Value>; late?: () => Promise<Value> }[] = r.map((node, j) => {
      if (j === idAt && id !== undefined) return { sql: "?", params: [id], value: async () => id };
      const rr = render(node, values);
      if (reads[i]![j]) {
        let v: Promise<Value> | undefined;
        const value = () => (v ??= ctx.read!(`SELECT ${rr.sql}`, rr.params));
        return { sql: "?", params: [], value, late: value };
      }
      const c = constant(node, values);
      return { sql: rr.sql, params: rr.params, value: async () => (c ? c.value : ctx.evaluate(`SELECT ${rr.sql}`, rr.params)) };
    });
    if (auto && idAt < 0) parts.unshift({ sql: "?", params: [id!], value: async () => id! });
    for (const p of parts) if (p.late) p.params = [await p.late()];
    const skVals: Value[] = [];
    for (const [k, at] of skAt.entries()) {
      const v = at < 0 ? null : await parts[at]!.value();
      skVals.push(fold(normalize(v, def.skAffinity[k]!), def.collation[def.shardKey[k]!]));
    }
    const pkVals: Value[] = [];
    for (const c of def.pk) {
      const at = outCols.findIndex((n2) => same(n2, c) || (c === "rowid" && ROWID_NAMES.has(lower(n2))));
      pkVals.push(at < 0 ? null : normalize(await parts[at]!.value(), def.affinity[c] ?? "INTEGER"));
    }
    if (auto) {
      const v = id ?? given[i];
      if (typeof v === "number") {
        last = v;
        if (id === undefined) ctx.sawId(def.name, v);
      }
    }
    built.push({
      sk: encode(skVals), pk: encode(pkVals),
      sql: `(${parts.map((p) => p.sql).join(", ")})`, params: parts.flatMap((p) => p.params),
    });
  }

  const colSql = outCols.length ? ` (${outCols.map((c) => q(ROWID_NAMES.has(lower(c)) ? "rowid" : c)).join(", ")})` : "";
  // シャード単位にまとめる。shard key の値ごとに分けると、主キーでハッシュする表では 1 行 1 RPC になる。
  const groups = new Map<string, Built[]>();
  for (const b of built) {
    const owner = ownerOf(cat.routing, b.sk);
    groups.set(owner, [...(groups.get(owner) ?? []), b]);
  }
  const targets: WriteTarget[] = [];
  for (const list of groups.values()) {
    for (let at = 0; at < list.length; ) {
      const chunk: Built[] = [];
      let count = tailParams.length;
      while (at < list.length && (chunk.length === 0 || count + list[at]!.params.length <= MAX_PARAMS)) {
        count += list[at]!.params.length;
        chunk.push(list[at++]!);
      }
      const isDefault = body.type === "default_values" && outCols.length === 0;
      const sks = [...new Set(chunk.map((b) => b.sk))];
      // OR 句、UPSERT、RETURNING のない INSERT は、RETURNING で変更行を全部捕捉できる。
      const capture = keyword === "INSERT" && tailClauses.length === 0 ? "insert" as const : undefined;
      targets.push({
        route: { by: "sk", sks },
        sql: `${prefix}${colSql} ${isDefault ? "DEFAULT VALUES" : `VALUES ${chunk.map((b) => b.sql).join(", ")}`}${tailSql ? ` ${tailSql}` : ""}`,
        params: [...chunk.flatMap((b) => b.params), ...tailParams],
        write: { sk: sks.length === 1 ? sks[0]! : null, capture },
        pk: chunk.length === 1 ? chunk[0]!.pk : null,
      });
    }
  }
  return { kind: "write", def, targets, lastRowid: last };
}

/**
 * RETURNING で変更行を捕捉できる UPDATE と DELETE の形を返す。
 * 利用者の RETURNING、UPDATE FROM、OR 句 (REPLACE が他の行を消す) があると捕捉が漏れるので除く。
 * UPDATE は変更前の行を主キーで読むので、主キーで 1 行に絞れる文に限る。
 */
function captureOf(stmt: Node, pk: string | null): WritePlan["capture"] {
  const clauses = stmt.clauses as Node[];
  if (clauses.some((c) => c.type === "returning_clause" || c.type === "from_clause" || c.orAction)) return undefined;
  if (stmt.type === "delete_stmt") return "delete";
  if (stmt.type !== "update_stmt" || pk === null) return undefined;
  if (clauses.some((c) => c.type === "order_by_clause" || c.type === "limit_clause")) return undefined;
  return "update";
}

function planUpdateDelete(stmt: Node, values: Value[], cat: Catalog): Plan {
  const n: Names = { cat, ctes: new Set(), meta: { used: false }, views: new Set() };
  const scopes = scopesOf(stmt, n);
  const top = scopes.find((s) => s.node === stmt)!;
  const ref = top.refs[0];
  const def = ref?.def;
  if (!ref || !def) throw new SqlError("cannot modify a view");
  const fired = triggerWrite(stmt, def, values, cat);
  if (fired) return fired;
  const { sql, params } = render(stmt, values);
  const set = clause(stmt, "set_clause");
  const assigned: string[] = (set?.assignments?.items ?? []).flatMap((a: Node) =>
    a.column?.type === "identifier" ? [ident(a.column)] : [],
  );
  const movesRow = assigned.some((c) => def.shardKey.some((k) => same(k, c)) || def.pk.some((k) => same(k, c)));
  const defs = [...new Set(scopes.flatMap((s) => s.refs.flatMap((r) => (r.def ? [r.def] : []))))];
  if (!movesRow && n.views.size === 0) {
    const key = statementPin(scopes, values);
    if (key !== null) {
      const pk = scopes.length === 1 && top.refs.length === 1 ? pkOf(conjuncts(top.where), ref, top, values) : null;
      return { kind: "write", def, tables: defs, lastRowid: null, targets: [{ route: { by: "sk", sks: [key] }, sql, params, write: { sk: key, capture: captureOf(stmt, pk) }, pk }] };
    }
    if (scopes.length === 1 && top.refs.length === 1) {
      const route = gidxRoute(top, values);
      if (route) return { kind: "write", def, lastRowid: null, targets: [{ route, sql, params, write: { sk: null }, pk: null, wide: scansFor(scopes, n, values) }] };
    }
  }
  return { kind: "wasmWrite", scans: scansFor(scopes, n, values), sql, params, tables: defs };
}

// ---- 入口 ----

export async function planStatement(stmt: Node, input: Params, cat: Catalog, ctx: PlanContext): Promise<Plan> {
  const values = bindParams(stmt, input);
  switch (stmt.type) {
    case "select_stmt":
    case "compound_select_stmt":
      return planRead(stmt, values, cat);
    case "insert_stmt": return planInsert(stmt, values, cat, ctx);
    case "update_stmt":
    case "delete_stmt":
      return planUpdateDelete(stmt, values, cat);
    case "create_table_stmt": {
      const as = clause(stmt, "as_clause");
      if (as) {
        return { kind: "ctas", name: ident(stmt.name), select: planRead(as.expr, values, cat), ifNotExists: !!stmt.ifNotExistsKw };
      }
      return { kind: "ddl", sql: text(stmt) };
    }
    case "create_index_stmt":
    case "create_view_stmt":
    case "create_trigger_stmt":
    case "drop_trigger_stmt":
    case "drop_table_stmt":
    case "drop_index_stmt":
    case "drop_view_stmt":
    case "alter_table_stmt":
      return { kind: "ddl", sql: text(stmt) };
    case "pragma_stmt":
    case "explain_stmt":
      return { kind: "meta", ...render(stmt, values) };
    case "reindex_stmt": {
      const target = stmt.name ? ident(stmt.name.type === "member_expr" ? stmt.name.property : stmt.name) : null;
      const known = !target || findTable(cat, target) || Object.keys(cat.indexes).some((i) => same(i, target));
      if (!known && !/^(BINARY|NOCASE|RTRIM)$/i.test(target!)) throw new SqlError("unable to identify the object to be reindexed");
      return { kind: "noop" };
    }
    case "analyze_stmt":
    case "vacuum_stmt":
      return { kind: "noop" };
    case "start_transaction_stmt":
      return { kind: "tcl", op: "begin", immediate: /IMMEDIATE|EXCLUSIVE/i.test(stmt.behaviorKw?.name ?? "") };
    case "commit_transaction_stmt": return { kind: "tcl", op: "commit" };
    case "rollback_transaction_stmt":
      return stmt.savepoint
        ? { kind: "tcl", op: "rollbackTo", name: ident(stmt.savepoint.savepoint) }
        : { kind: "tcl", op: "rollback" };
    case "savepoint_stmt": return { kind: "tcl", op: "savepoint", name: ident(stmt.savepoint) };
    case "release_savepoint_stmt": return { kind: "tcl", op: "release", name: ident(stmt.savepoint) };
    default:
      throw new SqlError(`unsupported statement: ${stmt.type}`);
  }
}
