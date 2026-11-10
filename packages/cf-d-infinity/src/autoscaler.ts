import type { Cluster } from "./client/db";
import { planSplit, shardsOf, type Routing } from "./routing";
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

export interface SplitResult {
  parent: string;
  child: string;
  start: number;
  end: number;
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
 * 増設の手順。各段は冪等なので、途中で落ちても最初からやり直せる。
 * 子の受け入れ、親の fence、範囲表の切り替え、データの移動の順に進める。
 */
export async function split(
  cluster: Cluster, parent: string, child: string,
  opts: { now?: () => number; range?: { start: number; end: number } } = {},
): Promise<SplitResult | null> {
  const now = opts.now ?? (() => Date.now());
  const cat = await cluster.catalog();
  // 途中で終わった増設があれば、同じ範囲を続ける。範囲表を切り替えた後で範囲を計算し直すと、別の範囲になり、
  // 元の範囲は親も子も「移動の途中」のまま残る。
  const [parentMoves, childMoves] = await Promise.all([cluster.shard(parent).moves({}), cluster.shard(child).moves({})]);
  const other = parentMoves.outgoing.find((m) => m.to !== child);
  if (other) throw new Error(`split: ${parent} is already handing slots [${other.start}, ${other.end}) to ${other.to}`);
  if (parentMoves.incoming.length > 0) throw new Error(`split: ${parent} is still receiving a range; split it after that finishes`);
  const unfinished = parentMoves.outgoing[0] ?? childMoves.incoming.find((m) => m.from === parent);
  if (unfinished && opts.range && (opts.range.start !== unfinished.start || opts.range.end !== unfinished.end)) {
    throw new Error(`split: ${parent} has an unfinished move of slots [${unfinished.start}, ${unfinished.end}) to ${child}; finish it first`);
  }
  const range = unfinished ? { start: unfinished.start, end: unfinished.end } : (opts.range ?? planSplit(cat.routing, parent));
  if (!range) return null;
  // 別の範囲を持つ既存のシャードを子にすると、移動が完了しないまま範囲が止まる。
  // 同じ範囲の再開は、切り替え後の子が範囲を持っているので通す。
  const owned = cat.routing.ranges.filter((r) => r.shard === child);
  if (owned.length > 0 && !owned.some((r) => r.start < range.end && range.start < r.end)) {
    throw new Error(`split: ${child} already owns other ranges`);
  }
  const t0 = now();
  const { schema } = await cluster.shard(child).beginIncoming({ ...range, from: parent, schema: cat.version });
  await cluster.shard(parent).fence({ ...range, to: child, schema });
  await cluster.switchRange({ ...range, to: child, from: parent });
  const moved = await cluster.shard(child).drain(range);
  await cluster.shard(parent).finishMove(range);
  await cluster.shard(child).finishIncoming(range);
  return { parent, child, ...range, ...moved, ms: now() - t0 };
}

/** 同時に問い合わせるシャードの数。多数へ一斉に投げると、往復時間が負荷と無関係に伸びる。 */
const PROBE_PARALLEL = 6;

export async function collectMetrics(cluster: Cluster): Promise<ShardMetrics[]> {
  const cat = await cluster.catalog();
  const ids = shardsOf(cat.routing);
  const out: ShardMetrics[] = new Array(ids.length);
  let next = 0;
  await Promise.all(Array.from({ length: Math.min(PROBE_PARALLEL, ids.length) }, async () => {
    for (let i = next++; i < ids.length; i = next++) {
      const t0 = Date.now();
      const m = await cluster.shard(ids[i]!).metrics({});
      out[i] = { ...m, probeMs: Date.now() - t0 };
    }
  }));
  return out;
}
