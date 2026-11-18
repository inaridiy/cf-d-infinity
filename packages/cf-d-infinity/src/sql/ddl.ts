import type { Affinity, GlobalIndexDef, TableDef } from "../types";
import { SqlError } from "../types";
import { captureDdl, dropCaptureDdl, q } from "../shard/rows";
import { affinityOf, ident, parseStatements, text, walk, type Node } from "./cst";

export interface IndexInfo {
  table: string;
  global: boolean;
}

export interface SchemaView {
  tables: Record<string, TableDef>;
  views: Record<string, string>;
  indexes: Record<string, IndexInfo>;
}

/**
 * 表定義の遷移の進め方 (docs/design-catalog-epoch.md の「表定義の遷移」)。どの DDL も prepare から commit か abort へ進む。
 *   plain  シャードは prepare を適用したことだけを答える。行で失敗しない DDL。
 *   trial  シャードは、prepare を適用した後で、書き込みを止めた表に文を試して巻き戻し、SQLite が通したかを答える。行で失敗し得る DDL
 *          (シャード内の UNIQUE index、式か WHERE のある index、ADD COLUMN)。
 *   build  行のある表に、シャードをまたぐ UNIQUE の index を作る。進める側が、止まった行を読んで index の表へ項目を書いてから commit する。
 *   guard  取引が読んだ表の DROP。進める側が、取引が読んだ範囲が読んだ後に変わっていないことを各シャードに確かめてから commit する。
 */
export type DdlMode = "plain" | "trial" | "build" | "guard";

export interface ParsedDdl {
  /** シャードで実行する文。commit を適用するときに実行する (trial では、prepare の後に試して巻き戻す)。 */
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
  /** 進め方。ないものは plain である。 */
  mode?: DdlMode;
  /**
   * prepare を適用したシャードが作る内部の表 (build の __gidx_<index>)。進める側は、commit の前に、この表へ項目を書く。
   * abort を適用したシャードは、defs の名前で表を消す。利用者の表には触らない。
   */
  staging?: { sql: string[]; defs: TableDef[] };
  /**
   * この DDL が、確定したときに変えるもの (docs/design-catalog-epoch.md の「表ごとの epoch」の「規則」)。畳み込み (src/catalog.ts の fold) が、
   * commit の記録で、挙げたものの epoch を進める。要求は、頼るものの epoch を運び、シャードは、それを自分の epoch と比べる。
   *   read   読みの epoch と書き込みの epoch が進む表。その表の読みが返すもの (列、行の形、表があるか) か、シャードが古い時刻の行を
   *          その表に読み戻せるかを変える DDL が挙げる。作る表、消す表、名前を変える表 (古い名前と新しい名前)、列を足す表、行で失敗し得る
   *          index (シャード内の UNIQUE、式か WHERE のある index) を作る表、消える内部の表 (__gidx_<index>)。
   *   write  書き込みの epoch だけが進む表。index を作るか消すだけの DDL が、その表を挙げる (index の名前ではない)。その表を読むだけの
   *          計画は、古いままでよい。読みの経路は index と UNIQUE の情報を使わないからである。
   *   views  epoch が進む view。作る view と消す view。
   * 何もしない DDL にはない。
   * DDL が待つ表の集合 (prepare の記録の fence) は、ここから導く (src/catalog.ts の fenceOf)。DDL の種類ごとには並べない。
   */
  changes?: DdlChanges;
}

export interface DdlChanges {
  read: string[];
  write: string[];
  views: string[];
}

/** 内部の表は `__` で始まる。利用者の表と名前が衝突すると、内部の状態を利用者の SQL で書き換えられる。 */
const INTERNAL_NAMES = new Set([
  "__arrived", "__cap", "__cap_on", "__ddl", "__epoch", "__fenced", "__incoming", "__intents", "__meta", "__moved", "__moved_txn",
  "__p", "__raw", "__routing", "__seq", "__slow", "__txn",
]);
/**
 * 内部で使う名前か。`__` で始まる名前を全部は取らない。移行の道具が `__new_<表名>` のような名前を使うからである。
 * 利用者の文が内部の表を名指しできないことは、名前の検査ではなく、Worker の SQLite でのコンパイルが守る
 * (そこには利用者の表しかない。Db.tablesOf)。ここで断るのは、内部の表と物理的に衝突する名前を作ることである。
 */
export const isInternalName = (name: string): boolean =>
  INTERNAL_NAMES.has(name.toLowerCase()) || /^(sqlite_|__gidx_|__cap_|__log_g)/i.test(name);

// 列の名前は予約しない。段 2 までは、`$` (列名つきの JSON の行イメージで、`$b` という名前の列が BLOB の印 `{"$b": ...}` と見分け
// られなかった。2026-11-13 の Codex の指摘 C2) と `__dinf_` (Worker やシャードが文に足す列の別名 `__dinf_typeof_<i>` が、同じ名前の
// 利用者の列を上書きした。指摘 C3) を予約していた。行イメージは列名を持たないタプルになり (段 2)、文に足す別名もなくなった (段 3。
// 型つきの読みの CTE の列 `"c0"` は位置で付けるので、利用者の列名とぶつからない)。docs/design-values.md の「消すものと、残す予約」。

/** 対応していない機能は、黙って通さずに断る。エラーは必ず `unsupported:` で始める。 */
const unsupported = (what: string): never => {
  throw new SqlError(`unsupported: ${what}`);
};

function userName(name: string, what: string): string {
  // `__dinf_` で始まる表の名前は、D∞ が文に足す CTE の名前 (型つきの読みの `__dinf_r`) と取り違えないように、作らせない。
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
/** 表の UNIQUE の列。パーサは、ここでは列の名前だけを読む (parser.ts の constraint)。 */
const specCols = (c: Node): string[] => c.columns.expr.items.map((i: Node) => ident(i));

/**
 * 表の制約の PRIMARY KEY の 1 列。SQLite の文法では `式 [COLLATE 名前] [ASC | DESC]` で、式は列の名前でなければならない
 * (括弧で包んでも、文字列の literal で書いてもよい)。列の名前と、書いてある照合順序を返す。
 * 節の形を確かめずに名前を取り出すと、`PRIMARY KEY (a COLLATE NOCASE)` で名前が undefined になり、TypeError で落ちていた。
 */
function keyColumn(spec: Node): { name: string; collations: string[] } {
  const collations: string[] = [];
  let e: Node = spec.type === "index_specification" ? spec.expr : spec;
  for (;;) {
    if (e.type === "binary_expr" && e.operator?.name === "COLLATE") {
      collations.push(ident(e.right).toUpperCase());
      e = e.left;
    } else if (e.type === "paren_expr" && e.expr?.type !== "list_expr") e = e.expr;
    else break;
  }
  if (e.type === "string_literal") return { name: e.value, collations };
  // SQLite の文言。列でない式 (`a + 1`、`lower(a)`) は、主キーにできない。
  if (e.type !== "identifier") throw new SqlError("expressions prohibited in PRIMARY KEY and UNIQUE constraints");
  return { name: ident(e), collations };
}

/**
 * CREATE TABLE のうち、文の形だけで断るもの。表があるかどうかや IF NOT EXISTS より先に確かめるので、同じ文はいつも断られる。
 * 計画 (plan.ts の planStatement) と DDL の解釈 (createTable) の両方がここを通す。`Db.query` に渡しても `Db.ddl` に渡しても、
 * 同じ文言になる。前は計画だけが断り、`Db.ddl` に渡した文は、列の並びがないので TypeError で落ちていた。
 */
export function assertPlainCreateTable(stmt: Node): void {
  // 仮想表 (FTS5、rtree など)。モジュールは Worker の SQLite に含まれず、行を主キーでシャードに分ける表でもない。
  if (stmt.kind?.kindKw?.name === "VIRTUAL") unsupported("CREATE VIRTUAL TABLE; virtual table modules such as FTS5 are not available");
  // 表の作成と行の挿入を 1 文で行うと、途中で失敗したときの後始末が要る。CREATE TABLE と INSERT ... SELECT に分けて書ける。
  if ((stmt.clauses ?? []).some((c: Node) => c.type === "as_clause")) unsupported("CREATE TABLE ... AS SELECT; create the table, then INSERT ... SELECT");
}

/**
 * 衝突の処理は、文の意味である。SQLite だけが決め、D∞ は SQLite が実行した結果を捕捉して運ぶ (計画書の不変条件 14)。
 * それを確かめきるまで、次の 2 つは形で断る (2026-11-15、UNIQUE の段 0 の差分の検査が、どちらも SQLite と違う答えを見つけた)。
 * - 制約に書いた衝突の処理 (`UNIQUE ... ON CONFLICT REPLACE` など。既定の ABORT は書いても同じなので受け付ける)。D∞ は記録せず、
 *   文の既定として効かせていなかった (test/open/unique-constraint-on-conflict の再現は、これで断る形になった)。
 * - 文の `OR FAIL` と `OR ROLLBACK` (planStatement)。
 * 文に書く衝突の処理 (OR IGNORE、OR REPLACE、REPLACE、ON CONFLICT DO) は使える。
 */
export function assertNoConstraintConflictAction(stmt: Node): void {
  let found: string | undefined;
  walk(stmt, (n) => {
    const action = n.type === "on_conflict_clause" ? (n.resolutionKw?.name as string | undefined) : undefined;
    if (action && action !== "ABORT") found ??= action;
  });
  if (found) {
    unsupported(`ON CONFLICT ${found} on a constraint; write the conflict handling in the statement instead (INSERT OR IGNORE, INSERT OR REPLACE, or INSERT ... ON CONFLICT DO)`);
  }
}

function createTable(source: string, stmt: Node, schema: SchemaView): ParsedDdl {
  assertPlainCreateTable(stmt);
  assertNoConstraintConflictAction(stmt);
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
  /** 表の制約の PRIMARY KEY に書いてある照合順序 (`PRIMARY KEY (a COLLATE NOCASE)`)。列ごと。 */
  const keyCollations: Record<string, string[]> = {};
  const uniqueSets: string[][] = [];
  for (const item of items) {
    if (item.type !== "column_definition") {
      const c = inner(item);
      if (c.type === "constraint_primary_key") {
        const cols: { name: string; collations: string[] }[] = c.columns.expr.items.map(keyColumn);
        pk = cols.map((k) => k.name);
        for (const k of cols) keyCollations[k.name] = [...(keyCollations[k.name] ?? []), ...k.collations];
      }
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
  // 列の定義に書いた照合順序 (`a TEXT COLLATE NOCASE PRIMARY KEY`) も、表の制約に書いた照合順序 (`PRIMARY KEY (a COLLATE NOCASE)`) も、
  // 主キーの一意性の比べ方を変えるので、同じに断る。BINARY と書いたものは、書かないのと同じである。
  for (const c of new Set([...pk, ...sk])) {
    const collated = [collation[c], ...(keyCollations[c] ?? [])].find((name) => name !== undefined && name !== "BINARY");
    if (collated) unsupported(`COLLATE ${collated} on the primary key or shard key column ${c}`);
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
  return {
    sql, defs: [def, ...defs], drops: [], user: source, indexes, mode: "plain",
    changes: { read: [name, ...defs.map((d) => d.name)], write: [], views: [] },
  };
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
    // 行で失敗し得る index (UNIQUE、式、WHERE) は、各シャードで試してから確定する。列だけの一意でない index は、どの行でも作れるので、
    // 試さない。どちらも、表の書き込みの epoch を進めるので、表の行ロックを待ち、確定まで表への書き込みを止める (src/catalog.ts の fenceOf)。
    const trial = unique || !plain || partial;
    // 行で失敗し得る index は、表の読みの epoch も進める。古い時刻の読みが前の行を読み戻すと、新しい UNIQUE や式で失敗し得るからである。
    // 列だけの一意でない index は、書き込みの epoch だけを進める。
    return {
      sql: [text(stmt)], defs: [def], drops: [], user: source, indexes: { [name]: { table, global: false } },
      mode: trial ? "trial" : "plain",
      changes: trial ? { read: [def.name], write: [], views: [] } : { read: [], write: [def.name], views: [] },
    };
  }
  const collatedCol = unique ? cols.find((c) => (def.collation[c] ?? "BINARY") !== "BINARY") : undefined;
  if (collatedCol) unsupported(`COLLATE ${def.collation[collatedCol]} on column ${collatedCol} of a UNIQUE index that does not include the shard key`);
  // 既存の行から作る (mode build)。prepare は、index の表 (staging) を作って、元の表への書き込みを止めるだけである。進める側が、
  // 止まった行を読んで項目を書き、commit が index を表定義と Worker の SQLite に入れる。commit までは、計画から見えない。
  // 行の側の index (一意でない) は、どの行でも作れるので、commit の文にする。作れなければ abort し、abort を適用したシャードが
  // index の表を名前で消す。
  const ix: GlobalIndexDef = { name, table: `__gidx_${name}`, columns: cols };
  const t = globalIndexTable(ix);
  def.globalIndexes.push(ix);
  // シャードをまたぐ UNIQUE は、読みの経路に使わない。表の書き込みの epoch だけを進める。index の表 (staging) は、prepare の epoch で生まれる。
  return {
    sql: [rowIndexSql(ix, table)], defs: [def, t.def], drops: [], user: source, indexes: { [name]: { table, global: true } },
    mode: "build", staging: { sql: [t.sql], defs: [t.def] },
    changes: { read: [], write: [def.name], views: [] },
  };
}

function dropTable(source: string, stmt: Node, schema: SchemaView): ParsedDdl {
  const out: ParsedDdl = { sql: [], defs: [], drops: [], user: source, dropIndexes: [], mode: "plain", changes: { read: [], write: [], views: [] } };
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
    // 表を消す DDL は、prepare から書き込みを止める (消す表は、読みの epoch が進む表なので、fence に入る)。全シャードが prepare を
    // 適用してから commit するので、DDL が完了を返した後に消えた表へ書き込みが届くことはない (M21 の m21_red_drop_missing_ack、
    // M11 の m11_red_no_sync)。
    for (const [i, info] of Object.entries(schema.indexes)) if (info.table === name) out.dropIndexes!.push(i);
  }
  // 消した表と、一緒に消える index の表。消した名前も、消した epoch を持ち続ける。
  out.changes!.read.push(...out.drops);
  return out.drops.length ? out : NOOP;
}

function dropIndex(source: string, stmt: Node, schema: SchemaView): ParsedDdl {
  const name = ident(stmt.indexes.items[0]);
  const info = schema.indexes[name];
  if (!info) {
    if (stmt.ifExistsKw) return NOOP;
    throw new SqlError(`no such index: ${name}`);
  }
  if (!info.global) {
    return { sql: [text(stmt)], defs: [], drops: [], user: source, dropIndexes: [name], mode: "plain", changes: { read: [], write: [info.table], views: [] } };
  }
  const def = structuredClone(schema.tables[info.table]!);
  const ix = def.globalIndexes.find((g) => g.name === name)!;
  def.globalIndexes = def.globalIndexes.filter((g) => g.name !== name);
  return {
    sql: [`DROP TABLE IF EXISTS ${q(ix.table)}`, `DROP INDEX IF EXISTS ${q(rowIndexName(ix))}`], defs: [def], drops: [ix.table], user: source, dropIndexes: [name],
    mode: "plain", changes: { read: [ix.table], write: [info.table], views: [] },
  };
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
      return { sql, defs: [def], drops: [name], user: source, indexes, mode: "plain", changes: { read: [name, to], write: [], views: [] } };
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
        if (c.type === "constraint_generated") unsupported("generated columns");
        if (c.type === "constraint_default" && def.defaults) def.defaults.push(added);
        if (c.type !== "constraint_collate") continue;
        def.collated.push(added);
        def.collation[added] = ident(c.collation).toUpperCase();
      }
      // CHECK や NOT NULL、STRICT の表の型は既存の行で検査されるので、行のあるシャードでだけ失敗し得る。どの ADD COLUMN も、表への
      // 書き込みを止めて、各シャードで試してから確定する (SQLite の ADD COLUMN は表の形を書き換えるだけで、試すのは安い)。
      sql.push(...captureDdl(def));
      return { sql, defs: [def], drops: [], user: source, mode: "trial", changes: { read: [name], write: [], views: [] } };
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
  return { sql, defs: [def], drops: [], user: source, mode: "trial", changes: { read: [name], write: [], views: [] } };
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
    case "alter_table_stmt":
      assertNoConstraintConflictAction(stmt);
      return alterTable(clean, stmt, schema);
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
      return { sql: [], defs: [], drops: [], user: clean, views: { [name]: clean }, mode: "plain", changes: { read: [], write: [], views: [name] } };
    }
    case "drop_view_stmt": {
      const name = ident(stmt.views.items[0]);
      if (!schema.views[name]) {
        if (stmt.ifExistsKw) return NOOP;
        throw new SqlError(`no such view: ${name}`);
      }
      return { sql: [], defs: [], drops: [], user: clean, dropViews: [name], mode: "plain", changes: { read: [], write: [], views: [name] } };
    }
    default:
      throw new SqlError(`unsupported statement: ${stmt.type}`);
  }
}
