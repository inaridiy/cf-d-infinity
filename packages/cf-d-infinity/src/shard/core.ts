// シャードの殻。核 (kernel.ts の ShardKernel) の手続きを 1 歩ずつ進め、核が頼んだ待ちを実行する。
//
// シャードの状態を読み書きするのは、同期の核だけである。ここにあるのは、待つための仕組みだけである:
//   - 手続きを進める繰り返し (walk) と、待ちの実行 (perform)。
//   - 複数の要求が同じ仕事を待つための合流 (表定義の適用、グループの引き取り)。
//   - 行を待つタイマー (waitForRow)。
// 待ちの数と順序は、核の 1 歩が返す Effect で決まる。殻は、待ちを足しも省きもしない。型は step.ts にある。
import type { Backend, ExecReq, ExecRes, CommitReq, CommitRes, LockOwner, Piece, PiecePayload, PieceWant, PrepareReq, PrepareRes, ShardApi, Span, Ts, TxnStatus } from "../types";
import { ConflictError } from "../types";
import type { Interval } from "../routing";
import { type Runtime, sleep, systemRuntime } from "../runtime";
import type { Effect, Fork, Outcome, PeerCall, Program } from "./step";
import type { Logged } from "../catalog";
import type { SplitMove } from "../meta";
import { ShardKernel, WOUND_DELAY_MS, type KernelDeps, type Sig, type Waiter } from "./kernel";

export {
  GROUP_MAX_BYTES, LOG_GEN_MS, LOG_RETAIN_MS, MAX_CLOCK_AHEAD_MS, ORPHAN_AGE_MS, SHARD_MAX_BYTES, SHARD_MAX_ROWS, TXN_RETAIN_MS, lockIdOf,
  type SpanEscape, type WriteCheck,
} from "./kernel";

/** シャードの依存。核の依存 (KernelDeps) に、待つ相手を足したものである。 */
export interface ShardDeps extends KernelDeps {
  peer(id: string): ShardApi;
  meta: {
    /** Meta の epoch の列の、epoch が after より後の記録 (meta.ts の epochsSince)。シャードは、これを自分の写し __epoch に足す。 */
    epochsSince(after: number): Promise<Logged[]>;
    /** 分割の枠を示して、子が受け取り始める。分割の表定義の epoch が返る (meta.ts の startSplit)。 */
    startSplit(id: string, move: SplitMove): Promise<{ schema: number }>;
    /** 分割の枠が生きていて、子が受け取り始めていることを確かめる (meta.ts の checkSplit)。 */
    checkSplit(id: string, move: SplitMove): Promise<void>;
  };
  /** 実時間、待ち、乱数の出どころ。指定しなければ実物を使う。シミュレータは seed から決まる実装を渡す。 */
  runtime?: Runtime;
  /** 応答後も続ける処理。DO では ctx.waitUntil に渡す。 */
  background?(p: Promise<unknown>): void;
}

/** シャード 1 個のプロトコル本体。DO に依存せず、Node の SQLite でも同じコードが動く。 */
export class ShardCore implements ShardApi {
  readonly id: string;
  private k: ShardKernel;
  private rt: Runtime;
  /** 進行中の DDL の適用。同時に来た要求は同じ適用を待つ。 */
  private schemaChange: Promise<void> | null = null;
  /** 引き取っている最中のグループ。同じグループを待つ要求は、同じ引き取りを待つ。 */
  private pulling = new Map<string, Promise<void>>();

  constructor(private deps: ShardDeps) {
    this.id = deps.id;
    this.rt = deps.runtime ?? systemRuntime;
    this.k = new ShardKernel(deps);
  }

  get epoch(): number {
    return this.k.epoch;
  }
  /** 直近の redrive で失敗した処理の理由。運用の診断に使う。 */
  get lastRedriveErrors(): string[] {
    return this.k.lastRedriveErrors;
  }
  // 試験が、状態を確かめるときに覗く。
  private get locks(): ReadonlyMap<string, unknown> {
    return this.k.peek().locks;
  }
  private get recentLowWater(): Ts {
    return this.k.peek().recentLowWater;
  }

  // ---- 手続きを進める ----

  /**
   * 核の手続きを、終わるまで走らせる。1 歩は同期で、待ちの後は、同じ 1 歩を先頭から呼び直す。
   * 待ちをまたいで残るのは frame だけである。
   */
  private async walk<F, T>(p: Program<ShardKernel, F, T>, f: F): Promise<T> {
    try {
      for (;;) {
        const r = p.step.call(this.k, f);
        if (r.forks) for (const x of r.forks) this.fork(x);
        if (r.done) return r.value;
        // 待ちの結果が、そのまま手続きの結果になる。await せずに返す。
        if ("tail" in r) return this.perform(r.tail) as Promise<T>;
        if (r.caught) {
          let out: Outcome<unknown>;
          try {
            out = { ok: true, value: await this.perform(r.wait) };
          } catch (error) {
            out = { ok: false, error };
          }
          (f as Record<string, unknown>)[r.into!] = out;
        } else {
          const value = await this.perform(r.wait);
          if (r.into !== undefined) (f as Record<string, unknown>)[r.into] = value;
        }
      }
    } finally {
      if (p.exit) for (const x of p.exit.call(this.k, f)) this.fork(x);
    }
  }

  /** 名前で引いた手続きを走らせる。 */
  private start<N extends keyof Sig>(name: N, frame: Sig[N][0]): Promise<Sig[N][1]> {
    return this.walk(this.k.programs[name] as Program<ShardKernel, Sig[N][0], Sig[N][1]>, frame);
  }

  /**
   * 核が頼んだ待ちを実行する。async にしない。待つ対象の Promise を、そのまま返す (async の関数で包むと、待ちが 1 回増える)。
   */
  private perform(e: Effect): Promise<unknown> {
    switch (e.kind) {
      case "call":
        return this.start(e.program as keyof Sig, e.frame as never);
      case "schemaChange":
        if (!this.schemaChange) {
          this.schemaChange = this.start("apply", { catchUp: e.catchUp }).finally(() => {
            this.schemaChange = null;
            this.k.schemaChangeEnded();
          });
          this.k.schemaChangeStarted();
        }
        return this.schemaChange;
      case "schemaChangeOver":
        return this.schemaChange!.catch(() => undefined);
      case "pull":
        return this.pullGroups(e.groups);
      case "ask":
        return this.ask(e.anchor, e.txn, e.pushTo);
      case "flight":
        return new Promise<void>((wake) => this.k.onSettled(e.txn, wake));
      case "row":
        return e.quiet ? this.waitForRow(e.key, e.me, e.deadline).catch(() => undefined) : this.waitForRow(e.key, e.me, e.deadline);
      case "sync":
        return this.deps.backend.sync();
      case "sleep":
        return sleep(this.rt, e.ms);
      case "peer":
        return this.send(e.call);
      case "peers":
        return Promise.all(e.calls.map((c) => this.send(c)));
      case "meta": {
        const meta = this.deps.meta as unknown as Record<string, (...args: unknown[]) => Promise<unknown>>;
        const answer = meta[e.method]!(...e.args);
        return e.orNull ? answer.catch(() => null) : answer;
      }
    }
  }

  private send(c: PeerCall): Promise<unknown> {
    const peer = this.deps.peer(c.to);
    return (peer[c.method] as (req: unknown) => Promise<unknown>).call(peer, c.req);
  }

  /** 待たずに始める。 */
  private fork(x: Fork): void {
    if (x.kind === "wake") {
      queueMicrotask(() => this.k.wakeNext(x.key));
      return;
    }
    const guarded = this.perform(x.effect).catch(() => {}); // 失敗は redrive が回収する。
    if (x.kind === "background") this.deps.background?.(guarded);
  }

  // ---- 待ちの仕組み ----

  /** 取引の決着を anchor に尋ねる。anchor が自分なら、自分の手続きを走らせる。 */
  private async ask(anchor: string, txn: string, pushTo: Ts): Promise<TxnStatus> {
    return anchor === this.id ? this.queryTxn({ txn, pushTo }) : this.deps.peer(anchor).queryTxn({ txn, pushTo });
  }

  /** グループを引き取る。引き取っている最中のグループは、その引き取りを待つ。 */
  private pullGroups(groups: string[]): Promise<void> {
    const waits: Promise<void>[] = [];
    const fresh: string[] = [];
    for (const g of groups) {
      const p = this.pulling.get(g);
      if (p) waits.push(p);
      else fresh.push(g);
    }
    if (fresh.length) {
      const job = this.start("fetch", { groups: fresh }).finally(() => {
        for (const g of fresh) this.pulling.delete(g);
      });
      for (const g of fresh) this.pulling.set(g, job);
      waits.push(job);
    }
    return Promise.all(waits).then(() => undefined);
  }

  /**
   * ロックか intent が空くまで待つ。wound-wait で、若い保持者からは取り上げる。
   * 取り上げられた取引は commit の検証で気付く。prepare 済みの intent は取り上げられないので待つ。
   * prepare 自身はこの待ちに入らない。入ると閉路ができる。
   *
   * 待ち手の列と、奪う判断は、核が持つ。ここは、3 つのタイマーを掛けて、核に起こされるのを待つ。
   */
  private waitForRow(key: string, me: LockOwner, deadline: number): Promise<void> {
    const { lock, intent, held } = this.k.holderOf(key);
    const now = () => this.deps.clock.now();
    return new Promise((resolve, reject) => {
      const leave = () => {
        this.k.leave(list, w);
        this.rt.cancel(timer);
        this.rt.cancel(wound);
        this.rt.cancel(expiry);
      };
      const timer = this.rt.after(Math.max(1, deadline - now()), () => {
        leave();
        reject(new ConflictError("lock wait timeout"));
      });
      const wound = held && this.k.older(me, held)
        ? this.rt.after(WOUND_DELAY_MS, () => {
            if (!this.k.wound(key, held, intent)) return;
            leave();
            resolve();
          })
        : undefined;
      // 保持者の Worker が死ぬと誰もロックを解放しない。期限で確かめないと待ち手が眠ったままになる。
      let expiry: unknown;
      const watch = () => {
        const l = this.k.liveLock(key); // 切れていれば、核が先頭の待ち手を起こす
        if (l) expiry = this.rt.after(Math.max(1, l.expires - now() + 1), watch);
      };
      if (lock) expiry = this.rt.after(Math.max(1, lock.expires - now() + 1), watch);
      const w: Waiter = { ...me, wake: () => { leave(); resolve(); } };
      const list = this.k.enqueue(key, w);
    });
  }

  // ---- ShardApi ----
  //
  // 待ちを含む要求は、核の手続きを走らせる。async にしないのは、perform と同じ理由である。

  exec(req: ExecReq): Promise<ExecRes> {
    return this.start("exec", { req });
  }
  execAuto(req: ExecReq): Promise<ExecRes> {
    return this.start("execAuto", { req });
  }
  commitLocal(req: Omit<PrepareReq, "anchor">): Promise<CommitRes> {
    return this.start("commitLocal", { req });
  }
  commit(req: CommitReq): Promise<CommitRes> {
    return this.start("commit", { req });
  }
  prepare(req: PrepareReq): Promise<PrepareRes> {
    return this.start("prepare", { req });
  }
  unchanged(req: { spans: Span[]; from: Ts; schema: number }): Promise<{ ok: boolean; reason?: string }> {
    return this.start("unchanged", { req });
  }
  prepared(req: { epoch: number; early?: true }): Promise<{ ok: boolean; reason?: string }> {
    return this.start("prepared", { req });
  }
  finalize(req: { txn: string; c: Ts; pieces?: Piece[] }): Promise<void> {
    return this.start("finalize", { req });
  }
  abort(req: { txn: string; pieces?: Piece[] }): Promise<void> {
    return this.start("abort", { req });
  }
  queryTxn(req: { txn: string; pushTo: Ts }): Promise<TxnStatus> {
    return this.start("queryTxn", { req });
  }
  status(req: { txn: string }): Promise<TxnStatus> {
    return this.start("status", { req });
  }
  beginIncoming(req: Interval & { from: string; slot: string }): Promise<{ schema: number }> {
    return this.start("beginIncoming", { req });
  }
  fence(req: Interval & { to: string; schema?: number; slot: string }): Promise<void> {
    return this.start("fence", { req });
  }
  pull(req: Interval & { want: PieceWant[]; to: string; maxBytes: number }): Promise<PiecePayload[]> {
    return this.start("pull", { req });
  }
  drain(req: Interval): Promise<{ groups: number; rows: number; bytes: number }> {
    return this.start("drain", { req });
  }
  syncSchema(req: { schema: number }): Promise<{ moving: boolean }> {
    return this.start("syncSchema", { req });
  }
  /** alarm の本体。未完了の仕事が残っていれば true を返す。呼び出し側 (DO の alarm) は true なら次の alarm を予約する。 */
  redrive(): Promise<boolean> {
    return this.start("redrive", {});
  }
  /** 届いた piece を受け取る。試験が、届く順序を作るのに直に呼ぶ。 */
  private receive(payload: PiecePayload[]): Promise<void> {
    return this.start("receive", { payload });
  }

  // 待ちのない要求。核の同期の関数が、そのまま答える。
  async moves(req: Parameters<ShardKernel["moves"]>[0]): Promise<ReturnType<ShardKernel["moves"]>> {
    return this.k.moves(req);
  }
  async listGroups(req: Parameters<ShardKernel["listGroups"]>[0]): Promise<ReturnType<ShardKernel["listGroups"]>> {
    return this.k.listGroups(req);
  }
  async ack(req: Parameters<ShardKernel["ack"]>[0]): Promise<ReturnType<ShardKernel["ack"]>> {
    return this.k.ack(req);
  }
  async finishMove(req: Parameters<ShardKernel["finishMove"]>[0]): Promise<ReturnType<ShardKernel["finishMove"]>> {
    return this.k.finishMove(req);
  }
  async finishIncoming(req: Parameters<ShardKernel["finishIncoming"]>[0]): Promise<ReturnType<ShardKernel["finishIncoming"]>> {
    return this.k.finishIncoming(req);
  }
  async health(req: Parameters<ShardKernel["health"]>[0]): Promise<ReturnType<ShardKernel["health"]>> {
    return this.k.health(req);
  }
  async exportRows(req: Parameters<ShardKernel["exportRows"]>[0]): Promise<ReturnType<ShardKernel["exportRows"]>> {
    return this.k.exportRows(req);
  }
  async metrics(req: Parameters<ShardKernel["metrics"]>[0]): Promise<ReturnType<ShardKernel["metrics"]>> {
    return this.k.metrics(req);
  }
  async unlock(req: Parameters<ShardKernel["unlock"]>[0]): Promise<ReturnType<ShardKernel["unlock"]>> {
    return this.k.unlock(req);
  }
  async now(req: Parameters<ShardKernel["now"]>[0]): Promise<ReturnType<ShardKernel["now"]>> {
    return this.k.now(req);
  }
  async refresh(req: Parameters<ShardKernel["refresh"]>[0]): Promise<ReturnType<ShardKernel["refresh"]>> {
    return this.k.refresh(req);
  }
  async flush(req: Parameters<ShardKernel["flush"]>[0]): Promise<ReturnType<ShardKernel["flush"]>> {
    return this.k.flush(req);
  }
}
