// 文の結果の lastInsertRowid の基準 (docs/sql-language.md の「lastInsertRowid」)。差分の検査 (test/typed-diff-harness.ts、
// test/typed-diff.test.ts、test/placement-oracle.ts) が、どの経路の答えもこの 1 つの規則で比べる。
//
// 規則: 文が最後に入れた行の rowid。行を入れなかった文は null。REPLACE は行を入れる (消してから入れる) が、UPSERT の DO UPDATE と、
// OR IGNORE や DO NOTHING が入れなかった行は、入れたことにならない (SQLite の last_insert_rowid と同じ)。rowid が行のキーでない表
// (INTEGER PRIMARY KEY でない主キーの表、WITHOUT ROWID の表) の行は数えない。D∞ の行はそういう rowid を持たない (シャードごとの
// SQLite が振る番号で、どのシャードでも意味がない)。
//
// 基準の node:sqlite の last_insert_rowid() は、文をまたいで残る接続の値なので、そのままでは「この文が入れたか」が分からない。
// rowid がキーの表に TEMP の AFTER INSERT trigger を置き、文が入れた行の rowid を順に記録して、最後のものを読む。
// TEMP の trigger の書き込みは changes() に入らず、文が失敗すれば文と一緒に取り消される。
import type { DatabaseSync } from "node:sqlite";

const qi = (s: string) => `"${s.replaceAll('"', '""')}"`;

/** rowid が行のキーである表 (INTEGER PRIMARY KEY の列があるか、主キーがない、rowid を持つ表)。 */
function rowidTables(lite: DatabaseSync): string[] {
  const tables = lite.prepare(`SELECT name FROM pragma_table_list WHERE schema = 'main' AND type = 'table' AND wr = 0 AND name NOT LIKE 'sqlite_%'`).all() as { name: string }[];
  return tables.map((t) => t.name).filter((name) => {
    const pk = lite.prepare(`SELECT type FROM pragma_table_info(?) WHERE pk > 0`).all(name) as { type: string }[];
    return pk.length === 0 || (pk.length === 1 && pk[0]!.type.toUpperCase() === "INTEGER");
  });
}

/**
 * 基準の接続に、文が入れた行の記録を仕掛ける。表を作った後に呼ぶ (後から作った表は数えない)。
 * 返す関数は、文の前に start、文の後に last を呼ぶ。
 */
export function insertedRowids(lite: DatabaseSync): { start(): void; last(): bigint | null } {
  lite.exec(`CREATE TEMP TABLE IF NOT EXISTS "__inserted"(seq INTEGER PRIMARY KEY, id INTEGER)`);
  for (const t of rowidTables(lite)) {
    lite.exec(`CREATE TEMP TRIGGER IF NOT EXISTS ${qi(`__inserted_${t}`)} AFTER INSERT ON main.${qi(t)} BEGIN INSERT INTO "__inserted"(id) VALUES (new.rowid); END`);
  }
  return {
    start: () => lite.exec(`DELETE FROM "__inserted"`),
    last: () => {
      const st = lite.prepare(`SELECT id FROM "__inserted" ORDER BY seq DESC LIMIT 1`);
      st.setReadBigInts(true);
      const row = st.get() as { id: bigint } | undefined;
      return row ? row.id : null;
    },
  };
}
