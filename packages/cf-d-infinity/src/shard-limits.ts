// DO の SQLite の上限 (計画書の不変条件 13)。
//
// DO の SQLite は、文の長さ、束縛の変数の数、複合 SELECT の項の数、1 つの値の大きさに上限がある。Worker は文をシャードへ
// 送る前に行をシャードごとに分けるので、同じ文でも、シャードが 1 つなら 1 つの長い文、2 つなら短い文 2 つになる。上限に
// 当たった文をそのまま断ると、成否が行の置き場所で決まる (2026-11-13 の README の確認の指摘 1)。
//
// そこで、上限はここ 1 か所で決め、次の 3 つがこれを使う。
//   - シャード (ShardCore.exec と execAuto) は、実行する文を、束縛のための書き換えの後の形で測り、超える文を実行せずに
//     ShardLimit で断る。SQLite の誤りの文面には頼らない。
//   - Worker は、ShardLimit を受けたら、その文を基準経路で実行し直す (NeedsReference。切り替えは runPlanned の 1 か所)。
//   - プランナは、自分が作る文 (行を集める走査、行ごとに分けた INSERT) をこの上限に収める。基準経路の走査は、上限を超える
//     条件を押し下げずに表を読むので、作りとして上限に収まる。
import type { Value } from "./types";
import { bindTyped } from "./value";

/** DO の SQLite の公表されている上限 (Cloudflare の Durable Objects の limits) と、実測した複合 SELECT の項の数。 */
export const SHARD_LIMITS = {
  /** 文の長さ (UTF-8 のバイト数)。 */
  sqlBytes: 100_000,
  /** 束縛の変数の数。 */
  params: 100,
  /** 複合 SELECT (UNION、INTERSECT、EXCEPT) の項の数。公表の表にない。2026-11 に本番で測った。 */
  compoundTerms: 5,
  /** 1 つの値 (文字列か BLOB) のバイト数。 */
  valueBytes: 2_000_000,
  /**
   * 1 回の要求でシャードが返す結果のバイト数 (src/shard/core.ts の sizeOf で数える)。DO の RPC の上限 (32 MiB) より十分小さい。
   * 1 つの文が集める合計の予算 (Db の BYTE_BUDGET) もこれ以下にする。そうしないと、行が 1 つのシャードに偏ったときだけ、
   * 予算の内側の結果を返せない。
   */
  resultBytes: 16_000_000,
} as const;

const utf8 = new TextEncoder();

/**
 * 複合 SELECT の項の数を、多めに数える。文字列の literal、引用符で囲んだ識別子 ("union" など)、コメントを除いた文の
 * UNION、INTERSECT、EXCEPT を数えて 1 を足す。SQLite が数えるのは 1 つの複合 SELECT の項なので、別々の複合 SELECT が
 * あれば多めになるが、少なめにはならない。引用符の中の識別子を数えると、そういう名前の列のある表は、どの走査も上限を超える
 * ことになり、基準経路でも読めなかった (2026-11-13 の Codex の 2 回目の見直し、指摘 8)。test/sim.ts の DO の模倣も、これで数える。
 */
export function compoundTerms(sql: string): number {
  let code = "";
  for (let i = 0; i < sql.length; ) {
    const c = sql[i]!;
    const close = c === "'" ? "'" : c === '"' ? '"' : c === "`" ? "`" : c === "[" ? "]" : null;
    if (close) {
      for (i++; i < sql.length; i++) {
        if (sql[i] === close) {
          if (close !== "]" && sql[i + 1] === close) i++;
          else break;
        }
      }
      i++;
      code += " ";
    } else if (c === "-" && sql[i + 1] === "-") {
      const j = sql.indexOf("\n", i + 2);
      i = j < 0 ? sql.length : j + 1;
      code += " ";
    } else if (c === "/" && sql[i + 1] === "*") {
      const j = sql.indexOf("*/", i + 2);
      i = j < 0 ? sql.length : j + 2;
      code += " ";
    } else {
      code += c;
      i++;
    }
  }
  return 1 + (code.match(/\b(UNION|INTERSECT|EXCEPT)\b/gi)?.length ?? 0);
}

/**
 * 文が上限を超えるなら、その理由を返す。超えなければ null。束縛のための書き換え (src/value.ts の bindTyped) で文が長くなるので、
 * 書き換えた後の文で測る。複合 SELECT の項は compoundTerms で多めに数える。
 */
export function shardLimitOf(sql: string, params: Value[]): string | null {
  const b = bindTyped(sql, params, "real");
  const bytes = utf8.encode(b.sql).length;
  if (bytes > SHARD_LIMITS.sqlBytes) return `the statement is ${bytes} bytes, more than ${SHARD_LIMITS.sqlBytes}`;
  if (b.params.length > SHARD_LIMITS.params) return `the statement binds ${b.params.length} parameters, more than ${SHARD_LIMITS.params}`;
  const terms = compoundTerms(sql);
  if (terms > SHARD_LIMITS.compoundTerms) return `the statement has ${terms} compound SELECT terms, more than ${SHARD_LIMITS.compoundTerms}`;
  for (const p of b.params) {
    const n = typeof p === "string" ? utf8.encode(p).length : p instanceof Uint8Array ? p.byteLength : 0;
    if (n > SHARD_LIMITS.valueBytes) return `a parameter is ${n} bytes, more than ${SHARD_LIMITS.valueBytes}`;
  }
  return null;
}

/** 文が収まるか。プランナが自分の作る文を確かめるのに使う。 */
export const withinShardLimits = (sql: string, params: Value[]): boolean => shardLimitOf(sql, params) === null;

const PREFIX = "shard limit: ";

/**
 * シャードが、上限を超える文を実行せずに断る誤り。RPC を越えるとクラスは失われるので、Worker は文言の接頭辞で見分ける
 * (VersionSkew の "upgrading: " と同じ。SQLite の文面ではなく、この形式の約束である)。
 */
export class ShardLimit extends Error {
  constructor(reason: string) {
    super(`${PREFIX}${reason}`);
    this.name = "ShardLimit";
  }
}

export const isShardLimit = (e: unknown): boolean => e instanceof ShardLimit || (e instanceof Error && e.message.startsWith(PREFIX));
