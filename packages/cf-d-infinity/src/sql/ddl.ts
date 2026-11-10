import type { Affinity, GlobalIndexDef, TableDef } from "../types";
import { SqlError } from "../types";
import { captureDdl, dropCaptureDdl, q } from "../shard/rows";
import { affinityOf, ident, parseStatements, text, walk, type Node } from "./cst";

export interface IndexInfo {
  table: string;
  global: boolean;
}

export interface TriggerInfo {
  table: string;
  sql: string;
  /** 本体が読み書きする表。 */
  tables: string[];
}

export interface SchemaView {
  tables: Record<string, TableDef>;
  views: Record<string, string>;
  indexes: Record<string, IndexInfo>;
  triggers: Record<string, TriggerInfo>;
}

export interface ParsedDdl {
  /** シャードで実行する文。 */
  sql: string[];
  defs: TableDef[];
  drops: string[];
  /** Worker の SQLite で再生する文。利用者が書いた形に近い。 */
  user: string | null;
  views?: Record<string, string>;
  dropViews?: string[];
  indexes?: Record<string, IndexInfo>;
  dropIndexes?: string[];
  triggers?: Record<string, TriggerInfo>;
  dropTriggers?: string[];
  /** IF NOT EXISTS などで何もしない。 */
  noop?: boolean;
  /**
   * この文を取り消す文。シャードの持つ行によって適用に失敗し得る文にだけ付ける。
   * 空の表では通るので、Meta での事前の検証では見つからない。失敗したシャードが取り消しを求める。
   */
  undo?: { sql: string[]; user: string };
}

/** 内部の表は `__` で始まる。利用者の表と名前が衝突すると、内部の状態を利用者の SQL で書き換えられる。 */
function userName(name: string, what: string): string {
  if (/^(__|sqlite_)/i.test(name)) throw new SqlError(`${what} name ${name} is reserved: names starting with "__" or "sqlite_" are internal`);
  return name;
}

const NOOP: ParsedDdl = { sql: [], defs: [], drops: [], user: null, noop: true };

export function globalIndexTable(ix: Pick<GlobalIndexDef, "name" | "unique">): { def: TableDef; sql: string } {
  const table = `__gidx_${ix.name}`;
  const pk = ix.unique ? ["k"] : ["k", "pk"];
  return {
    def: {
      name: table, columns: ["k", "pk", "sk"], pk, shardKey: ["k"], uniques: [], globalIndexes: [],
      implicitRowid: false, rowidAlias: null, skAffinity: ["TEXT"], skPinnable: true,
      affinity: { k: "TEXT", pk: "TEXT", sk: "TEXT" }, collated: [], collation: {},
    },
    sql: `CREATE TABLE ${q(table)} ("k" TEXT NOT NULL, "pk" TEXT NOT NULL, "sk" TEXT NOT NULL, PRIMARY KEY (${pk.map(q).join(", ")}))`,
  };
}

const isFk = (c: Node) => c.type === "references_specification" || c.type === "constraint_foreign_key";
const inner = (item: Node) => (item.type === "constraint" ? item.constraint : item);
const specCols = (c: Node): string[] => c.columns.expr.items.map((i: Node) => ident(i.type === "index_specification" ? i.expr : i));

function createTable(source: string, stmt: Node, schema: SchemaView, shardKey: string[] | null): ParsedDdl {
  if (stmt.kind?.name === "TEMP" || stmt.kind?.name === "TEMPORARY") throw new SqlError("TEMP tables are not supported");
  const name = userName(ident(stmt.name), "table");
  if (schema.tables[name] || schema.views[name]) {
    if (stmt.ifNotExistsKw) return NOOP;
    throw new SqlError(`table ${name} already exists`);
  }
  const items: Node[] = stmt.columns.expr.items;
  const columns: string[] = [];
  const types = new Map<string, string | null>();
  const collated = new Set<string>();
  const collation: Record<string, string> = {};
  let pk: string[] = [];
  const uniqueSets: string[][] = [];
  for (const item of items) {
    if (item.type !== "column_definition") {
      const c = inner(item);
      if (c.type === "constraint_primary_key") pk = specCols(c);
      if (c.type === "constraint_unique") uniqueSets.push(specCols(c));
      continue;
    }
    const col = ident(item.name);
    columns.push(col);
    types.set(col, item.dataType ? text(item.dataType) : null);
    for (const raw of item.constraints ?? []) {
      const c = inner(raw);
      if (c.type === "constraint_primary_key") pk = [col];
      if (c.type === "constraint_unique") uniqueSets.push([col]);
      if (c.type === "constraint_collate") {
        collated.add(col);
        collation[col] = ident(c.collation).toUpperCase();
      }
    }
  }
  const withoutRowid = (stmt.options?.items ?? stmt.options?.options?.items ?? []).some((o: Node) => /WITHOUT/i.test(text(o)));
  const implicitRowid = pk.length === 0;
  if (implicitRowid) pk = ["rowid"];
  const single = pk.length === 1 ? pk[0]! : null;
  const rowidAlias = !withoutRowid && single && /^INTEGER$/i.test((types.get(single) ?? "").trim()) ? single : null;
  const sk = shardKey ?? [pk[0]!];
  for (const c of sk) {
    if (!pk.includes(c)) throw new SqlError(`SHARD KEY column ${c} must be part of the PRIMARY KEY`);
  }

  // 外部キーは SQLite の既定どおり強制しない。親の行が別のシャードにあるからである。
  // 全行に対する UNIQUE は 1 シャードでは検査できないので、グローバル index へ移す。
  const isGlobal = (cols: string[]) => !sk.every((c) => cols.includes(c));
  const kept: Node[] = [];
  for (const item of items) {
    if (item.type === "column_definition") {
      item.constraints = (item.constraints ?? []).filter((raw: Node) => {
        const c = inner(raw);
        if (isFk(c)) return false;
        return !(c.type === "constraint_unique" && isGlobal([ident(item.name)]));
      });
      kept.push(item);
      continue;
    }
    const c = inner(item);
    if (isFk(c)) continue;
    if (c.type === "constraint_unique" && isGlobal(specCols(c))) continue;
    kept.push(item);
  }
  stmt.columns.expr.items = kept;

  const def: TableDef = {
    name, columns, pk, shardKey: sk, uniques: [], globalIndexes: [], implicitRowid, rowidAlias,
    skAffinity: sk.map((c): Affinity => (c === "rowid" ? "INTEGER" : affinityOf(types.get(c) ?? null))),
    skPinnable: sk.every((c) => !collated.has(c) || ["NOCASE", "RTRIM", "BINARY"].includes(collation[c]!)),
    affinity: Object.fromEntries(columns.map((c) => [c, affinityOf(types.get(c) ?? null)])),
    collated: [...collated],
    collation,
  };
  const sql = [text(stmt), ...captureDdl(def)];
  const defs: TableDef[] = [];
  const indexes: Record<string, IndexInfo> = {};
  uniqueSets.forEach((cols, i) => {
    if (isGlobal(cols)) {
      const ix: GlobalIndexDef = { name: `${name}_${i}_key`, table: `__gidx_${name}_${i}_key`, columns: cols, unique: true, state: "public" };
      const t = globalIndexTable(ix);
      def.globalIndexes.push(ix);
      sql.push(t.sql);
      defs.push(t.def);
    } else def.uniques.push(cols);
  });
  return { sql, defs: [def, ...defs], drops: [], user: source, indexes };
}

function createIndex(source: string, stmt: Node, schema: SchemaView): ParsedDdl {
  const name = userName(ident(stmt.name), "index");
  const table = ident(stmt.table);
  if (schema.indexes[name]) {
    // 既存の行で埋めている途中の index は、まだ作り終えていない。同じ文の出し直しは、続きを埋める指示として受ける。
    const half = schema.tables[schema.indexes[name]!.table]?.globalIndexes.find((g) => g.name === name && g.state === "writeOnly");
    if (stmt.ifNotExistsKw || (half && schema.indexes[name]!.table === table)) return NOOP;
    throw new SqlError(`index ${name} already exists`);
  }
  const found = schema.tables[table];
  if (!found) throw new SqlError(`no such table: main.${table}`);
  const def = structuredClone(found);
  const unique = stmt.indexTypeKw?.name === "UNIQUE";
  const specs: Node[] = stmt.columns.expr.items;
  const plain = specs.every((s) => s.expr.type === "identifier");
  const partial = !!(stmt.clauses ?? []).some((c: Node) => c.type === "where_clause");
  const cols = plain ? specs.map((s) => ident(s.expr)) : [];
  for (const c of cols) if (!def.columns.includes(c) && c !== "rowid") throw new SqlError(`no such column: ${c}`);
  const local = (plain && def.shardKey.every((c) => cols.includes(c))) || !plain || partial;
  if (local) {
    if (unique && !(plain && def.shardKey.every((c) => cols.includes(c)))) {
      throw new SqlError("UNIQUE partial or expression indexes must include the shard key");
    }
    if (unique && !partial) def.uniques.push(cols);
    const drop = `DROP INDEX IF EXISTS ${q(name)}`;
    return { sql: [source], defs: [def], drops: [], user: source, indexes: { [name]: { table, global: false } }, undo: { sql: [drop], user: drop } };
  }
  const ix: GlobalIndexDef = { name, table: `__gidx_${name}`, columns: cols, unique, state: "writeOnly" };
  const t = globalIndexTable(ix);
  def.globalIndexes.push(ix);
  return { sql: [t.sql], defs: [def, t.def], drops: [], user: source, indexes: { [name]: { table, global: true } } };
}

function triggerTables(stmt: Node): string[] {
  const out = new Set<string>();
  const add = (e: Node): void => {
    if (!e) return;
    if (e.type === "identifier") out.add(ident(e));
    else if (e.type === "member_expr") out.add(ident(e.property));
    else if (e.type === "alias") add(e.expr);
    else if (e.type === "join_expr") {
      add(e.left);
      add(e.right);
    } else if (e.type === "paren_expr" && e.expr?.type === "join_expr") add(e.expr);
  };
  walk(stmt.body, (x) => {
    if (x.type === "insert_clause") add(x.table);
    if (x.type === "update_clause" || x.type === "delete_clause") x.tables.items.forEach(add);
    if (x.type === "from_clause") add(x.expr);
  });
  return [...out];
}

function createTrigger(source: string, stmt: Node, schema: SchemaView): ParsedDdl {
  const name = userName(ident(stmt.name), "trigger");
  if (schema.triggers[name]) {
    if (stmt.ifNotExistsKw) return NOOP;
    throw new SqlError(`trigger ${name} already exists`);
  }
  const t = stmt.target.table;
  const table = ident(t.type === "member_expr" ? t.property : t);
  if (!schema.tables[table] && !schema.views[table]) throw new SqlError(`no such table: main.${table}`);
  // シャードには作らない。trigger のある表への書き込みは Worker の SQLite で実行し、そこで発火させる。
  return { sql: [], defs: [], drops: [], user: null, triggers: { [name]: { table, sql: source, tables: triggerTables(stmt) } } };
}

function dropTable(source: string, stmt: Node, schema: SchemaView): ParsedDdl {
  const out: ParsedDdl = { sql: [], defs: [], drops: [], user: source, dropIndexes: [], dropTriggers: [] };
  for (const t of stmt.tables.items) {
    const name = ident(t.type === "member_expr" ? t.property : t);
    const def = schema.tables[name];
    if (!def) {
      if (stmt.ifExistsKw) continue;
      throw new SqlError(`no such table: ${name}`);
    }
    out.sql.push(...dropCaptureDdl(name), `DROP TABLE ${q(name)}`);
    for (const ix of def.globalIndexes) {
      out.sql.push(`DROP TABLE IF EXISTS ${q(ix.table)}`);
      out.drops.push(ix.table);
    }
    out.drops.push(name);
    for (const [i, info] of Object.entries(schema.indexes)) if (info.table === name) out.dropIndexes!.push(i);
    for (const [i, info] of Object.entries(schema.triggers)) if (info.table === name) out.dropTriggers!.push(i);
  }
  return out.drops.length ? out : NOOP;
}

function dropIndex(source: string, stmt: Node, schema: SchemaView): ParsedDdl {
  const name = ident(stmt.indexes.items[0]);
  const info = schema.indexes[name];
  if (!info) {
    if (stmt.ifExistsKw) return NOOP;
    throw new SqlError(`no such index: ${name}`);
  }
  if (!info.global) return { sql: [source], defs: [], drops: [], user: source, dropIndexes: [name] };
  const def = structuredClone(schema.tables[info.table]!);
  const ix = def.globalIndexes.find((g) => g.name === name)!;
  def.globalIndexes = def.globalIndexes.filter((g) => g.name !== name);
  return { sql: [`DROP TABLE IF EXISTS ${q(ix.table)}`], defs: [def], drops: [ix.table], user: source, dropIndexes: [name] };
}

function alterTable(source: string, stmt: Node, schema: SchemaView): ParsedDdl {
  const name = ident(stmt.table);
  const found = schema.tables[name];
  if (!found) throw new SqlError(`no such table: ${name}`);
  const def = structuredClone(found);
  const action = stmt.actions.items[0];
  const sql: string[] = dropCaptureDdl(name);
  switch (action.type) {
    case "alter_action_rename": {
      const to = userName(ident(action.newName), "table");
      if (schema.tables[to]) throw new SqlError(`there is already another table or index with this name: ${to}`);
      sql.push(`ALTER TABLE ${q(name)} RENAME TO ${q(to)}`);
      def.name = to;
      sql.push(...captureDdl(def));
      const indexes: Record<string, IndexInfo> = {};
      for (const [i, info] of Object.entries(schema.indexes)) if (info.table === name) indexes[i] = { ...info, table: to };
      return { sql, defs: [def], drops: [name], user: source, indexes };
    }
    case "alter_action_add_column": {
      const col = action.column;
      col.constraints = (col.constraints ?? []).filter((c: Node) => !isFk(inner(c)));
      sql.push(`ALTER TABLE ${q(name)} ADD COLUMN ${text(col)}`);
      const added = ident(col.name);
      def.columns.push(added);
      // 型親和性と照合順序も記録する。無いと、この列の index を引くときに値を正規化できず、行を見つけられない。
      def.affinity[added] = affinityOf(col.dataType ? text(col.dataType) : null);
      for (const raw of col.constraints ?? []) {
        const c = inner(raw);
        if (c.type !== "constraint_collate") continue;
        def.collated.push(added);
        def.collation[added] = ident(c.collation).toUpperCase();
      }
      // CHECK や NOT NULL は既存の行で検査されるので、行のあるシャードでだけ失敗し得る。
      const drop = `ALTER TABLE ${q(name)} DROP COLUMN ${q(ident(col.name))}`;
      sql.push(...captureDdl(def));
      return { sql, defs: [def], drops: [], user: source, undo: { sql: [...dropCaptureDdl(name), drop, ...captureDdl(found)], user: drop } };
    }
    case "alter_action_rename_column": {
      const from = ident(action.oldName);
      const to = ident(action.newName);
      if (!def.columns.includes(from)) throw new SqlError(`no such column: "${from}"`);
      sql.push(`ALTER TABLE ${q(name)} RENAME COLUMN ${q(from)} TO ${q(to)}`);
      const ren = (c: string) => (c === from ? to : c);
      def.columns = def.columns.map(ren);
      def.pk = def.pk.map(ren);
      def.shardKey = def.shardKey.map(ren);
      def.uniques = def.uniques.map((u) => u.map(ren));
      if (def.rowidAlias === from) def.rowidAlias = to;
      for (const g of def.globalIndexes) g.columns = g.columns.map(ren);
      def.affinity = Object.fromEntries(Object.entries(def.affinity).map(([c, a]) => [ren(c), a]));
      def.collation = Object.fromEntries(Object.entries(def.collation).map(([c, a]) => [ren(c), a]));
      def.collated = def.collated.map(ren);
      break;
    }
    case "alter_action_drop_column": {
      const col = ident(action.column);
      if (!def.columns.includes(col)) throw new SqlError(`no such column: "${col}"`);
      if (def.pk.includes(col)) throw new SqlError(`cannot drop PRIMARY KEY column: "${col}"`);
      if (def.globalIndexes.some((g) => g.columns.includes(col))) throw new SqlError(`cannot drop indexed column: "${col}"`);
      sql.push(`ALTER TABLE ${q(name)} DROP COLUMN ${q(col)}`);
      def.columns = def.columns.filter((c) => c !== col);
      break;
    }
    default:
      throw new SqlError(`unsupported ALTER TABLE action: ${action.type}`);
  }
  sql.push(...captureDdl(def));
  return { sql, defs: [def], drops: [], user: source };
}

export function parseDdl(source: string, schema: SchemaView): ParsedDdl {
  let shardKey: string[] | null = null;
  const clean = source
    .replace(/\bSHARD\s+KEY\s*\(([^)]*)\)/i, (_m, cols: string) => {
      shardKey = cols.split(",").map((c) => c.trim().replace(/^"|"$/g, ""));
      return "";
    })
    .trim()
    .replace(/;$/, "");
  const stmt = parseStatements(clean)[0];
  switch (stmt.type) {
    case "create_table_stmt": return createTable(clean, stmt, schema, shardKey);
    case "create_index_stmt": return createIndex(clean, stmt, schema);
    case "drop_table_stmt": return dropTable(clean, stmt, schema);
    case "drop_index_stmt": return dropIndex(clean, stmt, schema);
    case "alter_table_stmt": return alterTable(clean, stmt, schema);
    case "create_trigger_stmt": return createTrigger(clean, stmt, schema);
    case "drop_trigger_stmt": {
      const name = ident(stmt.trigger);
      if (!schema.triggers[name]) {
        if (stmt.ifExistsKw) return NOOP;
        throw new SqlError(`no such trigger: ${name}`);
      }
      return { sql: [], defs: [], drops: [], user: null, dropTriggers: [name] };
    }
    case "create_view_stmt": {
      const name = userName(ident(stmt.name), "view");
      if (schema.views[name]) {
        if (stmt.ifNotExistsKw) return NOOP;
        throw new SqlError(`view ${name} already exists`);
      }
      return { sql: [], defs: [], drops: [], user: clean, views: { [name]: clean } };
    }
    case "drop_view_stmt": {
      const name = ident(stmt.views.items[0]);
      if (!schema.views[name]) {
        if (stmt.ifExistsKw) return NOOP;
        throw new SqlError(`no such view: ${name}`);
      }
      return { sql: [], defs: [], drops: [], user: clean, dropViews: [name] };
    }
    default:
      throw new SqlError(`unsupported statement: ${stmt.type}`);
  }
}
