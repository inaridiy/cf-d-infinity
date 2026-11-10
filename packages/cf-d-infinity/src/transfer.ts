// 論理エクスポートと取り込み。Worker の入口 (worker.ts) と試験の両方から使うので、Workers の実行環境に依存させない。
import type { Cluster, Db } from "./client/db";
import { shardsOf } from "./routing";
import type { Value } from "./types";

export interface ExportCursor {
  shard: number;
  after: Value[] | null;
  /** このシャードで読み終えた行数。主キーに NULL を含む行で頁が終わったときは、これで続きを表す。 */
  seen?: number;
}

export async function exportPage(
  cluster: Cluster, table: string, cursor: ExportCursor | null, limit = 1000,
): Promise<{ columns: string[]; rows: Value[][]; cursor: ExportCursor | null }> {
  const ids = shardsOf((await cluster.catalog()).routing);
  let at: ExportCursor = cursor ?? { shard: 0, after: null };
  for (;;) {
    if (at.shard >= ids.length) return { columns: [], rows: [], cursor: null };
    const page = await cluster.shard(ids[at.shard]!).exportRows({ table, after: at.after, limit, skip: at.seen ?? 0 });
    if (page.rows.length > 0) {
      const last = page.rows[page.rows.length - 1]!;
      const after = page.pk.map((i) => last[i] ?? null);
      const seen = (at.seen ?? 0) + page.rows.length;
      return { columns: page.columns, rows: page.rows, cursor: { shard: at.shard, after: after.every((v) => v !== null) ? after : null, seen } };
    }
    at = { shard: at.shard + 1, after: null };
  }
}

/** export が書き出した行を入れる。値は引数で渡すので、文の長さの上限 (100 KB) に当たらない。BLOB は { $blob: 16 進 } で受ける。 */
export async function importRows(db: Db, table: string, columns: string[], rows: unknown[][]): Promise<number> {
  if (rows.length === 0) return 0;
  const quote = (id: string) => `"${id.replaceAll('"', '""')}"`;
  const unhex = (s: string) => Uint8Array.from(s.match(/../g) ?? [], (h) => parseInt(h, 16));
  const value = (v: unknown): Value =>
    v === null || v === undefined ? null
      : typeof v === "object" && typeof (v as { $blob?: unknown }).$blob === "string" ? unhex((v as { $blob: string }).$blob)
      : (v as Value);
  const tuple = `(${columns.map(() => "?").join(", ")})`;
  const res = await db.query(
    `INSERT INTO ${quote(table)}(${columns.map(quote).join(", ")}) VALUES ${rows.map(() => tuple).join(", ")}`,
    rows.flatMap((r) => r.map(value)),
  );
  return res.changes;
}
