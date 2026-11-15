// 結果の値を、D1 と同じ形で利用者へ返す (docs/design-values.md の「D1 互換の API、Service Binding、HTTP の JSON」)。
// D1 互換の API (src/client/d1.ts)、Service Binding (src/entrypoint.ts)、HTTP の /sql と /batch (src/worker.ts) が、この 1 か所を通す。
//
// 結果の INTEGER の形は intMode で選ぶ (@libsql/client と同じ)。"number" (既定) は JS の数で、JS の数で正確に表せない INTEGER
// (絶対値が 2^53 - 1 を超えるもの) は、黙って隣の値にせずに誤りにする (持ち主の判断の 1)。"bigint" は INTEGER をすべて bigint で、
// "string" はすべて 10 進の文字列で返す。REAL、TEXT、BLOB、NULL は、どの intMode でもそのままである。
// 誤りにするかどうかは値で決まり、行の置き場所にも、答えたのがシャードか Worker の SQLite かにも依らない。
// last_row_id も INTEGER なので、同じ規則で返す。"number" で JS の数にできない last_row_id は、文を実行した後で誤りになる。
import type { IntMode } from "../binding";
import { SqlError, type Row, type Value } from "../types";

export type { IntMode };

const MAX_SAFE = BigInt(Number.MAX_SAFE_INTEGER);

/** intMode の指定を確かめる。省略は "number"。JSON で返す入口 (HTTP) は bigint を書けないので、json で "bigint" を断る。 */
export function intModeOf(v: unknown, json = false): IntMode {
  if (v === undefined) return "number";
  if (v === "bigint" && json) throw new SqlError(`intMode "bigint": JSON cannot carry a bigint; use "string" to read every INTEGER as decimal digits`);
  if (v === "number" || v === "bigint" || v === "string") return v;
  throw new SqlError(`intMode must be "number", "bigint" or "string", not ${JSON.stringify(v)?.slice(0, 40)}`);
}

const tooWide = (v: bigint, what: string) =>
  new SqlError(`${what} ${v}, which a JavaScript number cannot hold exactly; pass intMode "bigint" or "string", read it over Hrana, or CAST it to TEXT`);

/** INTEGER 1 つを intMode の形にする。 */
function integer(v: bigint, mode: IntMode, what: string): number | bigint | string {
  if (mode === "bigint") return v;
  if (mode === "string") return String(v);
  if (v > MAX_SAFE || v < -MAX_SAFE) throw tooWide(v, what);
  return Number(v);
}

/** 値 1 つを intMode の形にする。INTEGER のほかは、そのままである。 */
export const valueOut = (v: Value, mode: IntMode): Value =>
  typeof v === "bigint" ? integer(v, mode, "the result holds the integer") : v;

/** 結果の行を、列名で引ける object にする。同名の列は後の列が勝つ (D1 と同じ)。 */
export const rowsOut = (columns: readonly string[], values: readonly Value[][], mode: IntMode): Row[] =>
  values.map((v) => Object.fromEntries(columns.map((c, i) => [c, valueOut(v[i] ?? null, mode)])));

/** 結果の行を、値の配列のまま intMode の形にする (D1 の raw)。 */
export const valuesOut = (values: readonly Value[][], mode: IntMode): Value[][] => values.map((r) => r.map((v) => valueOut(v, mode)));

/** last_insert_rowid を intMode の形にする。行を入れなかった文は null。 */
export const rowidOut = (id: bigint | null, mode: IntMode): number | bigint | string | null =>
  id === null ? null : integer(id, mode, "the statement ran, but its last_row_id is the integer");
