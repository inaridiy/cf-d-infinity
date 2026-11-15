// 論理エクスポートと取り込み。Worker の入口 (worker.ts) と試験の両方から使うので、Workers の実行環境に依存させない。
//
// 頁の行は、JSON で運べる形 (書き出しの形) で返す。CLI (bin/cli.js) は、行を JSON で受け取って bin/dump.js の literal で INSERT の
// 文に書き、取り込みでは同じ形の行を importRows へ渡す。形は段 2 までと同じで、INTEGER は JS の数、整数の値の REAL は `{ real }`、
// BLOB は `{ $blob: 16 進 }` である。段 3 で、JS の数で正確に表せない INTEGER (2^53 以上) が保存できるようになったので、
// `{ $int: "数字" }` を足した。CLI とのあいだの JSON は、段 4 でタプルに替える (docs/design-values.md の「エクスポートと取り込み」)。
import type { Cluster, Db } from "./client/db";
import { shardsOf } from "./routing";
import type { Value } from "./types";

export interface ExportCursor {
  shard: number;
  /** 続きの位置の主キーの値。書き出しの形 (exportValue) で持つ。JSON で CLI を往復する。 */
  after: unknown[] | null;
  /** このシャードで読み終えた行数。主キーに NULL を含む行で頁が終わったときは、これで続きを表す。 */
  seen?: number;
}

const hex = (v: Uint8Array) => Array.from(v, (b) => b.toString(16).padStart(2, "0")).join("");
const unhex = (s: string) => Uint8Array.from(s.match(/../g) ?? [], (h) => parseInt(h, 16));

/** 値を書き出しの形にする。 */
export function exportValue(v: Value): unknown {
  if (typeof v === "bigint") return Number.isSafeInteger(Number(v)) ? Number(v) : { $int: String(v) };
  if (typeof v === "number") return Number.isInteger(v) ? { real: v } : v;
  if (v instanceof Uint8Array) return { $blob: hex(v) };
  return v;
}

/** 書き出しの形の値を、値に戻す。JS の数は、安全な整数なら INTEGER、ほかは REAL である。 */
export function importValue(v: unknown): Value {
  if (v === null || v === undefined) return null;
  if (typeof v === "number") return Number.isSafeInteger(v) ? BigInt(v) : v;
  if (typeof v === "object") {
    const o = v as { $blob?: unknown; $int?: unknown; real?: unknown };
    if (typeof o.$blob === "string") return unhex(o.$blob);
    if (typeof o.$int === "string" && /^-?[0-9]+$/.test(o.$int)) return BigInt(o.$int);
    if (typeof o.real === "number") return o.real;
  }
  return v as Value;
}

export async function exportPage(
  cluster: Cluster, table: string, cursor: ExportCursor | null, limit = 1000,
): Promise<{ columns: string[]; rows: unknown[][]; cursor: ExportCursor | null }> {
  const ids = shardsOf((await cluster.catalog()).routing);
  let at: ExportCursor = cursor ?? { shard: 0, after: null };
  for (;;) {
    if (at.shard >= ids.length) return { columns: [], rows: [], cursor: null };
    const page = await cluster.shard(ids[at.shard]!).exportRows({ table, after: at.after?.map(importValue) ?? null, limit, skip: at.seen ?? 0 });
    if (page.rows.length > 0) {
      const last = page.rows[page.rows.length - 1]!;
      const after = page.pk.map((i) => last[i] ?? null);
      const seen = (at.seen ?? 0) + page.rows.length;
      return {
        columns: page.columns, rows: page.rows.map((r) => r.map(exportValue)),
        cursor: { shard: at.shard, after: after.every((v) => v !== null) ? after.map(exportValue) : null, seen },
      };
    }
    at = { shard: at.shard + 1, after: null };
  }
}

/** export が書き出した行を入れる。値は引数で渡すので、文の長さの上限 (100 KB) に当たらない。行は書き出しの形で受ける。 */
export async function importRows(db: Db, table: string, columns: string[], rows: unknown[][]): Promise<number> {
  if (rows.length === 0) return 0;
  const quote = (id: string) => `"${id.replaceAll('"', '""')}"`;
  const tuple = `(${columns.map(() => "?").join(", ")})`;
  const res = await db.query(
    `INSERT INTO ${quote(table)}(${columns.map(quote).join(", ")}) VALUES ${rows.map(() => tuple).join(", ")}`,
    rows.flatMap((r) => r.map(importValue)),
  );
  return res.changes;
}
