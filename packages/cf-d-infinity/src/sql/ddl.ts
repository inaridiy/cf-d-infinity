import type { Affinity, GlobalIndexDef, TableDef } from "../types";
import { SqlError } from "../types";
import { captureDdl, dropCaptureDdl, q } from "../shard/rows";
import { affinityOf, ident, parseStatements, text, type Node } from "./cst";

export interface IndexInfo {
  table: string;
  global: boolean;
}

export interface SchemaView {
  tables: Record<string, TableDef>;
  views: Record<string, string>;
  indexes: Record<string, IndexInfo>;
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
  /** IF NOT EXISTS などで何もしない。 */
  noop?: boolean;
  /**
   * この文を取り消す文。シャードの持つ行によって適用に失敗し得る文にだけ付ける。
   * 空の表では通るので、Meta での事前の検証では見つからない。失敗したシャードが取り消しを求める。
   */
  undo?: { sql: string[]; user: string | null };
  /**
   * この文は、既存の行からシャードをまたぐ UNIQUE の index を作り始める。記録した版は表を書き込み禁止にするだけで、
   * index は出来上がるまで見えない。user は、公開の版が Worker の SQLite で再生する文である。
   */
  build?: { table: string; index: string; user: string };
}

/** 内部の表は `__` で始まる。利用者の表と名前が衝突すると、内部の状態を利用者の SQL で書き換えられる。 */
const INTERNAL_NAMES = new Set([
  "__arrived", "__cap", "__cap_on", "__ddl", "__fenced", "__incoming", "__intents", "__meta", "__moved", "__moved_txn",
  "__p", "__raw", "__routing", "__seq", "__slow", "__txn",
]);
/**
 * 内部で使う名前か。`__` で始まる名前を全部は取らない。移行の道具が `__new_<表名>` のような名前を使うからである。
 * 利用者の文が内部の表を名指しできないことは、名前の検査ではなく、Worker の SQLite でのコンパイルが守る
 * (そこには利用者の表しかない。Db.tablesOf)。ここで断るのは、内部の表と物理的に衝突する名前を作ることである。
 */
export const isInternalName = (name: string): boolean =>
  INTERNAL_NAMES.has(name.toLowerCase()) || /^(sqlite_|__gidx_|__cap_|__capv_|__log_g)/i.test(name);

/**
 * 列の名前のうち、内部で使う接頭辞。行イメージの JSON の印 (`{"$b": 16 進}`、`{"$f": "Infinity"}`。src/shard/rows.ts の encode)
 * と、Worker やシャードが文に足す列の別名 (`__dinf_typeof_<i>` など) である。利用者の列がこの名前だと、行イメージを読むときに
 * 行そのものを印と取り違えたり (確定した INSERT が消える)、足した列が利用者の列を上書きしたりする (2026-11-13 の Codex の
 * 指摘 C2、C3)。新しい印や別名は、この接頭辞で作る (test/internal-names.test.ts が、印と別名がここに当たることを確かめる)。
 */
export const INTERNAL_COLUMN_PREFIXES = ["$", "__dinf_"];
export const isInternalColumn = (name: string): boolean =>
  INTERNAL_COLUMN_PREFIXES.some((p) => name.toLowerCase().startsWith(p));

function userColumn(name: string): string {
  if (isInternalColumn(name)) {
    throw new SqlError(`unsupported: column name ${name} is reserved for internal use (names starting with ${INTERNAL_COLUMN_PREFIXES.map((p) => `'${p}'`).join(" or ")})`);
  }
  return name;
}

/** 対応していない機能は、黙って通さずに断る。エラーは必ず `unsupported:` で始める。 */
const unsupported = (what: string): never => {
  throw new SqlError(`unsupported: ${what}`);
};

function userName(name: string, what: string): string {
  // `__dinf_` は、Worker が文に足す別名と CTE の名前に使う (Txn.insertSelect)。CTE には付けられるので、表の名前だけを断る。
  if (isInternalName(name) || /^__dinf_/i.test(name)) throw new SqlError(`${what} name ${name} is reserved for internal use`);
  return name;
}

/** 既存の表を名指しする。内部の表 (グローバル index の表など) は、利用者の DDL からは存在しないものとして扱う。 */
function existingTable(schema: SchemaView, name: string): TableDef | undefined {
  return isInternalName(name) ? undefined : schema.tables[name];
}

/**
 * 表、view、index は SQLite では 1 つの名前空間にあり、大文字と小文字を区別しない。
 * ここで断らないと、シャードの文は通るのに、Worker の SQLite で履歴を再生する文が失敗する。履歴は書き換えられないので、
 * 以後、行を Worker に集める文がすべて失敗する。
 */
function assertFree(schema: SchemaView, name: string): void {
  const hit = (keys: string[]) => keys.some((k) => k.toLowerCase() === name.toLowerCase());
  if (hit(Object.keys(schema.tables))) throw new SqlError(`there is already a table named ${name}`);
  if (hit(Object.keys(schema.views))) throw new SqlError(`there is already a view named ${name}`);
  if (hit(Object.keys(schema.indexes))) throw new SqlError(`there is already an index named ${name}`);
}

const NOOP: ParsedDdl = { sql: [], defs: [], drops: [], user: null, noop: true };

export function globalIndexTable(ix: Pick<GlobalIndexDef, "name">): { def: TableDef; sql: string } {
  const table = `__gidx_${ix.name}`;
  // 1 つの値に 1 つの項目。主キーが、同じ値の 2 つ目の項目を断る。
  const pk = ["k"];
  return {
    def: {
      name: table, columns: ["k", "pk", "sk"], pk, shardKey: ["k"], uniques: [], globalIndexes: [],
      implicitRowid: false, rowidAlias: null, skAffinity: ["TEXT"],
      affinity: { k: "TEXT", pk: "TEXT", sk: "TEXT" }, collated: [], collation: {},
    },
    sql: `CREATE TABLE ${q(table)} ("k" TEXT NOT NULL, "pk" TEXT NOT NULL, "sk" TEXT NOT NULL, PRIMARY KEY (${pk.map(q).join(", ")}))`,
  };
}

/**
 * シャードをまたぐ UNIQUE の列には、各シャードの表にも同じ列の (一意でない) index を作る。
 * 一意性は index の表 (`__gidx_*`) が守る。こちらは、行のシャードがその列で行を引くための、ただの索引である。
 */
const rowIndexName = (ix: Pick<GlobalIndexDef, "name">): string => `__gidx_${ix.name}__rows`;
const rowIndexSql = (ix: Pick<GlobalIndexDef, "name" | "columns">, table: string): string =>
  `CREATE INDEX ${q(rowIndexName(ix))} ON ${q(table)} (${ix.columns.map(q).join(", ")})`;

const isFk = (c: Node) => c.type === "references_specification" || c.type === "constraint_foreign_key";
const inner = (item: Node) => (item.type === "constraint" ? item.constraint : item);
const specCols = (c: Node): string[] => c.columns.expr.items.map((i: Node) => ident(i.type === "index_specification" ? i.expr : i));

function createTable(source: string, stmt: Node, schema: SchemaView): ParsedDdl {
  // TEMP の表は接続ごとのもので、シャードにも、Worker の SQLite にも置き場がない。普通の表として作ってしまうと、消えない。
  const kind = stmt.kind?.kindKw?.name;
  const schemaName = stmt.name?.type === "member_expr" ? ident(stmt.name.object).toLowerCase() : null;
  if (kind === "TEMP" || kind === "TEMPORARY" || schemaName === "temp") unsupported("TEMP tables");
  const name = userName(ident(stmt.name), "table");
  if (schema.tables[name] || schema.views[name]) {
    if (stmt.ifNotExistsKw) return NOOP;
    throw new SqlError(`table ${name} already exists`);
  }
  assertFree(schema, name);
  const items: Node[] = stmt.columns.expr.items;
  const columns: string[] = [];
  const types = new Map<string, string | null>();
  const collated = new Set<string>();
  const collation: Record<string, string> = {};
  const defaults: string[] = [];
  let pk: string[] = [];
  const uniqueSets: string[][] = [];
  for (const item of items) {
    if (item.type !== "column_definition") {
      const c = inner(item);
      if (c.type === "constraint_primary_key") pk = specCols(c);
      if (c.type === "constraint_unique") uniqueSets.push(specCols(c));
      continue;
    }
    const col = userColumn(ident(item.name));
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
      if (c.type === "constraint_generated") unsupported("generated columns");
      if (c.type === "constraint_default") defaults.push(col);
    }
  }
  const withoutRowid = (stmt.options?.items ?? stmt.options?.options?.items ?? []).some((o: Node) => /WITHOUT/i.test(text(o)));
  const implicitRowid = pk.length === 0;
  if (implicitRowid) pk = ["rowid"];
  const single = pk.length === 1 ? pk[0]! : null;
  const rowidAlias = !withoutRowid && single && /^INTEGER$/i.test((types.get(single) ?? "").trim()) ? single : null;
  // shard key は主キーの先頭の列で決まる (主キーのない表では rowid)。同じ先頭の値の行は同じシャードに載る
  // (`PRIMARY KEY (tenant_id, id)` ならテナントごと)。2026-11-14 に、別の列を選ぶ `SHARD KEY (...)` の句を消した
  // (持ち主の決定)。使っていた所はどれも主キーの先頭の列を選んでいて、Drizzle などの道具は句を出せず、パーサも読めなかった。
  const sk = [pk[0]!];
  // 行と shard key の同一性は、値をそのまま比べて決める。照合順序で等しい値 ('abc' と 'ABC') を同じ行として扱うには、
  // 経路、分割、ロック、検証のすべてで同じ規則が要る。その規則を確かめきるまで、キーの列の照合順序は受け付けない。
  for (const c of new Set([...pk, ...sk])) {
    if ((collation[c] ?? "BINARY") !== "BINARY") unsupported(`COLLATE ${collation[c]} on the primary key or shard key column ${c}`);
  }
  for (const cols of uniqueSets) {
    const bad = cols.find((c) => (collation[c] ?? "BINARY") !== "BINARY");
    if (bad && !sk.every((c) => cols.includes(c))) unsupported(`COLLATE ${collation[bad]} on column ${bad} of a UNIQUE constraint that does not include the shard key`);
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
    affinity: Object.fromEntries(columns.map((c) => [c, affinityOf(types.get(c) ?? null)])),
    collated: [...collated],
    collation,
    defaults,
  };
  const sql = [text(stmt), ...captureDdl(def)];
  const defs: TableDef[] = [];
  const indexes: Record<string, IndexInfo> = {};
  uniqueSets.forEach((cols, i) => {
    if (isGlobal(cols)) {
      const ix: GlobalIndexDef = { name: `${name}_${i}_key`, table: `__gidx_${name}_${i}_key`, columns: cols };
      const t = globalIndexTable(ix);
      def.globalIndexes.push(ix);
      sql.push(t.sql, rowIndexSql(ix, name));
      defs.push(t.def);
    } else def.uniques.push(cols);
  });
  return { sql, defs: [def, ...defs], drops: [], user: source, indexes };
}

function createIndex(source: string, stmt: Node, schema: SchemaView): ParsedDdl {
  const name = userName(ident(stmt.name), "index");
  const table = ident(stmt.table);
  if (schema.indexes[name]) {
    if (stmt.ifNotExistsKw) return NOOP;
    throw new SqlError(`index ${name} already exists`);
  }
  assertFree(schema, name);
  const found = existingTable(schema, table);
  if (!found) throw new SqlError(`no such table: main.${table}`);
  const def = structuredClone(found);
  const unique = stmt.indexTypeKw?.name === "UNIQUE";
  const specs: Node[] = stmt.columns.expr.items;
  const plain = specs.every((s) => s.expr.type === "identifier");
  const partial = !!(stmt.clauses ?? []).some((c: Node) => c.type === "where_clause");
  const cols = plain ? specs.map((s) => ident(s.expr)) : [];
  for (const c of cols) if (!def.columns.includes(c) && c !== "rowid") throw new SqlError(`no such column: ${c}`);
  // 一意でない index は、shard key を含まなくても、各シャードの中の index にする。行の置き場所を変えず、書き込みの費用も増やさない。
  // shard key で絞れない検索は全シャードへ送られるが、各シャードはこの index で引ける。
  // シャードをまたいで保守する index は、一意性の保証に必要な UNIQUE だけにする。
  const local = (plain && def.shardKey.every((c) => cols.includes(c))) || !plain || partial || !unique;
  if (local) {
    if (unique && !(plain && def.shardKey.every((c) => cols.includes(c)))) {
      throw new SqlError("unsupported: a UNIQUE partial or expression index that does not include the shard key");
    }
    // 部分 index も記録する。記録しないと、書き込みの UNIQUE の検査がこの表を飛ばし、確定した後の適用で初めて違反になる。
    if (unique) def.uniques.push(cols);
    if (unique && partial) def.partialUnique = true;
    const drop = `DROP INDEX IF EXISTS ${q(name)}`;
    return { sql: [text(stmt)], defs: [def], drops: [], user: source, indexes: { [name]: { table, global: false } }, undo: { sql: [drop], user: drop } };
  }
  const collatedCol = unique ? cols.find((c) => (def.collation[c] ?? "BINARY") !== "BINARY") : undefined;
  if (collatedCol) unsupported(`COLLATE ${def.collation[collatedCol]} on column ${collatedCol} of a UNIQUE index that does not include the shard key`);
  // 既存の行から作る。この版は、index の表を用意して、元の表を書き込み禁止にするだけである。index は、既存の行の項目を
  // 埋め終えて公開の版が記録されるまで、表定義にも、Worker の SQLite にも現れない。作れなければ、この版ごと取り消す。
  const ix: GlobalIndexDef = { name, table: `__gidx_${name}`, columns: cols };
  const t = globalIndexTable(ix);
  def.building = ix;
  return {
    sql: [t.sql, rowIndexSql(ix, table)], defs: [def, t.def], drops: [], user: null,
    build: { table, index: name, user: source },
    undo: { sql: [`DROP TABLE IF EXISTS ${q(ix.table)}`, `DROP INDEX IF EXISTS ${q(rowIndexName(ix))}`], user: null },
  };
}

/** 作っている最中の index を公開する。表定義に index を入れ、書き込み禁止を解く。 */
export function publishBuild(def: TableDef, build: NonNullable<ParsedDdl["build"]>): ParsedDdl {
  const next = structuredClone(def);
  const ix = next.building!;
  delete next.building;
  next.globalIndexes.push(ix);
  return { sql: [], defs: [next], drops: [], user: build.user, indexes: { [build.index]: { table: build.table, global: true } } };
}

function dropTable(source: string, stmt: Node, schema: SchemaView): ParsedDdl {
  const out: ParsedDdl = { sql: [], defs: [], drops: [], user: source, dropIndexes: [] };
  for (const t of stmt.tables.items) {
    const name = ident(t.type === "member_expr" ? t.property : t);
    const def = existingTable(schema, name);
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
  if (!info.global) return { sql: [text(stmt)], defs: [], drops: [], user: source, dropIndexes: [name] };
  const def = structuredClone(schema.tables[info.table]!);
  const ix = def.globalIndexes.find((g) => g.name === name)!;
  def.globalIndexes = def.globalIndexes.filter((g) => g.name !== name);
  return { sql: [`DROP TABLE IF EXISTS ${q(ix.table)}`, `DROP INDEX IF EXISTS ${q(rowIndexName(ix))}`], defs: [def], drops: [ix.table], user: source, dropIndexes: [name] };
}

function alterTable(source: string, stmt: Node, schema: SchemaView): ParsedDdl {
  const name = ident(stmt.table);
  const found = existingTable(schema, name);
  if (!found) throw new SqlError(`no such table: ${name}`);
  const def = structuredClone(found);
  if (stmt.actions.items.length !== 1) throw new SqlError("ALTER TABLE takes one action per statement");
  const action = stmt.actions.items[0];
  const sql: string[] = dropCaptureDdl(name);
  switch (action.type) {
    case "alter_action_rename": {
      const to = userName(ident(action.newName), "table");
      if (schema.tables[to]) throw new SqlError(`there is already another table or index with this name: ${to}`);
      assertFree(schema, to);
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
      const added = userColumn(ident(col.name));
      def.columns.push(added);
      // 型親和性と照合順序も記録する。無いと、この列の index を引くときに値を正規化できず、行を見つけられない。
      def.affinity[added] = affinityOf(col.dataType ? text(col.dataType) : null);
      for (const raw of col.constraints ?? []) {
        const c = inner(raw);
        if (c.type === "constraint_generated") unsupported("generated columns");
        if (c.type === "constraint_default" && def.defaults) def.defaults.push(added);
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
      // 列の名前や数を変える DDL は、未決着の intent と変更ログの行イメージの形を変える。分割と重なる場合も含めて
      // 確かめきるまで、受け付けない。表を作り直して移す (CREATE、INSERT ... SELECT、DROP、RENAME TO) ことはできる。
      unsupported("ALTER TABLE ... RENAME COLUMN");
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
      unsupported("ALTER TABLE ... DROP COLUMN");
      const col = ident(action.column);
      if (!def.columns.includes(col)) throw new SqlError(`no such column: "${col}"`);
      if (def.pk.includes(col)) throw new SqlError(`cannot drop PRIMARY KEY column: "${col}"`);
      if (def.globalIndexes.some((g) => g.columns.includes(col))) throw new SqlError(`cannot drop indexed column: "${col}"`);
      sql.push(`ALTER TABLE ${q(name)} DROP COLUMN ${q(col)}`);
      def.columns = def.columns.filter((c) => c !== col);
      delete def.affinity[col];
      delete def.collation[col];
      def.collated = def.collated.filter((c) => c !== col);
      break;
    }
    default:
      throw new SqlError(`unsupported ALTER TABLE action: ${action.type}`);
  }
  sql.push(...captureDdl(def));
  return { sql, defs: [def], drops: [], user: source };
}

export function parseDdl(source: string, schema: SchemaView): ParsedDdl {
  const clean = source.trim().replace(/;$/, "");
  // 1 回の DDL は 1 文だけにする。先頭の文しか調べないので、後ろに文が続いていると、調べていない SQL が
  // Meta と全シャードの SQLite でそのまま実行され、履歴にも残る。
  const stmts = parseStatements(clean);
  if (stmts.length !== 1) throw new SqlError("a schema change must be exactly one statement");
  const stmt = stmts[0];
  switch (stmt.type) {
    case "create_table_stmt": return createTable(clean, stmt, schema);
    case "create_index_stmt": return createIndex(clean, stmt, schema);
    case "drop_table_stmt": return dropTable(clean, stmt, schema);
    case "drop_index_stmt": return dropIndex(clean, stmt, schema);
    case "alter_table_stmt": return alterTable(clean, stmt, schema);
    // trigger は受け付けない。本体が他の表を読み書きするので、1 シャードでは発火できない。
    case "create_trigger_stmt": return unsupported("CREATE TRIGGER");
    case "drop_trigger_stmt": {
      // trigger は作れないので、消すものもない。
      if (stmt.ifExistsKw) return NOOP;
      throw new SqlError(`no such trigger: ${ident(stmt.trigger)}`);
    }
    case "create_view_stmt": {
      const name = userName(ident(stmt.name), "view");
      if (schema.views[name]) {
        if (stmt.ifNotExistsKw) return NOOP;
        throw new SqlError(`view ${name} already exists`);
      }
      assertFree(schema, name);
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
