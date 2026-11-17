// 実行履歴が commit 時刻順の直列実行と一致するかを検査する (Elle の簡易版)。
// 後半は、その検査に掛ける乱択の作業負荷 (history.test.ts と move-returns.test.ts が使う)。
import { appendFileSync, writeFileSync } from "node:fs";
import { split } from "../src/autoscaler";
import { fold, type EpochRecord } from "../src/catalog";
import { Db, type Txn } from "../src/client/db";
import { keyString } from "../src/keys";
import { readEpochs } from "../src/meta";
import { initialRouting, overlaps, ownerOf, planSplit, regionsOf, shardsOf, slotOf, type Interval } from "../src/routing";
import { SqlError, type Faults } from "../src/types";
import { expectQuiescent, quiescentProblems } from "./invariants";
import { prng, SimCluster, USERS, type Rpc } from "./sim";

export type Key = string; // "tenant/id"
export interface Read {
  key?: Key;
  /** tenant 内の述語読み。行数と合計を比べる。 */
  tenant?: number;
  /**
   * 全表の読み (生成器 1 と 2)。agg は全行の行数と合計 ({ count, sum })、rows は全行の [tenant, id, n] を主キーの順に並べたもの。
   * 主キーでも shard key でも絞れない文で読む。
   */
  all?: "agg" | "rows";
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
  if (r.all === "rows") {
    const rows = [...state].map(([k, v]) => [...k.split("/").map(Number), v] as number[]);
    return rows.sort((a, b) => a[0]! - b[0]! || a[1]! - b[1]!);
  }
  if (r.all === "agg") {
    let sum = 0;
    for (const v of state.values()) sum += v;
    return { count: state.size, sum };
  }
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

// ---- 乱択の作業負荷 ----

const IDS = 3;

/** 範囲の移動の乱択 (RunOpts.moves)。 */
export interface MoveChaos {
  /**
   * 移る範囲の選び方。split は Autoscaler と同じく、親の最も広い区間の半分を、まだ使っていない名前の子へ渡す。returns は、それに加えて、
   * 範囲表の 1 つの区間を丸ごと、範囲を持たないシャードへ渡す。宛先は、その区間を前に持っていたシャードを選びやすくする (前の持ち主へ戻る)。
   * chain は split と同じ半分の分割で、親を、いちばん新しい移動の子にしやすくする (s0 から s3、s3 から s4 と前へ進む鎖。範囲は戻らない)。
   */
  kind: "split" | "returns" | "chain";
  /** 生成器 10。移動のメッセージを 1 つ選び、後の移動が閉じるまで止めてから届ける (LateMoves)。 */
  late?: LateMoves;
  /**
   * 「group not arrived」で断られた要求の数の上限。この断りは、移動だけが起こす (受け取り中の範囲の、まだ届いていないグループ)。
   * 超えたら problems に書く。既定は 0 (類の見直しの数えで、split の seed 61 から 64 は 0 だった)。
   */
  notArrivedMax?: number;
  /** 移動の手順の要求 (MOVE_RPCS) の配送の前に、ときどき子か親を再起動する。 */
  restarts?: boolean;
  /**
   * 進める側 (Autoscaler) が、ときどき startMove の後で止まる (子に drain を送らない)。drain が再起動で失敗したときも、ときどき
   * やり直さずに離れる。どちらも、子が自分で (応答の後の仕事と alarm で) 移動を終える。Autoscaler の次の判断は、開いたままの移動を
   * ときどき再開する (movesToResume)。
   */
  stops?: boolean;
  /**
   * 未解決の問題 54 の時刻 (範囲が前の持ち主へ戻る途中に届く phase 2) を作らない。戻る移動を始める前に、どのシャードにも、宛先が前に
   * 渡した取引 (宛先の __moved_txn) の intent が残っていないことを求め、残っていれば、その移動を後回しにする。54 の窓より広く外す
   * (窓は、宛先が move-start を適用してから、その intent のグループを引き取るまでである)。
   */
  hide54?: boolean;
  /**
   * 終わった移動の遅れた pull が、範囲が戻ってきた前の親に届く時刻を作らない (test/open/stale-pull-after-return.test.ts。親は、終わった移動の
   * fence でグループを渡し直そうとし、内部の誤りで答える)。宛先へ向かう pull がまだ届いていない (応答も失敗も返っていない) 間は、その宛先への
   * 移動を後回しにする。宛先は範囲を持たないシャードなので、そこへ向かう pull は、どれも終わった移動のものである。
   */
  hideStalePull?: boolean;
  /** 移動の手順の要求の配送を、ときどき最大この ms だけ遅らせる。既定は 20。 */
  slowMoveRpcMs?: number;
  /** 移動と移動の間の待ちの上限 (ms)。既定は、thinkMs があればその 2 倍、なければ 60。 */
  paceMs?: number;
  /**
   * 生成器 4 (docs/design-refresh-across-move.md の「乱択の検査に足す生成器」)。持ち主が前の持ち主へ尋ねる要求 (ASK_RPCS) の配送と
   * 応答を、ときどき最大この ms だけ遅らせる。その間に、範囲が前の持ち主へ戻る。乱数は、作業負荷とも移動とも別の流れ (r3) から引く。
   */
  slowAsksMs?: number;
  /** 始める移動の数の上限。既定は MAX_MOVES。 */
  maxMoves?: number;
}

/**
 * 生成器 10 (「遅れた移動のメッセージ」の類。計画書の不変条件 15)。シャードの間のメッセージに期限はなく、移動のメッセージとその応答は、
 * その移動より長く生き得る。ここでは、移動のメッセージ (LATE_RPCS と、Meta への endMove) の要求か応答を 1 つ選んで止め、その移動が閉じ、
 * 後に始まった移動が 1 つか 2 つ閉じてから届ける。止めるのは SimNet の gate (要求) と reply (応答) で、endMove は Meta の endMove を包んで
 * 止める。乱数は、作業負荷とも移動とも別の流れ (r4) から引く。この選択肢のない実行の乱数の列と RPC の列は、足す前と同じである。
 *
 * 止めた要求を移動そのものが待っていることがある (drain の listGroups、pull、ack、子の finishMove、endMove)。止めたままでは移動が
 * 閉じず、後の移動も始まらない。止めてから stallMs の後も移動が開いていれば、要求の送り手を再起動する。移動は、新しい instance の alarm が
 * 進め直し、止めた要求は、古い instance が再起動の前に送ったものとして、後で届く。止めた応答は、そのとき届ける (遅れの効かない応答)。
 * どの条件も満たさないまま capMs が過ぎるか、移動を始める側が止まったら (後の移動はもう始まらない)、届ける。
 */
export interface LateMoves {
  /** 止める候補のメッセージごとの、止める確率。 */
  share: number;
  /** 同時に止めておくメッセージの数の上限。既定は 1。 */
  max?: number;
  /** 止めてから、この ms (仮想の時刻) が過ぎたら、条件を待たずに届ける。既定は 20_000。 */
  capMs?: number;
  /** 止めたメッセージの移動が、止めてからこの ms の後も開いていれば、上のとおりにする。既定は 2_000。 */
  stallMs?: number;
  /**
   * 見つけて直していない欠陥 (下の LateRow の 1 から 7 と returning、other) の配送を落とす。落とした数を LateCounts.masked に数える。
   * 落とすのは、網がメッセージを失うのと同じである。OPEN=1 では落とさずに届け、検査が見つける。
   */
  mask?: boolean;
}

/**
 * 生成器 10 が止めるメッセージ (網を通るもの)。drain は止めない。進める側 (split) が待つので、止めると後の移動が始まらない。
 * finishIncoming は子の中の呼び出し (moveStep) で、網を通らない。endMove は Meta への呼び出しで、Meta の endMove を包んで止める。
 * finalize と abort は、移動の後に前の持ち主が新しい持ち主へ転送する phase 2 (pieces を運ぶもの) だけを止める。
 */
const LATE_RPCS = new Set(["pull", "listGroups", "ack", "finishMove", "finalize", "abort"]);

/**
 * 遅れた pull とその応答が届いた場面 (類の見直し (2026-11-17)が挙げた表の行。この型が、その表の写しである。決まった台本は test/open/late-pull-*.test.ts)。届いた瞬間の、受け手の記録で決める。
 * 要求 (親 P への、移動 E の pull。子 C は E の宛先): P の E の fence が終わり、C が E を受け取り終えている (移動より長く生きた)。
 *   1  範囲が P へ戻り、P は受け取り終えた。グループは E で運ばれていない (行も intent もなかった)。
 *   2  1 と同じで、P はそのグループの行を、いま持っている (戻った後に確定した行)。
 *   3  1 と同じで、グループは E で運ばれた (P に E の __moved がある)。
 *   4  範囲は C からさらに先へ渡った (C に E より後の fence がある。前へ進む鎖)。グループは E で運ばれていない。
 *   5  4 と同じで、C はそのグループを先へ渡し、ack をまだ受けていない。
 *   returning  範囲が P へ戻る途中 (P は受け取り中。問題 55 の形。グループが P へもう届いていれば、内部の誤りになる。
 *              test/open/late-pull-while-range-returns.test.ts)。
 *   other  範囲は C に留まっているか、運ばれたグループが前へ進んだ。
 *   window  P の fence は終わったが、C はまだ受け取り中 (空のグループの窓。test/empty-group-after-parent-finished.test.ts)。遅れではない。
 * 応答 (子 C への、移動 E の pull の応答): C が E を受け取り終えている。
 *   6  C は、その後の移動で、そのグループか、それを含む範囲を受け取り直した。
 *   7  そうでない。
 */
export type LateRow = "1" | "2" | "3" | "4" | "5" | "6" | "7" | "returning" | "other" | "window";

/** 生成器 10 の数え (RunResult.late)。 */
export interface LateCounts {
  /** 止めた要求と応答 (`method request` か `method reply` ごと)。 */
  held: Record<string, number>;
  /** 移動が閉じた (Meta に move-end がある) 後に届いた要求と応答。止めたものに限らない。 */
  outlived: Record<string, number>;
  /** 遅れた pull と応答の場面 (LateRow ごと。グループの数で数える)。 */
  situations: Record<string, number>;
  /** mask が落とした配送 (LateRow ごと)。 */
  masked: Record<string, number>;
  /** 不変条件 15 を破った配送 (LateRow ごと)。受け手が、生きた記録のない移動の渡しか到着の記録を変えた。 */
  broken: Record<string, number>;
  /** 止めた応答のうち、送り手の instance が再起動せずに受け取ったもの。 */
  liveReplies: number;
  /** 止めた要求の移動が進まないので、送り手を再起動した数。 */
  stallRestarts: number;
  /** 遅れて届いた pull (表の行のどれか) のうち、その答えが、送った instance (再起動していない) へ戻ったもの。子の側の結果は、これにだけ起きる。 */
  lateToLive: number;
  /** 遅れて届いた pull と応答の明細 (検査の報告と、seed を流して数えるため)。 */
  deliveries: { side: "request" | "reply"; row: LateRow; g: string; epoch: number; from: string; to: string; at: number; masked: boolean }[];
}

/**
 * 持ち主が、受け持ち始める前の窓を前の持ち主へ尋ねる要求 (shard から shard)。2 回目の実装の枝 (eba3354) の名前である
 * (history は確かめの窓、historyRead は古い読み)。`foundation-4` のコードは尋ねないので、この名前の要求は流れず、遅らせる手は効かない。
 * 3 回目の実装で名前が変わったら、ここを合わせる (合わせないと、生成器 4 は黙って何も遅らせない。RunResult.across.delayedAsks が 0 になる)。
 */
export const ASK_RPCS = new Set(["history", "historyRead"]);

/**
 * 全表の読みを、範囲の分割と並べる (生成器 1 と 2。docs/design-refresh-across-move.md の「乱択の検査に足す生成器」)。
 * 取引は、まず主キーで 1 行を読み (T を決め、範囲を記録する)、待ってから、主キーでも shard key でも絞れない文で全表を読む。その間に、
 * 分割 (RunOpts.splits) が読む範囲を動かし、ほかの接続が書く。Worker の refresh と exec の要求の配送を遅らせ、分割が文の途中に入る
 * 実行を増やす。判定は、履歴の検査 (行の数と和、全行の値) と、どの試験にも掛かる全表の読みの区間の検査 (test/sim.ts の checkTiling) である。
 * 乱数は、作業負荷 (rnd) とも移動 (r2) とも別の流れ (r3) から引く。この選択肢のない実行の乱数の列と RPC の列は、足す前と同じである。
 */
export interface WideOpts {
  /** 取引のうち、全表の読みをする取引の割合。 */
  share: number;
  /** 最初の読みと全表の読みの間の待ちの上限 (ms)。 */
  thinkMs: number;
  /** Worker の refresh と exec の要求の配送を、ときどき最大この ms だけ遅らせる。 */
  holdMs: number;
  /**
   * 生成器 2。1 つの文が要求を 2 回に分けて送る形にする。集める予算 (Db の limits.bytes) を bytes にし、一部の tenant の行を大きくする
   * (行の多いシャードが取り分を超え、予算の残りで 2 回目を送る。ReadScope.budgeted)。2 つの表を集める文 (表ごとに 1 回ずつ送る。
   * ReadScope.collect) も混ぜる。
   */
  rounds?: { bytes: number };
}

/** 生成器 1 と 2 の数え (RunResult.wide)。検査が危険な形を作ったかを、試験が確かめるのに使う。 */
export interface WideCounts {
  /** 全表の読みの文の数。 */
  statements: number;
  /** 1 つのシャードだけに送った文と、2 つ以上に送った文 (最初の送信の宛先の数)。 */
  oneShard: number;
  manyShards: number;
  /** 取引の最初の読みから、全表の読みの文が終わるまでに、範囲の移動が始まった文 (生成器 1 の危険な形)。 */
  acrossMove: number;
  /** 最初の回の宛先より多く要求を送った文 (予算の 2 回目、2 つ目の表、範囲の移動で断られて計画し直した試み)。 */
  rounds: number;
  /** そのうち、送る回の間に範囲の移動が始まった文 (生成器 2 の危険な形)。 */
  roundsAcrossMove: number;
  /** 計画の途中で別の読みをする文 (INSERT の値の副問い合わせを、先に取引の読みとして集める。生成器 2)。 */
  planReads: number;
  /** そのうち、計画の途中の読みを送った後、文が終わるまでに範囲の移動が始まった文。 */
  planReadsAcrossMove: number;
  /** 全表の読みの文の形ごとの、文の数と、2 回以上に分けて送った文の数。 */
  byShape: Record<string, { statements: number; rounds: number }>;
  /** 移動をまたいだ文の結末。answered か、断った誤りの文の頭。 */
  outcomes: Record<string, number>;
}

/** 生成器 4 の数え (RunResult.across)。 */
export interface AcrossCounts {
  /** 取引の間に、範囲が前の持ち主へ戻る移動が始まった取引 (生成器 4 の危険な形)。読むだけの取引と、書く取引。 */
  readOnly: number;
  writing: number;
  /** その結末。committed か、断った誤りの文の頭。 */
  outcomes: Record<string, number>;
  /** 取引の間に、同じ区間が 2 度動いた取引 (前の持ち主が、さらに前の持ち主へ尋ねる形。M23b、M23g)。 */
  twoMoves: number;
  /** 遅らせた、前の持ち主への尋ねの要求と応答 (ASK_RPCS)。 */
  delayedAsks: number;
}

export interface RunOpts {
  seed: number;
  clients?: number;
  ops?: number;
  skewMs?: number;
  restarts?: boolean;
  /** 実行中にシャードを増やす。 */
  splits?: boolean;
  /** 悲観的な取引で流す。 */
  pessimistic?: boolean;
  faults?: Faults;
  /** 起動時のシャードの数。既定は 4。 */
  shards?: number;
  /**
   * 範囲を、作業負荷と並べて動かす (MoveChaos)。splits の分割とは別の進め方で、乱数も別の流れから引く。指定しない実行の乱数の列と
   * RPC の列は、この選択肢を足す前と同じである。
   */
  moves?: MoveChaos;
  /** 取引の前に置く待ちの上限 (ms)。作業負荷を、子の alarm (5 秒ごと) が何度か発火するまで続ける。 */
  thinkMs?: number;
  /** phase 2 (finalize) の配送を、ときどき最大この ms だけ遅らせる (moves の実行だけ)。 */
  slowPhase2Ms?: number;
  /** tenant の数。既定は 6。多いほど、取引の intent を読み手が決着させる前に、範囲が動く。 */
  tenants?: number;
  /** 生成器 1 と 2 (WideOpts)。 */
  wide?: WideOpts;
  /**
   * 取引の文と文の間に置く待ちの上限 (ms)。取引が範囲の移動 (と、前の持ち主へ戻る移動) をまたぐ実行を作る (生成器 4)。乱数は r3 から引く。
   */
  innerThinkMs?: number;
  /** splits の分割と分割の間の待ちに、最大この ms を足す。分割を作業負荷の全体に散らす。乱数は r3 から引く。 */
  splitPaceMs?: number;
}

/**
 * 実行が終わらないと見なす上限。仮想の時刻で 10 分、出来事 200 万個。欠陥を入れた実行は、要求を投げ合い続けて終わらないことがある。
 * 上限で、原因の分かる失敗にする (試験の制限時間は、出来事が途切れずに続くと効かないことがある)。
 */
const STALL_MS = 10 * 60_000;
const STALL_STEPS = 2_000_000;

/** moves の実行で始める移動の数の上限。 */
const MAX_MOVES = 12;

/** 範囲の移動の手順の要求。子が親へ送る (listGroups、pull、ack、finishMove) か、進める側が子へ送る (drain)。 */
const MOVE_RPCS = new Set(["listGroups", "pull", "ack", "finishMove", "drain"]);

export interface RunResult {
  history: TxRecord[];
  violations: Violation[];
  unknown: number;
  c: SimCluster;
  splits: number;
  /** moves の実行で見つけた、履歴の外の問題 (strandedIntents、移動の終わり方、行の置き場所)。空なら健全である。 */
  problems: string[];
  /** moves の実行の数え。検査が何かを確かめたかを、試験が確かめるのに使う。 */
  counts: MoveCounts;
  /** wide の実行の数え。 */
  wide: WideCounts;
  /** innerThinkMs の実行の、範囲が戻る移動をまたいだ取引の数え。 */
  across: AcrossCounts;
  /** MoveChaos.late の実行の数え (生成器 10)。 */
  late: LateCounts;
}

export interface MoveCounts {
  /** 始めた移動 (move-start の記録)。 */
  moves: number;
  /** そのうち、範囲を前の持ち主へ戻した移動。 */
  returns: number;
  /** 進める側の drain が完了を返さないまま閉じた移動。子が自分で終えた。 */
  byChild: number;
  /** 移動の手順の要求の前に再起動した、子と親の数。 */
  restarts: number;
  /** hide54 と hideStalePull が後回しにした移動の数。 */
  deferred: number;
  /** 「group not arrived」で断られた要求の数 (MoveChaos.notArrivedMax)。 */
  notArrived: number;
}

export async function runHistory(o: RunOpts): Promise<RunResult> {
  const rnd = prng(o.seed);
  const skew = new Map<string, number>();
  const c = new SimCluster({
    shards: o.shards ?? 4,
    faults: o.faults,
    seed: o.seed,
    skewMs: (id) => {
      if (!skew.has(id)) skew.set(id, Math.floor(rnd() * (o.skewMs ?? 0)));
      return skew.get(id)!;
    },
  });
  c.net.jitter = () => (rnd() < 0.5 ? 0 : rnd() * 3);
  const run = Promise.race([body(o, c, rnd), c.stalled(STALL_MS, STALL_STEPS)]);
  if (!process.env.LATE_REPORT || !o.moves?.late) return run;
  // 生成器 10 の seed を流して数えるとき、終わらなかった実行も 1 行に書く (終わらないこと自体が、移動の閉じない欠陥の現れである)。
  return run.catch((e: unknown) => {
    const { deliveries, ...rest } = lateOf.get(c) ?? emptyLate();
    appendFileSync(process.env.LATE_REPORT!, `${JSON.stringify({
      kind: o.moves!.kind, seed: o.seed, mask: Boolean(o.moves!.late!.mask), counts: {}, ...rest,
      deliveries: deliveries.filter((d) => d.row !== "window"), violations: [], problems: [`the run did not finish: ${(e as Error)?.message?.slice(0, 300)}`],
    })}\n`);
    throw e;
  });
}

/** 実行ごとの、生成器 10 の数え。終わらなかった実行の書き出し (LATE_REPORT) が読む。 */
const lateOf = new WeakMap<SimCluster, LateCounts>();

async function body(o: RunOpts, c: SimCluster, rnd: () => number): Promise<RunResult> {
  const admin = c.client();
  await admin.ddl(USERS);

  const history: TxRecord[] = [];
  const TENANTS = o.tenants ?? 6;
  const pick = (n: number) => 1 + Math.floor(rnd() * n);
  const key = () => ({ t: pick(TENANTS), i: pick(IDS) });
  const k = (x: { t: number; i: number }) => `${x.t}/${x.i}`;
  let seq = 0;
  let unknown = 0;
  // moves と thinkMs の実行だけが引く乱数。作業負荷の乱数 (rnd) の列を変えない。
  const r2 = prng(o.seed ^ 0x6a09e667);
  // 生成器 1、2、4 の選択肢 (wide、innerThinkMs、splitPaceMs、MoveChaos.slowAsksMs) だけが引く乱数。rnd と r2 の列を変えない。
  const r3 = prng(o.seed ^ 0x3c6ef372);
  if (o.wide?.rounds) {
    // 2 つの表を集める文のための、書かない表。どの tenant の行もある。
    await admin.ddl("CREATE TABLE tags(tenant_id INTEGER PRIMARY KEY)");
    await admin.query(`INSERT INTO tags VALUES ${Array.from({ length: TENANTS }, (_v, i) => `(${i + 1})`).join(", ")}`);
  }
  const across: AcrossCounts = { readOnly: 0, writing: 0, outcomes: {}, twoMoves: 0, delayedAsks: 0 };
  const moves = o.moves ? startMoves(o, o.moves, c, r2, r3, across) : null;
  const wide: WideCounts = {
    statements: 0, oneShard: 0, manyShards: 0, acrossMove: 0, rounds: 0, roundsAcrossMove: 0, planReads: 0, planReadsAcrossMove: 0, outcomes: {}, byShape: {},
  };
  if (o.wide?.holdMs) {
    // Worker の refresh と exec の配送を遅らせる。分割が、文の送信と送信の間、確かめの最中に入る実行を増やす。
    const hold = o.wide.holdMs;
    const prior = c.net.gate;
    c.net.gate = (x) => {
      const p = prior(x);
      if (p) return p;
      if (x.from === "client" && (x.method === "refresh" || x.method === "exec") && r3() < 0.3) return c.sleep(r3() * hold);
      return undefined;
    };
  }
  /** Meta が記録した移動の数 (move-start)。Meta の SQLite を直に読む (RPC の列を変えない)。 */
  const moveStarts = () => readEpochs(c.metaBackend).filter((x) => x.rec.kind === "move-start").length;
  /** Meta の epoch の列で、epoch from より後に始まった、範囲を前の持ち主へ戻す移動の数。 */
  const returnsAfter = (from: number) => {
    const log = readEpochs(c.metaBackend).flatMap((x) => (x.rec.kind === "move-start" ? [{ epoch: x.epoch, rec: x.rec }] : []));
    return log.filter((x) => x.epoch > from && log.some((y) => y.epoch < x.epoch && y.rec.from === x.rec.to && overlaps(y.rec, x.rec))).length;
  };
  /** epoch from より後に、重なる区間の移動が 2 つ始まったか。 */
  const twiceAfter = (from: number) => {
    const log = readEpochs(c.metaBackend).flatMap((x) => (x.rec.kind === "move-start" && x.epoch > from ? [x.rec] : []));
    return log.some((x, i) => log.slice(i + 1).some((y) => overlaps(x, y)));
  };
  const lastEpoch = () => readEpochs(c.metaBackend).at(-1)?.epoch ?? -1;
  const head = (e: unknown) => {
    const m = e instanceof Error ? e.message : String(e);
    return /^(conflict|read too old|not owner|migrating)/.exec(m)?.[1] ?? `error: ${m.slice(0, 60)}`;
  };
  const tally = (into: Record<string, number>, what: string) => (into[what] = (into[what] ?? 0) + 1);
  /** 取引の文と文の間の待ち (innerThinkMs)。選択肢がなければ待たない (await も挟まない)。 */
  const innerThink = o.innerThinkMs ? () => c.sleep(r3() * o.innerThinkMs!) : null;
  /** 生成器 2 の、大きい行の tenant。行の多いシャードが、予算の取り分を超える。 */
  const padOf = (t: number) => (t === 1 ? "x".repeat(1500) : "");

  const readKey = async (tx: Txn, x: { t: number; i: number }, reads: Read[]) => {
    // 整数の引数は INTEGER (bigint) で渡す。JS の数は REAL として束縛される (列の型の親和性が整数に戻すので、答えは同じである)。
    const r = await tx.query("SELECT n FROM users WHERE tenant_id = ? AND id = ?", [BigInt(x.t), BigInt(x.i)]);
    const value = (r.rows[0]?.n as number | undefined) ?? null;
    reads.push({ key: k(x), value });
    return value;
  };
  const readTenant = async (tx: Txn, t: number, reads: Read[]) => {
    const r = await tx.query("SELECT count(*) c, coalesce(sum(n), 0) s FROM users WHERE tenant_id = ?", [BigInt(t)]);
    reads.push({ tenant: t, value: { count: r.rows[0]!.c, sum: r.rows[0]!.s } });
  };
  const put = async (tx: Txn, x: { t: number; i: number }, v: number, writes: TxRecord["writes"]) => {
    await tx.query("DELETE FROM users WHERE tenant_id = ? AND id = ?", [BigInt(x.t), BigInt(x.i)]);
    if (o.wide?.rounds && r3() < 0.5) await planReadInsert(tx, x, v);
    else if (o.wide?.rounds) await tx.query("INSERT INTO users(tenant_id, id, n, name) VALUES (?, ?, ?, ?)", [BigInt(x.t), BigInt(x.i), BigInt(v), padOf(x.t)]);
    else await tx.query("INSERT INTO users(tenant_id, id, n) VALUES (?, ?, ?)", [BigInt(x.t), BigInt(x.i), BigInt(v)]);
    writes.push({ key: k(x), value: v });
  };

  /**
   * 取引の、複数のシャードの答えをまとめる口 (ReadScope.budgeted。test/setup.ts が区間の検査を掛けた prototype のもの) を、fn の間だけ
   * 取引の上で包む。包みは同じ Promise を返し、送る要求ごとに、Meta が記録した移動の数を seen に覚えるだけである (RPC の列を変えない)。
   */
  type Sends = { sends: number[]; first: number };
  const watchSends = async (tx: Txn, seen: Sends, fn: () => Promise<unknown>) => {
    type Read1 = (t: unknown, maxBytes: number) => Promise<unknown>;
    const scope = tx as unknown as { budgeted: (targets: unknown[], budget: number, read: Read1) => Promise<unknown> };
    const real = scope.budgeted;
    scope.budgeted = (targets, budget, read) => {
      if (seen.first < 0) seen.first = targets.length;
      return real.call(tx, targets, budget, (t, maxBytes) => {
        seen.sends.push(moveStarts());
        return read(t, maxBytes);
      });
    };
    try {
      await fn();
    } finally {
      delete (scope as Partial<typeof scope>).budgeted;
    }
  };

  /**
   * 計画の途中で別の読みをする文 (生成器 2)。INSERT の値の副問い合わせは、文を送る前に、取引の読みとして求める (src/sql/plan.ts の
   * ctx.read)。副問い合わせは全表を読み、値は v のままである (0 * count(*))。読んだ範囲は、確定のときに検証される。
   */
  const planReadInsert = async (tx: Txn, x: { t: number; i: number }, v: number) => {
    const seen: Sends = { sends: [], first: -1 };
    try {
      await watchSends(tx, seen, () => tx.query(
        "INSERT INTO users(tenant_id, id, n, name) VALUES (?, ?, (SELECT ? + 0 * count(*) FROM users), ?)",
        [BigInt(x.t), BigInt(x.i), BigInt(v), padOf(x.t)],
      ));
    } finally {
      wide.planReads++;
      if (seen.sends.length > 0 && moveStarts() > Math.max(...seen.sends)) wide.planReadsAcrossMove++;
    }
  };

  /**
   * 全表の読み (生成器 1 と 2)。主キーでも shard key でも絞れない文にする (n はいつも 1 以上なので、n > 0 は全行である)。rounds の実行では、
   * 大きい行の列 (name) も集める文と、2 つの表を集める文を混ぜる。
   */
  const readAll = async (tx: Txn, reads: Read[], shape: string) => {
    const agg = (r: { rows: Record<string, unknown>[] }) => reads.push({ all: "agg", value: { count: r.rows[0]!.c, sum: r.rows[0]!.s } });
    const rows = (r: { rows: Record<string, unknown>[] }) =>
      reads.push({ all: "rows", value: r.rows.map((x) => [Number(x.tenant_id), Number(x.id), Number(x.n)]) });
    if (shape === "count") agg(await tx.query("SELECT count(*) c, coalesce(sum(n), 0) s FROM users"));
    else if (shape === "filtered") agg(await tx.query("SELECT count(*) c, coalesce(sum(n), 0) s FROM users WHERE n > ?", [0n]));
    else if (shape === "rows") rows(await tx.query("SELECT tenant_id, id, n FROM users WHERE n > ? ORDER BY tenant_id, id", [0n]));
    else if (shape === "padded") rows(await tx.query("SELECT tenant_id, id, n, name FROM users WHERE n > ? ORDER BY tenant_id, id", [0n]));
    else agg(await tx.query("SELECT count(*) c, coalesce(sum(u.n), 0) s FROM users u JOIN tags g ON g.tenant_id = u.tenant_id WHERE u.n > ?", [0n]));
  };

  /**
   * 全表の読みの文を 1 つ実行し、送り方を数える (WideCounts)。取引の、複数のシャードの答えをまとめる口 (ReadScope.budgeted。test/setup.ts が
   * 区間の検査を掛けた prototype のもの) を、この文の間だけ、取引の上で包む。包みは同じ Promise を返し、送る要求ごとに、Meta が記録した
   * 移動の数を覚えるだけである (RPC の列を変えない)。
   */
  const countedReadAll = async (tx: Txn, reads: Read[], since: number) => {
    const shapes = o.wide?.rounds ? ["padded", "joined", "count", "rows"] as const : ["count", "filtered", "rows"] as const;
    const shape = shapes[Math.floor(r3() * shapes.length)]!;
    const seen: Sends = { sends: [], first: -1 };
    const { sends } = seen;
    let outcome = "answered";
    try {
      await watchSends(tx, seen, () => readAll(tx, reads, shape));
    } catch (e) {
      outcome = head(e);
      throw e;
    } finally {
      const first = seen.first;
      const by = (wide.byShape[shape] ??= { statements: 0, rounds: 0 });
      by.statements++;
      if (sends.length > Math.max(first, 0)) by.rounds++;
      wide.statements++;
      if (first === 1) wide.oneShard++;
      else if (first > 1) wide.manyShards++;
      const crossed = moveStarts() > since;
      if (crossed) wide.acrossMove++;
      if (sends.length > Math.max(first, 0)) {
        wide.rounds++;
        if (new Set(sends).size > 1) wide.roundsAcrossMove++;
      }
      if (crossed) tally(wide.outcomes, outcome);
    }
  };

  const oneTxn = async (client: ReturnType<SimCluster["client"]>) => {
    const name = `w${seq++}`;
    const reads: Read[] = [];
    const writes: TxRecord["writes"] = [];
    const tx = await client.begin();
    if (o.pessimistic) {
      tx.pessimistic = true;
      tx.lockReads = true;
    }
    // 生成器 4 の数え。取引の間に、範囲が前の持ち主へ戻る移動が始まったか。
    const epoch0 = innerThink ? lastEpoch() : 0;
    const settle = (outcome: string) => {
      if (!innerThink || returnsAfter(epoch0) === 0) return;
      if (twiceAfter(epoch0)) across.twoMoves++;
      if (writes.length === 0) across.readOnly++;
      else across.writing++;
      tally(across.outcomes, outcome);
    };
    // 全表の読みの取引 (生成器 1 と 2)。wide のない実行は r3 を引かず、rnd の列も変えない。
    const wideTxn = o.wide !== undefined && r3() < o.wide.share;
    const kind = wideTxn ? Number.NaN : rnd();
    const v = seq * 10 + 1;
    try {
      if (wideTxn) {
        await readKey(tx, key(), reads);
        const since = moveStarts();
        if (o.wide!.thinkMs) await c.sleep(r3() * o.wide!.thinkMs);
        await countedReadAll(tx, reads, since);
        if (r3() < 0.4) await put(tx, key(), v, writes);
      } else if (kind < 0.25) {
        await readKey(tx, key(), reads);
        if (innerThink) await innerThink();
        await readTenant(tx, pick(TENANTS), reads);
        if (innerThink) await innerThink();
        await readKey(tx, key(), reads);
      } else if (kind < 0.5) {
        const x = key();
        await readKey(tx, x, reads);
        if (innerThink) await innerThink();
        await put(tx, x, v, writes);
      } else if (kind < 0.75) {
        await readKey(tx, key(), reads);
        if (innerThink) await innerThink();
        await readKey(tx, key(), reads);
        if (innerThink) await innerThink();
        await put(tx, key(), v, writes);
      } else {
        const a = key();
        let b = key();
        while (k(b) === k(a)) b = key();
        await readTenant(tx, a.t, reads);
        if (innerThink) await innerThink();
        await put(tx, a, v, writes);
        await put(tx, b, v + 1, writes);
      }
      try {
        await tx.commit();
      } catch (e) {
        await tx.unlockAll();
        throw e;
      }
    } catch (e) {
      settle(head(e));
      throw e;
    }
    settle("committed");
    const ts = tx.commitTs ?? tx.T;
    if (ts === undefined) return;
    history.push({ name, ts, readOnly: writes.length === 0, reads, writes });
  };

  /**
   * moves の実行で、文が失敗した理由のうち、断りでも再起動でもないもの。投げずに集めて problems に書く (1 つ見つけた後も実行を続け、
   * ほかの検査の結果と数えを残す)。内部の表の誤り (internalError) は、利用者の UNIQUE の誤りより先に見る。見ないと、
   * 「UNIQUE constraint failed: __moved...」を利用者の UNIQUE の誤りとして読み飛ばす (類の見直しの C)。
   */
  const failures: string[] = [];
  const worker = async () => {
    for (let i = 0; i < (o.ops ?? 40); i++) {
      if (o.thinkMs) await c.sleep(r2() * o.thinkMs);
      try {
        // 取引ごとに別セッションにする。因果トークンが時計のずれを隠さないようにするためである。
        // 生成器 2 の実行は、集める予算を小さくした接続を使う。
        await oneTxn(o.wide?.rounds ? new Db(c, { limits: { bytes: o.wide.rounds.bytes } }) : c.client());
      } catch (e) {
        const m = e instanceof Error ? e.message : String(e);
        if (o.moves && internalError(m)) {
          failures.push(`a statement failed with an internal error: ${m.slice(0, 200)}`);
          continue;
        }
        if (/^(conflict|read too old|not owner|migrating)/.test(m) || e instanceof SqlError && /UNIQUE/.test(m)) continue;
        if (/fenced|rpc dropped/.test(m)) {
          unknown++;
          continue;
        }
        if (o.moves) {
          failures.push(`a statement failed: ${m.slice(0, 200)}`);
          continue;
        }
        throw e;
      }
    }
  };

  let stop = false;
  const chaos = (async () => {
    while (!stop && o.restarts) {
      await c.sleep(15);
      c.restart(c.shardIds[Math.floor(rnd() * c.shardIds.length)]!);
      await Promise.all([...c.cores.values()].map((core) => core.redrive().catch(() => {})));
    }
  })();
  let splits = 0;
  // 割る回数に上限を置く。書き手が動いている間ずっと割ると、悲観的な取引の実行のように長く続く実行では数百回割り、分割ごとに
  // 全シャードへ版を適用させる費用がシャードの数に比例するので、全体で 2 乗に膨らむ (seed 207690027 で 581 回、RPC 17 万回。
  // 計画書の未解決の問題 13)。本物の Autoscaler は、負荷の閾値を超えたときにしか割らない。
  const MAX_SPLITS = 12;
  const grower = (async () => {
    let next = c.shardIds.length;
    while (!stop && o.splits && splits < MAX_SPLITS) {
      await c.sleep(25 + (o.splitPaceMs ? r3() * o.splitPaceMs : 0));
      const { routing } = await c.catalog();
      const list = shardsOf(routing);
      const parent = list[Math.floor(rnd() * list.length)]!;
      const range = planSplit(routing, parent);
      if (!range) continue;
      const child = `s${next++}`;
      // 再起動で途中で失敗しても、同じ範囲で最初からやり直せる。
      for (let attempt = 0; attempt < 50; attempt++) {
        try {
          await split(c, parent, child, { range });
          splits++;
          break;
        } catch (e) {
          if (!/fenced|dropped/.test(String(e))) throw e;
          await c.sleep(2);
        }
      }
    }
  })();
  await Promise.all(Array.from({ length: o.clients ?? 6 }, worker));
  stop = true;
  await chaos;
  await grower;
  const problems: string[] = [...failures];
  if (moves) {
    problems.push(...(await moves.finish()));
    // 最後の状態を、すべての書き込みより後の読み取りとして履歴に足す。移動で失われた書き込みと、移動で戻ってきた古い行が、ここで見つかる。
    // 読みが失敗したら (適用できない intent で「stuck」になる、など)、投げずに problems に書く。
    let final: Record<string, unknown>[] | null = null;
    try {
      final = (await c.client().query("SELECT tenant_id, id, n FROM users")).rows;
    } catch (e) {
      problems.push(`the final read failed: ${(e instanceof Error ? e.message : String(e)).slice(0, 200)}`);
    }
    if (final) {
      const reads: Read[] = [];
      for (let t = 1; t <= TENANTS; t++) {
        for (let i = 1; i <= IDS; i++) {
          const row = final.find((r) => Number(r.tenant_id) === t && Number(r.id) === i);
          reads.push({ key: `${t}/${i}`, value: (row?.n as number | undefined) ?? null });
        }
      }
      history.push({ name: "final", ts: Number.MAX_SAFE_INTEGER, readOnly: true, reads, writes: [] });
    }
    problems.push(...(await placement(c)));
  }
  await c.settle();
  // redrive の途中の移動の要求で、ほかのシャードが再起動することがある (MoveChaos.restarts)。そのシャードの、ここで手にした古い instance の
  // redrive は「fenced instance」で失敗する。再起動で入れ替わった instance の失敗だけを読み飛ばす (検査の誤り。2026-11-17)。新しい instance は、
  // 後の後始末 (quiescentProblems) が回す。
  for (const [id, core] of c.cores) {
    try {
      await core.redrive();
    } catch (e) {
      if (c.cores.get(id) === core) throw e;
    }
  }
  await c.settle();
  // 欠陥を入れていない実行では、後始末が済んでいることも確かめる。moves の実行は、投げずに problems に書く (ほかの検査の結果を残す)。
  if (!o.faults && moves) problems.push(...(await quiescentProblems(c)));
  else if (!o.faults) await expectQuiescent(c);
  if (moves) {
    // 静止した後でだけ確かめる検査。遅れて届いた応答の到着の記録 (不変条件 15) と、メモリの印と記録から作り直す印の比べ (marksProblems)。
    // 比べはシャードを再起動するので、最後に置く。再起動は RPC を送らない。
    problems.push(...moves.afterQuiet());
    problems.push(...marksProblems(c));
  }
  // 失敗した seed を調べるための書き出し。SIM_DUMP=<ファイル> で、取引の記録と RPC の記録を JSON で残す。
  if (process.env.SIM_DUMP) {
    // 要求の中身には、INTEGER の値 (bigint) と、Map が入る。JSON.stringify はどちらも書けない (bigint は投げ、Map は {} になる)。
    // test/ddl-harness.ts の書き出しと同じく、bigint は `123n` の文字列に、Map は組の配列にする。
    const plain = (_k: string, x: unknown) => (x instanceof Map ? [...x] : x instanceof Uint8Array ? [...x] : typeof x === "bigint" ? `${x}n` : x);
    writeFileSync(process.env.SIM_DUMP, JSON.stringify({ seed: o.seed, history, rpc: c.net.log }, plain));
  }
  const counts = moves?.counts ?? { moves: 0, returns: 0, byChild: 0, restarts: 0, deferred: 0, notArrived: 0 };
  const late = moves?.late ?? emptyLate();
  const violations = checkHistory(history);
  // 生成器 10 の seed を流して数えるための書き出し。LATE_REPORT=<ファイル> で、実行ごとに 1 行の JSON を足す。
  if (process.env.LATE_REPORT && o.moves?.late) {
    const { deliveries, ...rest } = late;
    appendFileSync(process.env.LATE_REPORT, `${JSON.stringify({
      kind: o.moves.kind, seed: o.seed, mask: Boolean(o.moves.late.mask), counts, ...rest,
      deliveries: deliveries.filter((d) => d.row !== "window"), violations: violations.slice(0, 5), problems: problems.slice(0, 20),
    })}\n`);
  }
  return { history, violations, unknown, c, splits, problems, counts, wide, across, late };
}

const emptyLate = (): LateCounts => ({ held: {}, outlived: {}, situations: {}, masked: {}, broken: {}, liveReplies: 0, stallRestarts: 0, lateToLive: 0, deliveries: [] });

/** 内部の表 (名前が __ で始まる) の誤り。利用者の文の誤りではなく、シャードの手順の誤りである。 */
export const internalError = (m: string): boolean => /(constraint failed|no such table|no such column|already exists)[^\n]*\b__[a-z]/i.test(m);

/** シャードのメモリにある、移動の記録の写し。名前は src/shard/kernel.ts の ShardKernel の私的な欄である。 */
interface KernelMarks {
  moved: Map<string, { m: number; to: string; acked: boolean; epoch: number }>;
  arrived: Map<string, { m: number; epoch: number }>;
  incoming: { start: number; end: number; from_id: string; epoch: number }[];
  fenced: { start: number; end: number; to: string; done: number; epoch: number }[];
  floors: { start: number; end: number; m: number }[];
  maxArrived: number;
  maxFloor: number;
}

/** シャード id のメモリの印を、比べられる文字列の組にする。 */
function marksOf(c: SimCluster, id: string): Record<string, string[]> {
  const k = (c.cores.get(id) as unknown as { k: KernelMarks }).k;
  // 名前が変わったら、ここで落とす (黙って比べなくなるのを防ぐ)。
  if (!(k.moved instanceof Map) || !(k.arrived instanceof Map) || !Array.isArray(k.incoming) || !Array.isArray(k.fenced) || !Array.isArray(k.floors)) {
    throw new Error("test/history.ts marksOf: the move marks of ShardKernel (src/shard/kernel.ts) were renamed; update KernelMarks");
  }
  return {
    moved: [...k.moved].map(([g, v]) => `${g} epoch ${v.epoch} to ${v.to} m ${v.m}${v.acked ? " acked" : ""}`).sort(),
    arrived: [...k.arrived].map(([g, v]) => `${g} epoch ${v.epoch} m ${v.m}`).sort(),
    incoming: k.incoming.map((x) => `[${x.start}, ${x.end}) from ${x.from_id} epoch ${x.epoch}`).sort(),
    fenced: k.fenced.map((x) => `[${x.start}, ${x.end}) to ${x.to} epoch ${x.epoch}${x.done ? " done" : ""}`).sort(),
    floors: k.floors.map((f) => `[${f.start}, ${f.end}) m ${f.m}`).sort(),
    max: [`arrived ${k.maxArrived}`, `floor ${k.maxFloor}`],
  };
}

/**
 * 静止した後で、どのシャードも、メモリの印 (渡した印 moved、到着 arrived、受け取り中と送り出しの範囲、範囲の床) が、表の記録から作り直す
 * 印と同じであること (計画書の不変条件 15 の後半: メモリの印は記録から導かれる)。シャードを再起動して起動の手順 (kernel.ts の boot) に
 * 作り直させ、再起動の前に読んだメモリと比べる。違えば、記録を変えずにメモリだけを変えたか (類の見直しの C の、書き込みが失敗した後に
 * 残った印)、記録とメモリを別の規則で変えた (A1 の、遅れた到着が先へ渡した印を外した) ことになる。
 * 再起動は RPC を送らず、静止した状態では何も失わない。実行の最後に呼ぶ。
 */
function marksProblems(c: SimCluster): string[] {
  const out: string[] = [];
  for (const id of [...c.cores.keys()].sort()) {
    const before = marksOf(c, id);
    c.restart(id);
    const after = marksOf(c, id);
    for (const key of Object.keys(before)) {
      const mem = before[key]!;
      const rebuilt = after[key]!;
      const onlyMem = mem.filter((x) => !rebuilt.includes(x));
      const onlyRebuilt = rebuilt.filter((x) => !mem.includes(x));
      if (onlyMem.length === 0 && onlyRebuilt.length === 0) continue;
      out.push(
        `${id}: its ${key} marks in memory differ from those it rebuilds from its tables: ` +
          `memory only [${onlyMem.slice(0, 3).join("; ")}], rebuilt only [${onlyRebuilt.slice(0, 3).join("; ")}]`,
      );
    }
  }
  return out;
}

// ---- 範囲の移動の乱択 ----

/**
 * シャード shard が、shard key sk のグループを持っているか。シャードが保存した記録だけから決める (test/sim.ts の ownsToken と同じ規則)。
 * 写した epoch の列を畳んだ範囲表で、そのグループの token が自分のものであり、そのグループを渡したなら、その後に届き直したか、
 * そのグループを含む範囲を受け取り直したこと。渡して ack を待つ親は、行と intent の写しを持つが、持ち主ではない。
 */
function holdsGroup(c: SimCluster, shard: string, sk: string): boolean {
  const db = c.backends.get(shard)!.db;
  const rows = db.prepare(`SELECT epoch, rec FROM __epoch ORDER BY epoch`).all() as { epoch: number; rec: string }[];
  const routing = rows.length > 0 ? fold(rows.map((r) => ({ epoch: r.epoch, rec: JSON.parse(r.rec) as EpochRecord }))).routing : initialRouting(c.shardIds);
  const token = slotOf(sk);
  if (routing.ranges.find((x) => token >= x.start && token < x.end)?.shard !== shard) return false;
  const last = (table: string) => (db.prepare(`SELECT max(epoch) AS e FROM ${table} WHERE g = ?`).get(sk) as { e: number | null }).e;
  const out = last("__moved");
  if (out === null) return true;
  const received = (db.prepare(`SELECT max(epoch) AS e FROM __incoming WHERE lo <= ? AND ? < hi`).get(token, token) as { e: number | null }).e;
  return Math.max(last("__arrived") ?? -1, received ?? -1) > out;
}

/**
 * 確定して、anchor が全参加者へ phase 2 を届け終えた (anchor の __txn が committed で done = 1) 取引の intent を、そのグループの持ち主が
 * まだ持っている。参加者は、intent を適用したか、いまの持ち主へ転送した後でだけ phase 2 を受け取ったと答えるので、こうなってはならない
 * (未解決の問題 54 の不変条件の候補)。読み手か redrive が anchor に尋ねれば決着するが、anchor が記録を消した後 (TXN_RETAIN_MS) は、
 * presumed abort で捨てられる。だから、読み手と redrive が来る前に、直に SQLite を読んで確かめる。
 */
export function strandedIntents(c: SimCluster): string[] {
  const out: string[] = [];
  for (const [id, b] of c.backends) {
    for (const r of b.exec(`SELECT DISTINCT txn, anchor, sk FROM __intents`)) {
      const st = c.backends.get(r.anchor as string)?.exec(`SELECT status, done FROM __txn WHERE txn = ?`, r.txn as string)[0];
      if (st?.status !== "committed" || st.done !== 1) continue;
      if (holdsGroup(c, id, r.sk as string)) {
        out.push(`${id}: the intent of txn ${r.txn} (group ${r.sk}) is still there, but anchor ${r.anchor} delivered its phase 2 to every participant`);
      }
    }
  }
  return out;
}

/** 移動が全部閉じた後の、行の置き場所。どの行も、Meta の範囲表の持ち主にだけ、1 度だけある。 */
async function placement(c: SimCluster): Promise<string[]> {
  const { routing } = await c.catalog();
  const out: string[] = [];
  const seen = new Map<string, string[]>();
  for (const [id, b] of c.backends) {
    if (b.exec(`SELECT 1 FROM sqlite_master WHERE type = 'table' AND name = 'users'`).length === 0) continue;
    for (const row of b.exec(`SELECT tenant_id, id FROM users`)) {
      const name = `${row.tenant_id}/${row.id}`;
      seen.set(name, [...(seen.get(name) ?? []), id]);
      const owner = ownerOf(routing, keyString([BigInt(row.tenant_id as number)]));
      if (owner !== id) out.push(`row ${name} is on ${id}, but the range table gives it to ${owner}`);
    }
  }
  for (const [name, on] of seen) if (on.length > 1) out.push(`row ${name} is on ${on.join(" and ")}`);
  return out;
}

/**
 * 範囲を作業負荷と並べて動かす。Autoscaler と同じく split (startMove と子の drain) で進め、途中で子と親を再起動し、進める側を止める。
 * finish は、作業負荷が終わった後で、開いた移動が閉じるのを待ち (子が自分で終える。子が移動を知らないままなら、Autoscaler が再開する)、
 * 見つけた問題を返す。
 */
function startMoves(o: RunOpts, m: MoveChaos, c: SimCluster, r2: () => number, r3: () => number, across: AcrossCounts) {
  const counts: MoveCounts = { moves: 0, returns: 0, byChild: 0, restarts: 0, deferred: 0, notArrived: 0 };
  const problems: string[] = [];
  /** 進める側の split が完了を返した移動 (move-start の epoch)。 */
  const drained = new Set<number>();
  /** 区間を前に持っていたシャード。戻る移動の宛先を選ぶのに使う。 */
  const formerly: { shard: string; range: Interval }[] = [];
  const late = startLate(m.late ?? null, o.seed, c, problems);
  // 子が移動を閉じさせる手 (Meta の endMove) を見張る。子は、受け取り終えた後でだけ呼ぶ (M21 の END_AFTER_DRAIN)。受け取り終えた印
  // (__incoming の done) は、その前に finishIncoming が付ける。生成器 10 は、この呼び出しと、その答えも止める。
  const realEnd = c.meta.endMove.bind(c.meta);
  c.meta.endMove = async (epoch: number) => {
    const rec = readEpochs(c.metaBackend).find((x) => x.epoch === epoch)?.rec;
    if (late && rec?.kind === "move-start") await late.endMove(epoch, rec, "request");
    if (rec?.kind === "move-start") {
      const row = c.backends.get(rec.to)?.exec(`SELECT done FROM __incoming WHERE epoch = ?`, epoch)[0];
      if (row?.done !== 1) problems.push(`${rec.to} asked to close the move of epoch ${epoch} before it finished receiving it`);
    }
    // 生成器 10 のない実行は、包む前と同じ形で返す (await を足すと Promise の段が変わり、同じ seed の RPC の列が変わり得る)。
    if (!late || rec?.kind !== "move-start") return realEnd(epoch);
    const out = await realEnd(epoch);
    await late.endMove(epoch, rec, "reply");
    return out;
  };
  // 移動の手順の要求の配送の前に、ときどき子か親を再起動する。要求は、新しい instance に届く (送り手を再起動したなら、応答は捨てられた
  // instance に返り、その手順は失敗する)。phase 2 と、移動の手順の要求の配送を、ときどき遅らせる。
  /** 配送したが、まだ応答も失敗も返っていない pull (hideStalePull)。 */
  const pulls = new Set<Rpc>();
  /** 前の持ち主への尋ねの要求か応答を、遅らせるか (MoveChaos.slowAsksMs。生成器 4)。選択肢がなければ r3 を引かない。 */
  const slowAsk = (x: Rpc): Promise<void> | undefined => {
    if (!m.slowAsksMs || !ASK_RPCS.has(x.method) || r3() >= 0.5) return undefined;
    across.delayedAsks++;
    return c.sleep(r3() * m.slowAsksMs);
  };
  c.net.reply = (x) => {
    pulls.delete(x);
    const asked = slowAsk(x);
    if (asked || !late) return asked;
    return late.reply(x);
  };
  c.net.gate = (x) => {
    const asked = slowAsk(x);
    if (asked) return asked;
    if (x.method === "pull") pulls.add(x);
    late?.sent(x);
    if (m.restarts && MOVE_RPCS.has(x.method) && r2() < 0.12) {
      const who = x.from === "client" || r2() < 0.5 ? x.to : x.from;
      if (c.backends.has(who)) {
        c.restart(who);
        counts.restarts++;
      }
    }
    const held = late?.request(x);
    if (held) return held;
    if (o.slowPhase2Ms && x.method === "finalize" && r2() < 0.4) return c.sleep(r2() * o.slowPhase2Ms);
    if (MOVE_RPCS.has(x.method) && r2() < 0.2) return c.sleep(r2() * (m.slowMoveRpcMs ?? 20));
    return undefined;
  };
  if (late) c.net.arrive = (x) => late.arrive(x);

  /** 区間 range を from から to へ動かす。止まる進め方なら、ときどき startMove だけで離れる。 */
  const drive = async (from: string, to: string, range: Interval): Promise<void> => {
    if (m.stops && r2() < 0.3) {
      // 進める側が startMove の後で止まる。子は、最新の範囲表の要求が届くか、Autoscaler が再開するまで移動を知らない。
      await c.startMove({ from, to, ...range }).catch(() => undefined);
      return;
    }
    for (let attempt = 0; attempt < 20; attempt++) {
      try {
        // 生成器 10 は、進める側が split を待っている時間を見る (LateMoves)。生成器 10 のない実行は、包まずに待つ (Promise の段を変えない)。
        late?.driving(true);
        const r = late ? await split(c, from, to, { range }).finally(() => late.driving(false)) : await split(c, from, to, { range });
        const open = readEpochs(c.metaBackend).findLast((x) => x.rec.kind === "move-start" && x.rec.from === from && x.rec.to === to);
        if (r && open) drained.add(open.epoch);
        return;
      } catch (e) {
        const msg = e instanceof Error ? e.message : String(e);
        // 子か親が再起動した。止まる進め方なら、ときどき、やり直さずに離れる (子の alarm が続きを進める)。
        if (/fenced|dropped|restarted/.test(msg)) {
          if (m.stops && r2() < 0.5) return;
          await c.sleep(2);
          continue;
        }
        // ほかの移動か表定義の遷移と重なった。次の判断に回す。
        if (/^split busy:|schema busy:|already handing|still receiving|unfinished move|already owns/.test(msg)) return;
        throw e;
      }
    }
  };

  /** 次に動かす区間と宛先。宛先は、範囲を持たず、開いた移動に関わらないシャードである。 */
  let next = c.shardIds.length;
  // 範囲が戻る実行では、シャードの数を抑えて、範囲を持たないシャード (前の持ち主) を宛先に選ぶ機会を作る。
  const MAX_SHARDS = c.shardIds.length + (m.kind === "returns" ? 3 : m.kind === "chain" ? (m.maxMoves ?? MAX_MOVES) : MAX_MOVES);
  /** いちばん新しく始めた移動の子 (chain が、次の親に選びやすくする)。 */
  let lastChild: string | null = null;
  const choose = async (): Promise<{ from: string; to: string; range: Interval } | null> => {
    const { routing } = await c.catalog();
    const open = await c.moves();
    const busy = new Set(open.flatMap((x) => [x.from, x.to]));
    const holding = shardsOf(routing);
    const owners = holding.filter((id) => !busy.has(id));
    if (owners.length === 0) return null;
    // chain は、いちばん新しい子を親にしやすくする。2 度の半分の分割が、1 つの範囲を s0 から子へ、子から孫へ運ぶ。
    const chained = m.kind === "chain" && lastChild !== null && owners.includes(lastChild) && r2() < 0.8;
    const from = chained ? lastChild! : owners[Math.floor(r2() * owners.length)]!;
    const regions = regionsOf(routing, from);
    const range = m.kind === "returns" && r2() < 0.6 ? (regions[Math.floor(r2() * regions.length)] ?? null) : planSplit(routing, from);
    if (!range) return null;
    if (m.kind === "split" || m.kind === "chain") return next < MAX_SHARDS ? { from, to: `s${next++}`, range } : null;
    // 範囲を持たず、移動に関わらないシャード。前の持ち主を、宛先に選びやすくする。いなければ、まだ使っていない名前にする (上限まで)。
    const empty = [...c.backends.keys()].filter((id) => !holding.includes(id) && !busy.has(id)).sort();
    const back = empty.filter((id) => formerly.some((f) => f.shard === id && overlaps(f.range, range)));
    const others = empty.filter((id) => !back.includes(id));
    let to: string | undefined;
    if (back.length > 0 && r2() < 0.8) to = back[Math.floor(r2() * back.length)];
    else if (others.length > 0 && (r2() < 0.5 || next >= MAX_SHARDS)) to = others[Math.floor(r2() * others.length)];
    else if (next < MAX_SHARDS) to = `s${next++}`;
    return to ? { from, to, range } : null;
  };

  /** 戻る移動を、未解決の問題 54 の時刻を作らないように後回しにするか (MoveChaos.hide54)。 */
  const defer54 = (to: string): boolean => {
    const b = c.backends.get(to);
    if (!m.hide54 || !b) return false;
    const handed = new Set(b.exec(`SELECT DISTINCT txn FROM __moved_txn`).map((r) => r.txn as string));
    if (handed.size === 0) return false;
    for (const other of c.backends.values()) {
      for (const r of other.exec(`SELECT DISTINCT txn FROM __intents`)) if (handed.has(r.txn as string)) return true;
    }
    return false;
  };

  /** 宛先へ向かう pull が、まだ届いていないか (MoveChaos.hideStalePull)。失敗した pull は、応答の hook を通らないので、失敗の記録で外す。 */
  const deferStalePull = (to: string): boolean => {
    if (!m.hideStalePull) return false;
    for (const x of pulls) if (c.net.failed.some((f) => f.m === x)) pulls.delete(x);
    return [...pulls].some((x) => x.to === to);
  };

  const started = (p: { from: string; to: string; range: Interval }) =>
    readEpochs(c.metaBackend).some((x) => x.rec.kind === "move-start" && x.rec.from === p.from && x.rec.to === p.to && x.rec.start === p.range.start && x.rec.end === p.range.end);
  let stop = false;
  const mover = (async () => {
    while (!stop && counts.moves < (m.maxMoves ?? MAX_MOVES)) {
      // 取引の間に待ちを置く実行では、移動も同じ速さに散らす。散らさないと、移動は作業負荷の最初の 1 秒ほどで上限に届く。
      await c.sleep(20 + r2() * (m.paceMs ?? (o.thinkMs ? 2 * o.thinkMs : 60)));
      // Autoscaler の次の判断は、開いたままの移動を再開する (movesToResume)。子が移動を知っていれば、子が自分で進めているので、
      // ときどきだけ再開する。
      for (const x of await c.moves()) if (r2() < 0.2) await drive(x.from, x.to, x);
      const plan = await choose();
      if (!plan) continue;
      const isReturn = formerly.some((f) => f.shard === plan.to && overlaps(f.range, plan.range));
      if ((isReturn && defer54(plan.to)) || deferStalePull(plan.to)) {
        counts.deferred++;
        continue;
      }
      await drive(plan.from, plan.to, plan.range);
      // move-start が記録されなかった (ほかの移動か遷移と重なった) なら、数えない。
      if (!started(plan)) continue;
      counts.moves++;
      if (isReturn) counts.returns++;
      formerly.push({ shard: plan.from, range: plan.range });
      lastChild = plan.to;
      // 移動の後で、読み手と redrive が来る前に確かめる (strandedIntents)。
      problems.push(...strandedIntents(c));
    }
  })();
  // 移動を始める側が止まったら、止めたメッセージの、後の移動を待つ条件はもう満たされない (LateMoves)。
  if (late) void mover.finally(() => late.moverDone());

  const finish = async (): Promise<string[]> => {
    stop = true;
    await mover;
    if (late) await late.drained();
    // 開いた移動が閉じるのを待つ。子は、移動を知っていれば自分で (alarm で) 終える。知らないままの子には、Autoscaler が drain を送る。
    for (let waited = 0; ; waited += 500) {
      const open = await c.moves();
      if (open.length === 0) break;
      if (waited >= 120_000) {
        problems.push(`moves stayed open: ${open.map((x) => `${x.from}->${x.to} (epoch ${x.epoch})`).join(", ")}`);
        break;
      }
      if (waited % 20_000 === 19_500) for (const x of open) await split(c, x.from, x.to, { range: x }).catch(() => undefined);
      await c.sleep(500);
    }
    await c.settle();
    problems.push(...strandedIntents(c));
    const log = readEpochs(c.metaBackend);
    const ended = new Set(log.flatMap((x) => (x.rec.kind === "move-end" ? [x.rec.of] : [])));
    counts.byChild = log.filter((x) => x.rec.kind === "move-start" && ended.has(x.epoch) && !drained.has(x.epoch)).length;
    // 移動だけが起こす断り (MoveChaos.notArrivedMax)。Worker は競合をやり直すので、文の失敗ではなく、網の失敗の記録で数える。
    counts.notArrived = c.net.failed.filter((f) => /group not arrived/.test(f.message)).length;
    if (counts.notArrived > (m.notArrivedMax ?? 0)) {
      problems.push(`${counts.notArrived} requests were refused with "group not arrived" (at most ${m.notArrivedMax ?? 0} expected)`);
    }
    // シャードの間の要求が、内部の表の誤りか、移動の手順の誤りで失敗した (文の誤りとして Worker に届かないものも数える)。
    const internal = c.net.failed.filter((f) => internalError(f.message) || /drain does not converge|pull of unfenced group/.test(f.message));
    for (const f of internal) problems.push(`${f.m.from}->${f.m.to} ${String(f.m.method)} failed: ${f.message.slice(0, 160)}`);
    return [...new Set(problems)];
  };
  /** 静止した後の、生成器 10 の検査 (遅れて届いた応答が、受け取り終えた移動の到着の記録を足したか)。 */
  const afterQuiet = (): string[] => late?.afterQuiet() ?? [];
  return { counts, finish, afterQuiet, late: late?.counts ?? null };
}

/**
 * 生成器 10 (LateMoves) の仕掛け。gate、reply、arrive と Meta の endMove の包みから呼ぶ。opt が null なら null を返し、何もしない。
 * problems には、不変条件 15 を破った配送を書く (mask で落とした配送は、届いていないので書かない)。
 */
function startLate(opt: LateMoves | null, seed: number, c: SimCluster, problems: string[]) {
  if (!opt) return null;
  // 作業負荷 (rnd)、移動 (r2)、生成器 1、2、4 (r3) とは別の流れ。
  const r4 = prng(seed ^ 0x510e527f);
  const counts = emptyLate();
  lateOf.set(c, counts);
  const max = opt.max ?? 1;
  const capMs = opt.capMs ?? 20_000;
  const stallMs = opt.stallMs ?? 2_000;
  let moverDone = false;
  /** 移動を始める側が split (子の drain) を待ち始めた時刻。待っていなければ null。 */
  let drivingSince: number | null = null;
  const holds = new Set<Promise<void>>();
  const tally = (into: Record<string, number>, k: string, n = 1) => (into[k] = (into[k] ?? 0) + n);

  /** シャードの SQLite を直に読む (Backend の文の覚えを使わず、処理の流れを変えない)。 */
  const rows = (id: string, sql: string, ...params: (string | number)[]) => {
    const b = c.backends.get(id);
    return b ? (b.db.prepare(sql).all(...params) as Record<string, unknown>[]) : [];
  };
  const epochs = () => readEpochs(c.metaBackend);
  const closed = (epoch: number) => epochs().some((x) => x.rec.kind === "move-end" && x.rec.of === epoch);
  /** メッセージが名指しする移動の epoch。名指ししなければ null。 */
  const epochOf = (x: Rpc): number | null => {
    const req = x.req as { epoch?: number; pieces?: { epoch: number }[] };
    if (x.method === "ack" || x.method === "finalize" || x.method === "abort") return req.pieces?.[0]?.epoch ?? null;
    return req.epoch ?? null;
  };
  /**
   * 止める確率の重み。listGroups、finishMove、endMove は、いつも移動そのものが待つ (止めると、移動が進まないので送り手を再起動する)。
   * pull、ack、phase 2 の転送は、文の on-demand の引き取りと、待たない ack のこともある (移動より長く生きやすい)。
   */
  const weight = (method: string) => (method === "pull" ? 1 : method === "ack" || method === "finalize" || method === "abort" ? 0.6 : 0.3);
  const groupsOf = (x: Rpc): string[] => ((x.req as { want?: { g: string }[] }).want ?? []).map((w) => w.g);
  const groupOf = (x: Rpc): string | null => (x.method === "pull" ? groupsOf(x)[0] ?? null : null);
  const eligible = (x: Rpc): boolean => LATE_RPCS.has(x.method) && x.from !== "client" &&
    ((x.method !== "finalize" && x.method !== "abort") || ((x.req as { pieces?: unknown[] }).pieces?.length ?? 0) > 0);

  /**
   * メッセージの区間 (後の移動が、その区間に掛かるかを見る)。pull と、pieces を運ぶメッセージは、最初のグループの slot である (範囲の半分だけが
   * 先へ渡っても、そのグループが渡ったときにだけ数える)。ほかは、運ぶ区間。運ばなければ null。
   */
  const rangeOf = (x: Rpc): Interval | null => {
    const req = x.req as Partial<Interval> & { pieces?: { g: string }[]; want?: { g: string }[] };
    const g = req.want?.[0]?.g ?? req.pieces?.[0]?.g;
    if (g !== undefined) return { start: slotOf(g), end: slotOf(g) + 1 };
    return req.start !== undefined && req.end !== undefined ? { start: req.start, end: req.end } : null;
  };
  /** pulled の条件で止めているメッセージ。後の移動の pull が、そのグループを親から受け取ったら、すぐに解く (reply から呼ぶ)。 */
  const watchers = new Set<{ g: string; own: number; fire: () => void }>();
  /**
   * 止めて、条件が揃ったら解く Promise。own はメッセージの移動の epoch、range はメッセージの区間、sender は止めたものが要求のときの送り手
   * (移動が進まないときに再起動する)。解く条件は、止めたときに乱数で 1 つ選ぶ。own の移動が閉じた後で、
   *   any      後に始まった移動が k 個 (1 か 2) 閉じた。
   *   overlap  後に始まった、range に掛かる移動が k 個閉じた (範囲が戻るか、さらに先へ渡る。表の 1 から 4 と 6 の形)。
   *   started  後に始まった、range に掛かる移動が 1 つ始まった。その後 0 から 200 ms 待つ (後の移動の途中に届く)。
   *   pulled   後の移動の pull が、メッセージのグループを親から受け取った (その応答が子へ向かう)。そのときに届ける (表の 5 の形。後の移動の
   *            pull と ack の間に届く)。
   * 100 ms (仮想の時刻) ごとに Meta の記録を読んで確かめる。blocks は、own の移動が閉じた後も、子の移動の手順がこのメッセージを待つこと
   * (endMove の応答。子は、答えを受けてから写しを進める。進める側の drain も、それを待つ) を表す。own が開いているときと同じく、stallMs の後に解く。
   */
  const hold = (
    what: string, own: number | null, range: Interval | null, sender: string | null, g: string | null = null, blocks = false,
  ): Promise<void> => {
    tally(counts.held, what);
    const at = c.time;
    const since = epochs().at(-1)?.epoch ?? -1;
    const k = r4() < 0.5 ? 1 : 2;
    const pick = r4();
    const mode = range === null || pick < 0.25 ? "any" : pick < 0.7 ? "overlap" : pick < 0.8 || g === null || own === null ? "started" : "pulled";
    const tail = r4() * 200;
    let restarted = false;
    let fire!: () => void;
    const fired = new Promise<void>((r) => (fire = r));
    const watcher = mode === "pulled" ? { g: g!, own: own!, fire } : null;
    if (watcher) watchers.add(watcher);
    const p = (async () => {
      for (;;) {
        if (await Promise.race([c.sleep(100).then(() => false), fired.then(() => true)])) return;
        const log = epochs();
        const ended = log.flatMap((x) => (x.rec.kind === "move-end" ? [{ epoch: x.epoch, of: x.rec.of }] : []));
        const ownClosed = own === null || ended.some((e) => e.of === own);
        const covers = (epoch: number) => {
          const rec = log.find((x) => x.epoch === epoch)?.rec;
          return rec?.kind === "move-start" && range !== null && overlaps(rec, range);
        };
        const later = mode === "any"
          ? ended.filter((e) => e.epoch > since && e.of > (own ?? -1)).length
          : mode === "overlap"
            ? ended.filter((e) => e.epoch > since && e.of > (own ?? -1) && covers(e.of)).length
            : mode === "started" ? log.filter((x) => x.epoch > since && x.epoch > (own ?? -1) && covers(x.epoch)).length : 0;
        if (ownClosed && (later >= (mode === "started" ? 1 : k) || moverDone)) {
          if (mode === "started") await c.sleep(tail);
          return;
        }
        if (c.time - at >= capMs) return;
        // 移動を始める側が、長く split を待っている。止めたメッセージを、子の手順が (別の手順の引き取りに合流して) 待っていることがある。
        // 後の移動はもう始まらないので、届ける。
        if (drivingSince !== null && c.time - drivingSince >= 2 * stallMs && c.time - at >= stallMs) return;
        if ((blocks || !ownClosed) && c.time - at >= stallMs && !restarted) {
          // 止めたメッセージを、移動そのものが待っている。要求なら送り手を再起動し、応答なら届ける。
          if (sender === null) return;
          restarted = true;
          if (c.backends.has(sender)) {
            c.restart(sender);
            counts.stallRestarts++;
          }
        }
      }
    })();
    holds.add(p);
    void p.finally(() => {
      holds.delete(p);
      if (watcher) watchers.delete(watcher);
    });
    return p;
  };

  /** 親 P への、移動 E の pull が届いた場面 (LateRow)。遅れていなければ空。 */
  const requestRows = (x: Rpc): { row: LateRow; g: string; epoch: number }[] => {
    const req = x.req as { want: { g: string }[]; epoch?: number };
    const E = req.epoch;
    if (E === undefined) return [];
    const P = x.to;
    const fence = rows(P, `SELECT done, "to" FROM __fenced WHERE epoch = ?`, E)[0];
    if (!fence || fence.done !== 1) return [];
    const C = fence.to as string;
    const childDone = rows(C, `SELECT done FROM __incoming WHERE epoch = ?`, E)[0]?.done === 1;
    return req.want.map(({ g }) => {
      if (!childDone) return { row: "window" as const, g, epoch: E };
      const slot = slotOf(g);
      const back = rows(P, `SELECT done FROM __incoming WHERE epoch > ? AND lo <= ? AND ? < hi`, E, slot, slot);
      const carried = rows(P, `SELECT 1 FROM __moved WHERE g = ? AND epoch = ?`, g, E).length > 0;
      let row: LateRow;
      if (back.some((r) => r.done === 1)) row = carried ? "3" : groupRows(P, g) > 0 ? "2" : "1";
      else if (back.length > 0) row = "returning";
      else if (!carried && rows(C, `SELECT 1 FROM __fenced WHERE epoch > ? AND lo <= ? AND ? < hi`, E, slot, slot).length > 0) {
        row = rows(C, `SELECT 1 FROM __moved WHERE g = ? AND epoch > ? AND acked = 0`, g, E).length > 0 ? "5" : "4";
      } else row = "other";
      return { row, g, epoch: E };
    });
  };
  /** 子 C への、移動 E の pull の応答が届いた場面。C が E を受け取り終えていなければ空。 */
  const replyRows = (x: Rpc): { row: LateRow; g: string; epoch: number }[] => {
    const req = x.req as { want: { g: string }[]; epoch?: number };
    const E = req.epoch;
    if (E === undefined) return [];
    const C = x.from;
    if (rows(C, `SELECT done FROM __incoming WHERE epoch = ?`, E)[0]?.done !== 1) return [];
    return req.want.map(({ g }) => {
      const slot = slotOf(g);
      const again = rows(C, `SELECT 1 FROM __arrived WHERE g = ? AND epoch > ?`, g, E).length > 0 ||
        rows(C, `SELECT 1 FROM __incoming WHERE epoch > ? AND lo <= ? AND ? < hi`, E, slot, slot).length > 0;
      return { row: again ? "6" as const : "7" as const, g, epoch: E };
    });
  };
  /** シャード id が持つ、グループ g の利用者の行の数 (users の shard key は tenant_id)。 */
  const groupRows = (id: string, g: string) =>
    rows(id, `SELECT tenant_id FROM users`).filter((r) => keyString([BigInt(r.tenant_id as number)]) === g).length;
  /** 移動 E のグループ g について、シャード id が持つ渡しの記録 (__moved と __moved_txn) の数。 */
  const handing = (id: string, g: string, E: number) =>
    rows(id, `SELECT (SELECT count(*) FROM __moved WHERE g = ? AND epoch = ?) + (SELECT count(*) FROM __moved_txn WHERE g = ? AND epoch = ?) AS n`, g, E, g, E)[0]?.n as number;
  const arrivals = (id: string, g: string, E: number) => rows(id, `SELECT count(*) AS n FROM __arrived WHERE g = ? AND epoch = ?`, g, E)[0]?.n as number;

  /** 送り手が要求を送ったときの instance (の Backend)。gate の最初で覚える。 */
  const sentBy = new WeakMap<Rpc, unknown>();
  /** 届けた遅れた pull の、届く前の受け手の渡しの記録。応答の hook で比べる (不変条件 15)。 */
  const before = new WeakMap<Rpc, { row: LateRow; g: string; epoch: number; n: number }[]>();
  /** 届けた遅れた応答の、届いたときの受け手の到着の記録。静止した後で比べる (afterQuiet)。 */
  const replies: { x: Rpc; row: LateRow; g: string; epoch: number; n: number }[] = [];
  const record = (side: "request" | "reply", x: Rpc, found: { row: LateRow; g: string; epoch: number }[], masked: boolean) => {
    for (const f of found) {
      tally(counts.situations, `${side} ${f.row}`);
      if (masked) tally(counts.masked, `${side} ${f.row}`);
      counts.deliveries.push({ side, row: f.row, g: f.g, epoch: f.epoch, from: x.from, to: x.to, at: c.time, masked });
    }
  };
  const outlived = (x: Rpc, side: "request" | "reply") => {
    if (!eligible(x)) return;
    const E = epochOf(x);
    if (E !== null && closed(E)) tally(counts.outlived, `${String(x.method)} ${side}`);
  };
  const lost = (what: string) => new Error(`rpc dropped: ${what} (a known defect, masked by the late-move generator)`);

  return {
    counts,
    /** gate の最初から。送った instance を覚える。 */
    sent(x: Rpc): void {
      if (x.method === "pull") sentBy.set(x, c.backends.get(x.from));
    },
    /** gate から。止めるなら、その Promise を返す。 */
    request(x: Rpc): Promise<void> | undefined {
      if (!eligible(x) || holds.size >= max || r4() >= opt.share * weight(x.method)) return undefined;
      return hold(`${String(x.method)} request`, epochOf(x), rangeOf(x), x.from, groupOf(x));
    },
    /** 要求が届く瞬間 (SimNet.arrive)。遅れた pull を分類し、mask なら落とす (投げる)。 */
    arrive(x: Rpc): void {
      outlived(x, "request");
      if (x.method !== "pull") return;
      const found = requestRows(x);
      const lateOnes = found.filter((f) => f.row !== "window");
      const mask = Boolean(opt.mask) && lateOnes.length > 0;
      record("request", x, found, mask);
      if (mask) throw lost(`a pull of the finished move of epoch ${lateOnes[0]!.epoch}`);
      if (lateOnes.length > 0) before.set(x, lateOnes.map((f) => ({ ...f, n: handing(x.to, f.g, f.epoch) })));
    },
    /** 応答 (SimNet.reply)。遅れた pull の渡しの記録を比べ、応答を止めるか、応答が届く瞬間に分類する。 */
    reply(x: Rpc): Promise<void> | undefined {
      if (x.method === "pull") {
        const E = (x.req as { epoch?: number }).epoch ?? -1;
        for (const w of watchers) if (E > w.own && groupsOf(x).includes(w.g)) w.fire();
      }
      const seen = before.get(x);
      if (seen && sentBy.get(x) === c.backends.get(x.from)) counts.lateToLive++;
      if (seen) {
        for (const f of seen) {
          const now = handing(x.to, f.g, f.epoch);
          if (now === f.n) continue;
          tally(counts.broken, `request ${f.row}`);
          problems.push(`${x.to} recorded handing group ${f.g} in move ${f.epoch} again for a pull from ${x.from} that arrived after the move finished (situation ${f.row})`);
        }
      }
      const sender = c.backends.get(x.from);
      let heldReply = false;
      const deliver = (): void => {
        if (sender !== undefined && c.backends.get(x.from) === sender && heldReply) counts.liveReplies++;
        outlived(x, "reply");
        if (x.method !== "pull") return;
        const found = replyRows(x);
        const mask = Boolean(opt.mask) && found.length > 0;
        record("reply", x, found, mask);
        if (mask) throw lost(`the answer to a pull of the finished move of epoch ${found[0]!.epoch}`);
        for (const f of found) replies.push({ x, ...f, n: arrivals(x.from, f.g, f.epoch) });
      };
      if (eligible(x) && holds.size < max && r4() < opt.share * weight(x.method)) {
        heldReply = true;
        return hold(`${String(x.method)} reply`, epochOf(x), rangeOf(x), null, groupOf(x)).then(deliver);
      }
      // 止めない応答は、遅れた pull の応答のときだけ Promise を返す (ほかは、応答の Promise の段を変えない)。
      try {
        deliver();
      } catch (e) {
        return Promise.reject(e);
      }
      return undefined;
    },
    /** Meta の endMove の要求 (送り手は子 child) と応答。 */
    async endMove(epoch: number, move: Interval & { to: string }, side: "request" | "reply"): Promise<void> {
      if (side === "request" && closed(epoch)) tally(counts.outlived, "endMove request");
      if (holds.size >= max || r4() >= opt.share * weight("endMove")) return;
      await hold(`endMove ${side}`, epoch, { start: move.start, end: move.end }, side === "request" ? move.to : null, null, side === "reply");
    },
    moverDone(): void {
      moverDone = true;
    },
    driving(on: boolean): void {
      drivingSince = on ? c.time : null;
    },
    /** 止めたメッセージが全部届くまで待つ。 */
    async drained(): Promise<void> {
      while (holds.size > 0) await Promise.all([...holds]);
    },
    /** 静止した後で、遅れて届いた応答が、受け手に到着の記録を足したかを確かめる (不変条件 15)。 */
    afterQuiet(): string[] {
      const out: string[] = [];
      for (const r of replies) {
        if (arrivals(r.x.from, r.g, r.epoch) === r.n) continue;
        tally(counts.broken, `reply ${r.row}`);
        out.push(`${r.x.from} recorded the arrival of group ${r.g} in move ${r.epoch} from an answer that arrived after it finished receiving that move (situation ${r.row})`);
      }
      return [...new Set(out)];
    },
  };
}
