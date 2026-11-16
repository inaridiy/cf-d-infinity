import type { Cluster } from "./client/db";
import type { OpenMove } from "./catalog";
import { SplitBusy } from "./meta";
import { contains, planSplit, rangeText, sameInterval, shardsOf, type Interval, type Routing } from "./routing";
import { systemRuntime } from "./runtime";

export { SplitBusy } from "./meta";
import type { ShardHealth, ShardMetrics } from "./types";

export interface Thresholds {
  sizeBytes: number;
  writesPerSec: number;
  readsPerSec: number;
  /**
   * metrics 要求の往復時間がこれを超え、かつ負荷が閾値の saturatedLoad 倍以上なら飽和とみなす。
   * 平常時は約 15 ms だが、多数のシャードへ同時に問い合わせると負荷と無関係に数百 ms まで揺れる。
   * 往復時間だけで判定すると、本番では 1 シャードあたり約 330/s でも増設が始まった。
   */
  probeMs: number;
  saturatedLoad: number;
  /** 閾値を連続で超えた回数がこれに達したら増設する。 */
  sustainTicks: number;
  maxConcurrent: number;
  /** 負荷の大半が 1 グループなら増設しても解けない。 */
  hotGroupShare: number;
  /** 同じシャードを続けて割るまでの間隔 (ms)。 */
  cooldownMs: number;
  maxShards: number;
}

/** 本番の実測 (書き込み上限 約 950/s、読み取り 約 2,300/s) の約半分を既定にする。 */
export const DEFAULTS: Thresholds = {
  sizeBytes: 1_000_000_000,
  writesPerSec: 450,
  readsPerSec: 1150,
  probeMs: 150,
  saturatedLoad: 0.4,
  sustainTicks: 2,
  maxConcurrent: 4,
  hotGroupShare: 0.5,
  cooldownMs: 600_000,
  maxShards: 4096,
};

export interface AutoscalerState {
  over: Record<string, number>;
  lastSplit: Record<string, number>;
}

export type Decision =
  | { kind: "split"; shard: string; reason: string }
  | { kind: "notify"; shard: string; reason: string };

/** 判断の本体。副作用を持たないのでテストできる。 */
export function decide(metrics: ShardMetrics[], state: AutoscalerState, now: number, t: Thresholds): Decision[] {
  const out: Decision[] = [];
  let budget = t.maxConcurrent - metrics.filter((m) => m.migrating).length;
  const room = t.maxShards - metrics.length;
  for (const m of metrics) {
    const secs = Math.max(m.elapsedMs, 1) / 1000;
    const w = m.writes / secs;
    const r = m.reads / secs;
    const load = Math.max(w / t.writesPerSec, r / t.readsPerSec);
    const probe = m.probeMs ?? 0;
    const saturated = (probe >= t.probeMs && load >= t.saturatedLoad) || probe >= 4 * t.probeMs;
    const reason =
      m.size >= t.sizeBytes ? `size ${m.size}`
      : saturated ? `saturated, probe ${probe} ms at ${Math.round(load * 100)}% load`
      : w >= t.writesPerSec ? `writes ${Math.round(w)}/s`
      : r >= t.readsPerSec ? `reads ${Math.round(r)}/s`
      : null;
    state.over[m.id] = reason && m.elapsedMs > 0 ? (state.over[m.id] ?? 0) + 1 : 0;
    if (!reason || state.over[m.id]! < t.sustainTicks || m.migrating) continue;
    const last = state.lastSplit[m.id];
    if (last !== undefined && now - last < t.cooldownMs) continue;
    if (m.topGroup && m.topGroup.share >= t.hotGroupShare && !reason.startsWith("size")) {
      out.push({ kind: "notify", shard: m.id, reason: `group ${m.topGroup.g} takes ${Math.round(m.topGroup.share * 100)}%` });
      continue;
    }
    if (budget <= 0 || out.filter((d) => d.kind === "split").length >= room) continue;
    budget--;
    out.push({ kind: "split", shard: m.id, reason });
  }
  return out;
}

/**
 * 次の判断を tickMs 後に行う必要があるか。
 * 閾値を超えているシャード、移動中のシャード、未完了の増設のどれかがあれば追いかける。
 * どれもなければ alarm をやめ、次の Cron まで全シャードを起こさない。
 */
export function needsFollowUp(metrics: ShardMetrics[], state: AutoscalerState, pending: number): boolean {
  return pending > 0 || metrics.some((m) => m.migrating || (state.over[m.id] ?? 0) > 0);
}

/**
 * シャードの健全性から、運用者が見るべき問題を言葉にする。空なら問題はない。
 * 確定した取引が適用できない状態は、放っておいても直らないので、必ず最初に挙げる。
 */
export function healthProblems(shards: ShardHealth[]): string[] {
  const out: string[] = [];
  for (const h of shards) {
    if (h.schemaError) out.push(`${h.id}: cannot apply a schema change and refuses requests: ${h.schemaError}`);
    if (h.unapplied > 0 && h.redriveErrors.length > 0) {
      out.push(`${h.id}: ${h.unapplied} committed transaction(s) cannot be applied: ${h.redriveErrors[0]}`);
    } else if (h.redriveErrors.length > 0) {
      out.push(`${h.id}: background work keeps failing: ${h.redriveErrors[0]}`);
    }
    if (h.intents > 0 && h.oldestIntentMs > STUCK_INTENT_MS) {
      out.push(`${h.id}: ${h.intents} write(s) have waited ${Math.round(h.oldestIntentMs / 1000)} s for their transaction's outcome`);
    }
  }
  const formats = new Set(shards.map((h) => h.format));
  if (formats.size > 1) out.push(`shards run different storage formats: ${[...formats].sort().join(", ")} (a deploy is still rolling out, or was rolled back)`);
  return out;
}
/** intent がこれより長く残っていたら、決着が届いていないとみなす。再駆動は 5 秒ごとに試みる。 */
const STUCK_INTENT_MS = 30_000;

export interface SplitResult extends Interval {
  parent: string;
  child: string;
  groups: number;
  rows: number;
  bytes: number;
  ms: number;
}

/** 次に割り当てるシャード番号。Autoscaler を起動し直しても既存の番号を再利用しない。 */
export function nextShardNumber(routing: Routing, cluster: string, floor: number): number {
  const used = shardsOf(routing).map((id) => Number(id.slice(cluster.length + 1))).filter(Number.isInteger);
  return Math.max(floor, ...used.map((n) => n + 1));
}

/**
 * 増設の手順 (docs/design-catalog-epoch.md の「移動の遷移」、段 4)。手は 2 つで、どちらも冪等なので、途中で落ちても最初からやり直せる。
 *   1. Meta に移動を開かせる (startMove。move-start を記録する)。この記録が、範囲表の切り替えであり、親の fence であり、子の受け取りの
 *      始まりである。同じ移動がもう開いていれば、その epoch が返る (再開)。
 *   2. 子に、移動を終えるまで進めさせる (drain)。子は move-start を適用して受け取り始め、全グループを引き取り、親の時計を受け取り、
 *      受け取り終えた後で Meta に move-end を記録させる。子は、move-start を適用したときから、自分で (応答の後の仕事と alarm で) 同じ手順を
 *      進めているので、この要求は、それに合流するだけである (決めたこと 4)。進める側が 1 の後で止まっても、最新の範囲表の要求が子に
 *      届くか、Autoscaler が開いている移動を再開すれば (movesToResume)、子が始める。
 * 移す範囲は token の区間である。いまは planSplit が slot の境目で切った区間だけを返し、Meta も、そういう区間の移動だけを記録する。
 */
export async function split(
  cluster: Cluster, parent: string, child: string,
  opts: { now?: () => number; range?: Interval } = {},
): Promise<SplitResult | null> {
  const rt = cluster.runtime ?? systemRuntime;
  const now = opts.now ?? (() => rt.now());
  const cat = await cluster.catalog();
  // 途中で終わった増設があれば、同じ範囲を続ける。範囲を計算し直すと、別の範囲になり、元の移動は開いたまま残る。
  // 開いている移動と重なる移動は、Meta も断る (startMove)。ここで先に断るのは、誤りの文を、親と子の言葉にするためである。
  const open = await cluster.moves();
  const other = open.find((m) => m.from === parent && m.to !== child);
  if (other) throw new Error(`split: ${parent} is already handing ${rangeText(other)} to ${other.to}`);
  if (open.some((m) => m.to === parent)) throw new Error(`split: ${parent} is still receiving a range; split it after that finishes`);
  const unfinished = open.find((m) => m.from === parent && m.to === child);
  if (unfinished && opts.range && !sameInterval(opts.range, unfinished)) {
    throw new Error(`split: ${parent} has an unfinished move of ${rangeText(unfinished)} to ${child}; finish it first`);
  }
  const chosen = unfinished ?? opts.range ?? planSplit(cat.routing, parent);
  if (!chosen) return null;
  const range: Interval = { start: chosen.start, end: chosen.end };
  // 範囲表はもう子を指し、移動も閉じている。分割は終わっている (子が自分で終えた)。終わった分割の再開は成功として返す
  // (null は「割るものがない」の意味である)。運んだものはない。
  if (!unfinished && cat.routing.ranges.some((r) => r.shard === child && contains(r, range))) {
    return { parent, child, ...range, groups: 0, rows: 0, bytes: 0, ms: 0 };
  }
  const t0 = now();
  let epoch: number;
  try {
    ({ epoch } = await cluster.startMove({ from: parent, to: child, ...range }));
  } catch (e) {
    // 表定義の遷移が開いている (M21 の MOVE_WAITS_DDL)。終わってから、もう一度始める。
    const m = (e as Error)?.message ?? "";
    if (/schema busy:/.test(m)) throw new SplitBusy(m);
    throw e;
  }
  const moved = await cluster.shard(child).drain({ ...range, epoch });
  return { parent, child, ...range, ...moved, ms: now() - t0 };
}

/**
 * Meta に開いたまま残っている移動のうち、再開すべきもの。移動は取り消せないので、子が進めていなければ、子に進めさせる。
 * 子は、move-start を適用していれば、自分で (alarm で) 進めている。適用していなければ、誰かが子に知らせるまで始めない。
 */
export function movesToResume(moves: OpenMove[], running: (child: string) => boolean): SplitJobLike[] {
  return moves.filter((m) => !running(m.to)).map((m) => ({ parent: m.from, child: m.to, range: { start: m.start, end: m.end } }));
}
export interface SplitJobLike {
  parent: string;
  child: string;
  range: Interval;
}

/** 同時に問い合わせるシャードの数。多数へ一斉に投げると、往復時間が負荷と無関係に伸びる。 */
const PROBE_PARALLEL = 6;

export async function collectMetrics(cluster: Cluster): Promise<ShardMetrics[]> {
  const rt = cluster.runtime ?? systemRuntime;
  const cat = await cluster.catalog();
  const ids = shardsOf(cat.routing);
  const out: ShardMetrics[] = new Array(ids.length);
  let next = 0;
  await Promise.all(Array.from({ length: Math.min(PROBE_PARALLEL, ids.length) }, async () => {
    for (let i = next++; i < ids.length; i = next++) {
      const t0 = rt.now();
      const m = await cluster.shard(ids[i]!).metrics({});
      out[i] = { ...m, probeMs: rt.now() - t0 };
    }
  }));
  return out;
}
