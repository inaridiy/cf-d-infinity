// 実行履歴が commit 時刻順の直列実行と一致するかを検査する (Elle の簡易版)。
export type Key = string; // "tenant/id"
export interface Read {
  key?: Key;
  /** tenant 内の述語読み。行数と合計を比べる。 */
  tenant?: number;
  value: unknown;
}
export interface TxRecord {
  name: string;
  /** 書き込みなら commit 時刻、読み取りだけなら T。 */
  ts: number;
  readOnly: boolean;
  reads: Read[];
  writes: { key: Key; value: number | null }[];
}

export interface Violation {
  txn: string;
  read: Read;
  expected: unknown;
}

function evalRead(state: Map<Key, number>, r: Read): unknown {
  if (r.key !== undefined) return state.get(r.key) ?? null;
  let count = 0;
  let sum = 0;
  for (const [k, v] of state) {
    if (k.startsWith(`${r.tenant}/`)) {
      count++;
      sum += v;
    }
  }
  return { count, sum };
}

/** 書き込みは ts の順に適用する。読み取りだけの取引は ts 以下の commit を見る。 */
export function checkHistory(history: TxRecord[], initial: Map<Key, number> = new Map()): Violation[] {
  const order = [...history].sort((a, b) => a.ts - b.ts || Number(a.readOnly) - Number(b.readOnly));
  // 同じ ts の書き込みは互いに素なシャードの取引なので、先に全部適用してから読み取りを見る。
  const violations: Violation[] = [];
  const state = new Map(initial);
  for (const t of order) {
    for (const r of t.reads) {
      const expected = evalRead(state, r);
      if (JSON.stringify(expected) !== JSON.stringify(r.value)) violations.push({ txn: t.name, read: r, expected });
    }
    for (const w of t.writes) {
      if (w.value === null) state.delete(w.key);
      else state.set(w.key, w.value);
    }
  }
  return violations;
}
