// シャードへ送る文が「読む」と宣言する範囲 (span) を作る、唯一の場所。
//
// シャードは、宣言された範囲にある未決着の intent を決着させてから文を実行し、commit のときに、その範囲が読んだ後で
// 変わっていないかを検証する。文が範囲の外の行を読むと、その行は決着も検証もされず、取引の検証が成り立たない。
// だから、ここで作る範囲は、文が読み得る行をすべて含んでいなければならない。
//
// 既定は広く取る。狭めてよいのは、下に書いた規則に当てはまる形だけである。規則を足すときは、その形の文を
// 範囲の検査 (ShardDeps.spanEscape、試験では常に掛かる) に通してから足す。
import type { Scan } from "../sql/plan";
import type { Span, TableDef } from "../types";

/** 1 行だけを名指しする範囲。 */
export const rowSpan = (table: string, pk: string, sk: string): Span => ({ kind: "pk", table, pk, sk });
/** 1 つの shard key の値を持つ行の全部。 */
export const groupSpan = (table: string, sk: string): Span => ({ kind: "sk", table, sk });
/** そのシャードにある、表の行の全部。 */
export const tableSpan = (table: string): Span => ({ kind: "table", table });

/**
 * 試験用の切り替え。過去の欠陥を戻して、範囲の検査がそれを見つけることを確かめるのに使う。本番のコードは触らない。
 * rowSpanDespiteUnique: シャード内の UNIQUE がある表への書き込みも、名指しした 1 行だけを範囲にする (2026-11 までの挙動)。
 */
export const spanFaults = { rowSpanDespiteUnique: false };

export interface StatementShape {
  /**
   * 文が読む表。SQLite のコンパイルで確かめた集合 (Db.tablesOf) を渡す。確かめられなかったら null を渡す。
   * null なら、どの表を読むか分からないものとして、全部の表を範囲にする。
   */
  tables: TableDef[] | null;
  /** 文が、この shard key の値の行だけを読むと分かっているとき。null なら、そのシャードの行を広く読む。 */
  sks: string[] | null;
  /** 1 つの表の 1 行を、主キーの等値で名指ししているとき、その主キー。 */
  pk: string | null;
  write: boolean;
}

/**
 * 利用者の文をそのままシャードへ送るときの範囲。
 *
 * 既定: shard key の値ごとに、文が読む表の全部の行。表が分からなければ、全部の表。
 * 狭める規則:
 *   1. 読みで、1 つの表の 1 行を主キーで名指ししている → その 1 行。
 *   2. 書き込みで、同じく 1 行を名指ししていて、その表にシャード内の UNIQUE がない → その 1 行。
 *      UNIQUE があると、文は同じ値を持つ別の行を読む (違反の検査、REPLACE や UPSERT が消す行、OR IGNORE の判定)。
 *      UNIQUE は shard key を含むので、その行は同じ shard key の値の中にある。既定の範囲で足りる。
 */
export function statementSpans(shape: StatementShape): Span[] {
  const { tables, sks, pk, write } = shape;
  if (sks === null) return tables === null ? [tableSpan("*")] : tables.map((t) => tableSpan(t.name));
  if (tables === null) return sks.map((sk) => groupSpan("*", sk));
  const only = tables.length === 1 ? tables[0]! : null;
  if (pk !== null && only && sks.length === 1 && (!write || only.uniques.length === 0 || spanFaults.rowSpanDespiteUnique)) return [rowSpan(only.name, pk, sks[0]!)];
  return tables.flatMap((t) => sks.map((sk) => groupSpan(t.name, sk)));
}

/**
 * 行を集めるための走査の範囲。走査の文と範囲を、同じ Scan から作る。
 * 条件を押し下げた走査は、その条件に関わる行だけを範囲にする。条件がなければ、表か、shard key の値の全部である。
 */
export function scanSpans(s: Scan, sks: string[] | null): Span[] {
  if (!s.where) return sks === null ? [tableSpan(s.table.name)] : sks.map((sk) => groupSpan(s.table.name, sk));
  const base = { kind: "pred" as const, table: s.table.name, alias: s.where.alias, where: s.where.sql, params: s.where.params };
  return sks === null ? [base] : sks.map((sk) => ({ ...base, sk }));
}
