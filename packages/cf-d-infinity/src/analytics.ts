import type { Cluster } from "./client/db";
import type { Change, Ts } from "./types";
import { shardsOf } from "./routing";

export interface Snapshot {
  /** このスナップショットが表す時刻。W 以下の commit がすべて含まれる。 */
  W: Ts;
  /** 表ごとの NDJSON。1 行が 1 回の行変更で、DuckDB で読む。 */
  changes: { commit_ts: Ts; table: string; pk: string; deleted: boolean; row: unknown }[];
}

/**
 * 全シャードの変更ログを集めて W を決める。本番ではシャードが R2 へ書き、
 * Compactor Container が同じ処理を行う。W より新しい変更は次回まで保留する。
 */
export async function collect(cluster: Cluster, pending: Snapshot["changes"] = []): Promise<Snapshot> {
  const { routing } = await cluster.catalog();
  const parts = await Promise.all(shardsOf(routing).map((id) => cluster.shard(id).flush({})));
  const W = Math.min(...parts.map((p) => p.flushTs));
  const all = [
    ...pending,
    ...parts.flatMap((p) =>
      p.entries.flatMap((e) =>
        e.changes.filter((c) => !c.table.startsWith("__")).map((c: Change) => ({
          commit_ts: e.commitTs, table: c.table, pk: c.pk, deleted: c.after === null, row: c.after,
        })),
      ),
    ),
  ];
  return { W, changes: all };
}
