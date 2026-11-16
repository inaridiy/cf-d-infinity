// DO の SQLite の上限 (計画書の不変条件 13)。
//
// DO の SQLite は、文の長さ、束縛の変数の数、複合 SELECT の項の数、1 つの値の大きさ、式の木の深さに上限がある。Worker は文をシャードへ
// 送る前に行をシャードごとに分けるので、同じ文でも、シャードが 1 つなら 1 つの長い文、2 つなら短い文 2 つになる。上限に
// 当たった文をそのまま断ると、成否が行の置き場所で決まる (2026-11-13 の README の確認の指摘 1)。
//
// そこで、上限はここ 1 か所で決め、次の 3 つがこれを使う。
//   - シャード (ShardCore.exec と execAuto) は、実行する文を、束縛のための書き換えの後の形で測り、超える文を実行せずに
//     ShardLimit で断る。SQLite の誤りの文面には頼らない。
//   - Worker は、ShardLimit を受けたら、その文を基準経路で実行し直す (NeedsReference。切り替えは runPlanned の 1 か所)。
//   - プランナは、自分が作る文 (行を集める走査、行ごとに分けた INSERT) をこの上限に収める。基準経路の走査は、上限を超える
//     条件を押し下げずに表を読むので、作りとして上限に収まる。
import { expressionDepth } from "./sql/depth";
import { Scanner } from "./sql/lexer";
import type { Value } from "./types";
import { bindTyped, typedReadSql } from "./value";

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
   * 式の木の深さ。公表の表にない。手元の workerd で測った (test/workerd-limits.test.ts)。数え方は src/sql/depth.ts にある。
   * 見積もりは SQLite の数え方より小さくならない (多めに出る)。シャードは、届いた文も、この見積もりで測って断る (段 3 から。計画書の
   * 未解決の問題 39)。多めに出た文は基準経路で実行し直されるので、答えは変わらない (Worker の SQLite の上限は 1,000 である)。
   */
  exprDepth: 100,
  /**
   * 1 回の要求でシャードが返す結果のバイト数 (src/shard/core.ts の sizeOf で数える)。DO の RPC の上限 (32 MiB) より十分小さい。
   * 1 つの文が集める合計の予算 (Db の BYTE_BUDGET) もこれ以下にする。そうしないと、行が 1 つのシャードに偏ったときだけ、
   * 予算の内側の結果を返せない。
   */
  resultBytes: 16_000_000,
} as const;

const utf8 = new TextEncoder();

/**
 * 複合 SELECT の項の数を、多めに数える。文の字句 (src/sql/lexer.ts の Scanner) のうち、引用しない語の UNION、INTERSECT、EXCEPT を
 * 数えて 1 を足す。文字列の literal、引用符で囲んだ識別子 ("union" など)、注釈、引数 (`$union`) は語の字句にならない。SQLite が
 * 数えるのは 1 つの複合 SELECT の項なので、別々の複合 SELECT があれば多めになるが、少なめにはならない。引用符の中の識別子を数えると、
 * そういう名前の列のある表は、どの走査も上限を超えることになり、基準経路でも読めなかった (2026-11-13 の Codex の 2 回目の見直し、
 * 指摘 8)。test/sim.ts の DO の模倣も、これで数える。
 * 前は手書きの走査と `\b` の正規表現で数えた。`$` や ASCII の外の文字に続く識別子の一部 (`UNION$`、`éUNION`) と引数の名前
 * (`$union`) を数え (多め)、番号つきの引数の直後の語 (`?1UNION`) を数えなかった (少なめ)。多めの数え方で、シミュレータの DO の
 * 模倣は、`UNION$a` のような名前の列が 5 つ以上ある表の CREATE TABLE を断った。利用者の文の引数は、シャードへ送る前に `?` に
 * 書き換わる (src/sql/cst.ts の bindParams) ので、少なめになる形は届かなかった (2026-11-16、test/lexical-scans.test.ts)。
 */
export function compoundTerms(sql: string): number {
  let terms = 1;
  const s = new Scanner(sql);
  while (s.next()) {
    if (s.kind !== "word") continue;
    // 長さと頭の文字 (小文字にして u、e、i) で先に絞る。語ごとに文字列を作らない。
    const len = s.end - s.start;
    const c = sql.charCodeAt(s.start) | 32;
    if (((len === 5 && c === 117) || (len === 6 && c === 101) || (len === 9 && c === 105)) && COMPOUND.has(sql.slice(s.start, s.end).toUpperCase())) terms++;
  }
  return terms;
}
const COMPOUND = new Set(["UNION", "EXCEPT", "INTERSECT"]);

/** 式の木の深さの見積もりを、文ごとに覚える。同じ形の文が何度も届くので、字句を読むのは 1 度で済む。 */
const depths = new Map<string, number>();
export function depthOf(sql: string): number {
  let d = depths.get(sql);
  if (d === undefined) {
    d = expressionDepth(sql);
    if (depths.size >= 1024) depths.delete(depths.keys().next().value!);
    depths.set(sql, d);
  }
  return d;
}

/**
 * 文が上限を超えるなら、その理由を返す。超えなければ null。束縛のための書き換え (src/value.ts の bindTyped) で文が長くなり、
 * 整数の引数を包む式は深さを 2 足すので、書き換えた後の文で測る。複合 SELECT の項は compoundTerms で多めに数える。
 * 式の木の深さは src/sql/depth.ts で多めに見積もる。読みは、シャードが型つきの読みに包んだ形で測る (包む式の分だけ、4 深くなる)。
 */
export function shardLimitOf(sql: string, params: readonly Value[]): string | null {
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
  const depth = depthOf(b.sql);
  if (depth > SHARD_LIMITS.exprDepth) return `the statement has an expression tree ${depth} deep, more than ${SHARD_LIMITS.exprDepth}`;
  return null;
}

/** 文が収まるか。プランナが自分の作る文を確かめるのに使う。 */
export const withinShardLimits = (sql: string, params: readonly Value[]): boolean => shardLimitOf(sql, params) === null;

/**
 * 結果を返す読みの文が、シャードが実行する形 (型つきの読みに包んだ文、src/value.ts の typedReadSql) で上限に収まるか。n は結果の
 * 列の数である。シャードは包んだ後の文を測る (ShardKernel.withinLimits) ので、プランナも同じ形で測る。包む前の文で測ると、
 * 基準経路の走査がシャードで断られ、基準経路から先がない。
 */
export const withinReadLimits = (sql: string, params: readonly Value[], n: number): boolean => shardLimitOf(typedReadSql(sql, n), params) === null;

/**
 * D∞ が作る文 (行イメージを読み書きする文、捕捉の trigger) が上限を超えるなら、その理由を返す。表を作るときに確かめる
 * (Db.assertReplays)。段 2 では、shardLimitOf に式の木の深さを加えた関数だった。段 3 で、shardLimitOf が深さも測るようになった。
 */
export const builtLimitOf = (sql: string, params: readonly Value[]): string | null => shardLimitOf(sql, params);

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
