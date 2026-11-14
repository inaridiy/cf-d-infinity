// 範囲表。行の置き場所は token という 1 つの整数で、範囲表は token の半開区間 [start, end) をシャードに対応させる。
// 増設は、区間の持ち主の移動だけで表す。行の token の計算は増設の前後で変わらないので、Worker のキャッシュが古くても
// シャードが NotOwner を返すだけで済む。
//
//   token = region × 2^32 + slot × 2^16 + subslot   (40 ビット。JS の安全な整数に収まる)
//     region   いまは 0。行ごとに置く地域を決める拡張のために、上位の 8 ビットを空けてある。
//     slot     shard key のキー文字列の hash の上位 16 ビット。65,536 個ある。
//     subslot  主キーのキー文字列の hash の下位 16 ビット。65,536 個ある。
//
// 同じ shard key の行は、連続した 65,536 個の token (その slot のブロック) に載る。区間の境目がブロックの中に落ちないかぎり、
// 同じ shard key の行は 1 つのシャードに集まる。境目をブロックの中に置くと、1 つの shard key の行が主キーで 2 つのシャードに
// 分かれる (docs/design-subslots.md)。いまは、境目を slot の境目 (65,536 の倍数) にだけ置く。ブロックの中に境目のある範囲表は、
// 形式と関数が扱えるだけで、まだ作らない。
export const SLOTS = 65536;
export const SUBSLOTS = 65536;
/** 1 つの region の token の数。いまの行は、どれも region 0 の [0, REGION_TOKENS) に載る。 */
export const REGION_TOKENS = SLOTS * SUBSLOTS;
/** token の全体。region の 8 ビットを含む。 */
export const TOKENS = 256 * REGION_TOKENS;

/** token の半開区間 [start, end)。範囲表の項目、読む範囲の claim、範囲の移動の要求、分割の枠が、この形で範囲を運ぶ。 */
export interface Interval {
  start: number; // 含む
  end: number; // 含まない
}

export interface RangeEntry extends Interval {
  shard: string;
}

export interface Routing {
  version: number;
  ranges: RangeEntry[];
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

/**
 * shard key のキー文字列の slot の位置。その slot のブロックの最初の token である (region 0)。
 * 区間の境目と比べられるように、slot の番号ではなく token で返す。番号は、これを SUBSLOTS で割ったものである。
 */
export const slotOf = (sk: string): number => (hashKey(sk) >>> 16) * SUBSLOTS;
/**
 * 主キーのキー文字列の subslot。hash の下位 16 ビットである。表の名前は混ぜない。
 * 主キーが 1 列の表では、主キーの文字列と shard key の文字列が同じで、slot と subslot を 1 つの hash から取る。
 * 使うビットが重ならず、最後の攪拌が全ビットを混ぜるので、slot を固定しても subslot は偏らない。
 */
export const subslotOf = (pk: string): number => hashKey(pk) & 0xffff;
/** 行の token。 */
export const tokenOf = (sk: string, pk: string): number => slotOf(sk) + subslotOf(pk);
/** shard key の行の全部が載る区間 (その slot のブロック)。 */
export function blockOf(sk: string): Interval {
  const start = slotOf(sk);
  return { start, end: start + SUBSLOTS };
}

export const overlaps = (a: Interval, b: Interval): boolean => a.start < b.end && b.start < a.end;
/** outer が inner の全体を含むか。 */
export const contains = (outer: Interval, inner: Interval): boolean => outer.start <= inner.start && inner.end <= outer.end;
export const sameInterval = (a: Interval, b: Interval): boolean => a.start === b.start && a.end === b.end;
/** 区間の両端が slot の境目にあるか。そういう区間は、どのブロックも途中で切らない。 */
export const slotAligned = (x: Interval): boolean => x.start % SUBSLOTS === 0 && x.end % SUBSLOTS === 0;
/** 区間が、token の中の空でない範囲であることを確かめる。範囲表や記録に書く前に呼ぶ。 */
export function checkInterval(x: Interval): void {
  if (!Number.isInteger(x.start) || !Number.isInteger(x.end) || x.start < 0 || x.end > TOKENS || x.start >= x.end) {
    throw new Error(`invalid token range [${x.start}, ${x.end}): it must be a non-empty range within [0, ${TOKENS})`);
  }
}
/** 誤りの文に書く範囲。slot の境目に揃った区間は slot の番号で、そうでなければ token で書く。 */
export const rangeText = (x: Interval): string =>
  slotAligned(x) ? `slots [${x.start / SUBSLOTS}, ${x.end / SUBSLOTS})` : `tokens [${x.start}, ${x.end})`;

/** 最初の範囲表。region 0 の slot を、シャードの数で等分する。 */
export function initialRouting(shards: string[]): Routing {
  const n = shards.length;
  return {
    version: 1,
    ranges: shards.map((shard, i) => ({
      start: Math.floor((i * SLOTS) / n) * SUBSLOTS,
      end: Math.floor(((i + 1) * SLOTS) / n) * SUBSLOTS,
      shard,
    })),
  };
}

/**
 * 行を持つシャード。行の token を含む区間のシャードである。
 * pk を省くと、その shard key の行の全部を持つシャードを返す。ブロックが複数のシャードに分かれていれば、1 つに決まらないので投げる
 * (いまは、ブロックの中に境目を置かない。分かれた shard key の文は、後の段で ownersOf を使って基準経路へ回す)。
 */
export function ownerOf(r: Routing, sk: string, pk?: string): string {
  const block = blockOf(sk);
  if (pk !== undefined) {
    const token = block.start + subslotOf(pk);
    const hit = r.ranges.find((x) => token >= x.start && token < x.end);
    if (!hit) throw new Error(`slot ${block.start / SUBSLOTS} has no owner`);
    return hit.shard;
  }
  let part: string | undefined;
  for (const x of r.ranges) {
    if (!overlaps(x, block)) continue;
    // ブロックの全体を含む項目は、ほかの項目と重ならない。
    if (contains(x, block)) return x.shard;
    if (part !== undefined && part !== x.shard) {
      throw new Error(`slot ${block.start / SUBSLOTS} is split between ${part} and ${x.shard}; the owner of a row is decided by its primary key`);
    }
    part = x.shard;
  }
  if (part === undefined) throw new Error(`slot ${block.start / SUBSLOTS} has no owner`);
  return part;
}

/** shard key のブロックに重なる区間のシャードの全部。ふつうは 1 つで、ブロックの中に境目があれば 2 つ以上になる。範囲表の順に返す。 */
export function ownersOf(r: Routing, sk: string): string[] {
  const block = blockOf(sk);
  return [...new Set(r.ranges.filter((x) => overlaps(x, block)).map((x) => x.shard))];
}

export const shardsOf = (r: Routing): string[] => [...new Set(r.ranges.map((x) => x.shard))];
/** シャードが持つ区間。 */
export const regionsOf = (r: Routing, shard: string): Interval[] =>
  r.ranges.filter((x) => x.shard === shard).map((x) => ({ start: x.start, end: x.end }));

/**
 * 親の最も広い区間を半分に割って、子へ渡す区間を返す。割る位置は slot の境目だけで、区間に slot が 2 つ入らなければ割れない。
 * ブロックの中で割る判断は、後の段で足す (docs/design-subslots.md の「増設の判断」)。
 */
export function planSplit(r: Routing, parent: string): Interval | null {
  const mine = r.ranges.filter((x) => x.shard === parent).sort((a, b) => b.end - b.start - (a.end - a.start));
  const widest = mine[0];
  if (!widest) return null;
  // 区間の中にある slot の境目 (slot の番号で数える)。
  const first = Math.ceil(widest.start / SUBSLOTS);
  const last = Math.floor(widest.end / SUBSLOTS);
  if (last - first < 2) return null;
  return { start: Math.floor((first + last) / 2) * SUBSLOTS, end: widest.end };
}

/**
 * 区間 move を to のものにした範囲表を返す。move に重なる項目は切り分けて、重ならない部分を元の持ち主に残す。
 * 切り分けた後も、どの token にも持ち主がちょうど 1 つある (test/routing.test.ts)。
 */
export function applyMove(r: Routing, move: Interval & { to: string }): Routing {
  const ranges = r.ranges.flatMap((x) => {
    if (!overlaps(x, move)) return [x];
    const parts: RangeEntry[] = [];
    if (x.start < move.start) parts.push({ ...x, end: move.start });
    if (x.end > move.end) parts.push({ ...x, start: move.end });
    return parts;
  });
  ranges.push({ start: move.start, end: move.end, shard: move.to });
  return { version: r.version + 1, ranges: ranges.sort((a, b) => a.start - b.start) };
}
