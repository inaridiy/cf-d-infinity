// 範囲表。スロット数は固定で、増設はスロットの所有権の移動だけで表す。
// 行の所属スロットの計算が増設の前後で変わらないので、Worker のキャッシュが古くても
// シャードが NotOwner を返すだけで済む。
export const SLOTS = 4096;

export interface SlotRange {
  start: number; // 含む
  end: number; // 含まない
  shard: string;
}

export interface Routing {
  version: number;
  ranges: SlotRange[];
}

export function hashKey(sk: string): number {
  let h = 0x811c9dc5;
  for (let i = 0; i < sk.length; i++) {
    h ^= sk.charCodeAt(i);
    h = Math.imul(h, 0x01000193);
  }
  // FNV は短く似たキー (連番の ID) で上位ビットが偏るので、murmur3 の finalizer で混ぜる。
  h ^= h >>> 16;
  h = Math.imul(h, 0x85ebca6b);
  h ^= h >>> 13;
  h = Math.imul(h, 0xc2b2ae35);
  h ^= h >>> 16;
  return h >>> 0;
}

export const slotOf = (sk: string): number => Math.floor((hashKey(sk) / 2 ** 32) * SLOTS);

export function initialRouting(shards: string[]): Routing {
  const n = shards.length;
  return {
    version: 1,
    ranges: shards.map((shard, i) => ({
      start: Math.floor((i * SLOTS) / n),
      end: Math.floor(((i + 1) * SLOTS) / n),
      shard,
    })),
  };
}

export function ownerOfSlot(r: Routing, slot: number): string {
  const hit = r.ranges.find((x) => slot >= x.start && slot < x.end);
  if (!hit) throw new Error(`slot ${slot} has no owner`);
  return hit.shard;
}

export const ownerOf = (r: Routing, sk: string): string => ownerOfSlot(r, slotOf(sk));
export const shardsOf = (r: Routing): string[] => [...new Set(r.ranges.map((x) => x.shard))];
/** シャードが持つスロットの範囲を、[start, end) の組で返す。 */
export const rangesOf = (r: Routing, shard: string): [number, number][] =>
  r.ranges.filter((x) => x.shard === shard).map((x) => [x.start, x.end]);

/** 親の最も広い範囲を半分に割って、子へ渡す範囲を返す。幅 1 なら割れない。 */
export function planSplit(r: Routing, parent: string): { start: number; end: number } | null {
  const mine = r.ranges.filter((x) => x.shard === parent).sort((a, b) => b.end - b.start - (a.end - a.start));
  const widest = mine[0];
  if (!widest || widest.end - widest.start < 2) return null;
  return { start: Math.floor((widest.start + widest.end) / 2), end: widest.end };
}

export function applyMove(r: Routing, move: { start: number; end: number; to: string }): Routing {
  const ranges = r.ranges.flatMap((x) => {
    if (x.end <= move.start || x.start >= move.end) return [x];
    const parts: SlotRange[] = [];
    if (x.start < move.start) parts.push({ ...x, end: move.start });
    if (x.end > move.end) parts.push({ ...x, start: move.end });
    return parts;
  });
  ranges.push({ start: move.start, end: move.end, shard: move.to });
  return { version: r.version + 1, ranges: ranges.sort((a, b) => a.start - b.start) };
}
