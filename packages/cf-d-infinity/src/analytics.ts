import type { Cluster } from "./client/db";
import type { Change, TableDef, Ts } from "./types";
import { shardsOf } from "./routing";
import { imageColumns } from "./shard/rows";
import type { Elem, Tuple } from "./value";

export interface Snapshot {
  /** このスナップショットが表す時刻。W 以下の commit がすべて含まれる。 */
  W: Ts;
  /**
   * 表ごとの NDJSON。1 行が 1 回の行変更で、DuckDB で読む。row は列名から要素 (src/value.ts) への object で、消した行は null。
   * 要素は文字列か null なので、JSON にしても 64 ビットの整数、無限大、整数の値の REAL と INTEGER の区別、NUL を含む TEXT を
   * 失わない。表が消えていれば、列名を付けずにタプルのまま出す。
   */
  changes: { commit_ts: Ts; table: string; pk: string; deleted: boolean; row: Record<string, Elem> | Tuple | null }[];
}

/**
 * タプルに表定義の列名を付け直す。値は要素のまま出す。変更ログの古い行を、いまの表定義で読むので、短いことがある
 * (ADD COLUMN の前の行。足りない列は出さない)。表定義より長いタプルは、名前を付けられないので、タプルのまま出す。
 */
function named(def: TableDef, t: Tuple): Record<string, Elem> | Tuple {
  const columns = imageColumns(def);
  if (t.length > columns.length) return t;
  return Object.fromEntries(t.map((e, i) => [columns[i]!, e]));
}

/**
 * 全シャードの変更ログを集めて W を決める。本番ではシャードが R2 へ書き、
 * Compactor Container が同じ処理を行う。W より新しい変更は次回まで保留する。
 */
export async function collect(cluster: Cluster, pending: Snapshot["changes"] = []): Promise<Snapshot> {
  const { routing, tables } = await cluster.catalog();
  const parts = await Promise.all(shardsOf(routing).map((id) => cluster.shard(id).flush({})));
  const W = Math.min(...parts.map((p) => p.flushTs));
  const all = [
    ...pending,
    ...parts.flatMap((p) =>
      p.entries.flatMap((e) =>
        e.changes.filter((c) => !c.table.startsWith("__")).map((c: Change) => ({
          commit_ts: e.commitTs, table: c.table, pk: c.pk, deleted: c.after === null,
          row: c.after && tables[c.table] ? named(tables[c.table]!, c.after) : c.after,
        })),
      ),
    ),
  ];
  return { W, changes: all };
}
