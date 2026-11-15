// 論理エクスポートと取り込み。Worker の入口 (worker.ts) と試験の両方から使うので、Workers の実行環境に依存させない。
//
// 頁の行は、要素のタプル (src/value.ts の encodeTuple) で返す。CLI (bin/cli.js) は、頁を JSON で受け取って bin/dump.js の literal で
// INSERT の文に書き、取り込みでは literal から作った同じ形の行を importRows へ渡す。要素は文字列か null なので、JSON を通しても
// 64 ビットの整数、無限大、整数の値の REAL と INTEGER の区別、NUL を含む TEXT を失わない (docs/design-values.md の
// 「エクスポートと取り込み」)。続きの位置 (ExportCursor の after) も同じ形で CLI を往復する。
// 頁は形式の版 (EXPORT_FORMAT) を運び、取り込みは版の違う行を、何も書かずに断る。bin/dump.js も同じ版を持ち、書き出した file の
// 1 行目に書く (docs/storage-format.md の「エクスポート」)。
import type { Cluster, Db } from "./client/db";
import { shardsOf } from "./routing";
import { SqlError, type Value } from "./types";
import { decodeElem, encodeTuple, type Tuple } from "./value";

/** 書き出しの形式の版。bin/dump.js の EXPORT_FORMAT と同じ値である (test/export-import.test.ts が確かめる)。 */
export const EXPORT_FORMAT = 1;

export interface ExportCursor {
  shard: number;
  /** 続きの位置の主キーの値。要素のタプルで持つ。JSON で CLI を往復する。 */
  after: Tuple | null;
  /** このシャードで読み終えた行数。主キーに NULL を含む行で頁が終わったときは、これで続きを表す。 */
  seen?: number;
}

export interface ExportPage {
  format: typeof EXPORT_FORMAT;
  columns: string[];
  /** 表定義の列の順の要素のタプル。 */
  rows: Tuple[];
  cursor: ExportCursor | null;
}

/**
 * CLI から戻ってきたタプルを値に戻す。要素でないもの (JS の数、`{ $blob }` などの印の object、印のない文字列) は断る。
 * decodeElem は JS の数を REAL として受け取るので、確かめずに渡すと、形の違う行が別の値として入る。
 */
function tupleValues(t: unknown, n: number | null, what: string): Value[] {
  if (!Array.isArray(t) || (n !== null && t.length !== n)) throw new SqlError(`${what}: expected a row of ${n ?? "some"} elements`);
  return t.map((e: unknown) => {
    if (e !== null && typeof e !== "string") throw new SqlError(`${what}: ${JSON.stringify(e)?.slice(0, 40)} is not an element (a string or null)`);
    try {
      return decodeElem(e);
    } catch (err) {
      throw new SqlError(`${what}: ${(err as Error).message}`);
    }
  });
}

export async function exportPage(cluster: Cluster, table: string, cursor: ExportCursor | null, limit = 1000): Promise<ExportPage> {
  const ids = shardsOf((await cluster.catalog()).routing);
  let at: ExportCursor = cursor ?? { shard: 0, after: null };
  if (!Number.isSafeInteger(at.shard) || at.shard < 0) throw new SqlError("export cursor: shard must be a non-negative integer");
  for (;;) {
    if (at.shard >= ids.length) return { format: EXPORT_FORMAT, columns: [], rows: [], cursor: null };
    const after = at.after === null || at.after === undefined ? null : tupleValues(at.after, null, "export cursor");
    const page = await cluster.shard(ids[at.shard]!).exportRows({ table, after, limit, skip: at.seen ?? 0 });
    if (page.rows.length > 0) {
      const last = page.rows[page.rows.length - 1]!;
      const next = page.pk.map((i) => last[i] ?? null);
      const seen = (at.seen ?? 0) + page.rows.length;
      return {
        format: EXPORT_FORMAT, columns: page.columns, rows: page.rows.map(encodeTuple),
        cursor: { shard: at.shard, after: next.every((v) => v !== null) ? encodeTuple(next) : null, seen },
      };
    }
    at = { shard: at.shard + 1, after: null };
  }
}

/**
 * export が書き出した行を入れる。値は引数で渡すので、文の長さの上限 (100 KB) に当たらない。行は要素のタプルで受ける。
 * format は行の形式の版で、EXPORT_FORMAT でなければ断る。行を 1 つでも読めなければ、何も書かずに断る。
 */
export async function importRows(db: Db, table: string, columns: string[], rows: unknown, format: unknown): Promise<number> {
  if (format !== EXPORT_FORMAT) {
    throw new SqlError(`import: the rows are in export format ${JSON.stringify(format) ?? "(none)"}, and this Worker reads export format ${EXPORT_FORMAT}; use the cf-d-infinity command of the same version as the Worker`);
  }
  if (typeof table !== "string" || !Array.isArray(columns) || !columns.every((c) => typeof c === "string") || !Array.isArray(rows)) {
    throw new SqlError("import: expected a table name, a list of column names and a list of rows");
  }
  const values = rows.map((r, i) => tupleValues(r, columns.length, `import row ${i + 1}`));
  if (values.length === 0) return 0;
  const quote = (id: string) => `"${id.replaceAll('"', '""')}"`;
  const tuple = `(${columns.map(() => "?").join(", ")})`;
  const res = await db.query(
    `INSERT INTO ${quote(table)}(${columns.map(quote).join(", ")}) VALUES ${values.map(() => tuple).join(", ")}`,
    values.flat(),
  );
  return res.changes;
}
