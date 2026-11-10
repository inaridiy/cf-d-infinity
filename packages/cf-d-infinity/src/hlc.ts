import type { Ts } from "./types";

// Ts は物理 ms × 1024 + 論理カウンタ。2^53 に収まり JSON をそのまま通せる。
const LOGICAL = 1024;
export const physicalToTs = (ms: number): Ts => ms * LOGICAL;
export const tsToPhysical = (ts: Ts): number => Math.floor(ts / LOGICAL);
export const SECOND: Ts = 1000 * LOGICAL;

/** 発行のたびに厳密に増える時計。後退しないことは ceiling の永続化で守る (ShardCore)。 */
export class Hlc {
  constructor(private last: Ts) {}
  get value(): Ts {
    return this.last;
  }
  tick(physicalMs: number): Ts {
    this.last = Math.max(this.last + 1, physicalToTs(physicalMs));
    return this.last;
  }
  observe(ts: Ts): void {
    if (ts > this.last) this.last = ts;
  }
}
