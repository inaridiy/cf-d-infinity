// 実行のたびに変わり得る入力 (実時間、待ち、乱数、識別子) の出どころ。
//
// Db と ShardCore は、これらを直に呼ばずに、ここを通す。本番は systemRuntime (実物) を使う。
// シミュレータは、seed から決まる実装を渡す。同じ seed なら、RPC の配送の順序まで同じ実行になり、
// 検査が見つけた失敗を再現できる。
//
// ここを通さずに `setTimeout`、`Date.now()`、`Math.random()`、`crypto.randomUUID()` を呼ぶと、その実行は再現できなくなる。
// test/determinism.test.ts が、対象のファイルにそれらがないことを確かめる。
export interface Runtime {
  /** 実時間 (ms)。待ちの期限を測るのに使う。HLC の物理時刻は Clock から取る (シャードごとにずれを与えられる)。 */
  now(): number;
  /** ms 後に fn を呼ぶ。返り値を cancel に渡すと取り消せる。 */
  after(ms: number, fn: () => void): unknown;
  cancel(handle: unknown): void;
  /** [0, 1) の乱数。 */
  random(): number;
  /** ほかと衝突しない文字列。取引の ID に使う。 */
  uuid(): string;
}

export const systemRuntime: Runtime = {
  now: () => Date.now(),
  after: (ms, fn) => setTimeout(fn, ms),
  cancel: (handle) => clearTimeout(handle as ReturnType<typeof setTimeout>),
  random: () => Math.random(),
  uuid: () => crypto.randomUUID(),
};

export const sleep = (rt: Runtime, ms: number): Promise<void> => new Promise((done) => rt.after(ms, done));
