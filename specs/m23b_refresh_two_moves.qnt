// M23b: 範囲がもう一度動く間も続く取引。確かめを、受け取りの記録をたどって前の持ち主たちで埋める (未解決の問題 37 の続き)
//
// 2026-11-16 に書いた。実装より先に書いたモデルで、対応する実装はまだない。設計は docs/design-refresh-across-move.md の「移し直し」
// にある。M23 (m23_refresh_across_move.qnt) は、移動 1 回だけを扱った。ここでは、取引が最初の移動の前の読み取り時刻を持ったまま、
// 範囲がもう一度動く (S0 から S1、S1 から S2)。M23 の推奨の組み合わせ (設計 1、いまの親、確かめの上限) を固定して、確かめの窓が
// 2 回の移動をまたぐときの規則だけを確かめる。
//
// 舞台。シャード S0 (=1)、S1 (=2)、S2 (=3)。行 K1 は S0 に残り、行 K2 のグループが S0 から S1 へ (移動 1)、S1 から S2 へ (移動 2) 移る。
// BACK なら、移動 2 の行き先は S0 で、範囲は前の持ち主へ戻る (持ち主の列に閉路ができる)。いまのコードでは、戻す移動は始められる
// (beginIncomingStep が断るのは終わっていない fence だけ) が、S0 は、送り出した範囲の要求を、移動を終えた後も __fenced で断り
// 続ける (kernel.ts の fencedIn) ので、戻った範囲に答えない。catalog epoch の段 4 で __fenced の終わった行と比べるのをやめると、
// 答えるようになる (docs/design-catalog-epoch.md の「token の区間の移動との関係」)。
// 移動は M23 と同じ 4 手である。
//   start   Meta が move-start を記録する (epoch が 1 つ進む)。親の fence、子の受け取りの始まり、範囲表の切り替えが 1 手で起きる
//   pull    親が m を決め (時計 + 1)、行と intent を応答に載せる。親は以後、K2 の書き込みも phase 2 も受けない
//   recv    子が受け取る。到着の m を残し、時計を m まで進める。運ばれた intent は子に移る
//   finish  親が床 f を発行し (時計 + 1)、子は時計を f まで進めて、床として残す
// 移動 2 の start は、移動 1 の finish の後でだけ起きる。受け取り中のシャードは fence しない (kernel.ts の fenceStep が
// `still receiving` で断る)。だから S1 は、送り出す前に時計を m1 まで進めていて、m1 < m2 である。下の「前の持ち主に尋ねる」が
// 終わるのは、この順序による。
//
// 確かめ (read refresh と、確定の prepare の検証) は、M23 の設計 1 を、尋ねられた側にも繰り返す。
//   いまの持ち主は、自分の記録を from (span の下限 lo) から確かめる。自分の受け取りの記録 (渡した側と、到着の m) を見て、lo < m なら、
//   渡した側に (lo, m] を尋ねる。
//   尋ねられたシャードは、自分の記録を lo から (lo, up] で確かめる。up は尋ねた側の到着の m である。自分の受け取りの記録のうち、
//   up より前に受け取ったものを選び、lo < その m なら、さらにその渡した側に (lo, m] を尋ねる。なければ止まる。
//   尋ねるたびに窓の上端 up は小さくなる (選ぶ記録の m は up より小さい) ので、尋ねる列は、移動の数だけで終わる。
// 尋ねる手は 1 つずつ別の手にした (askStep)。尋ねられるシャードは、どれも pull を終えていて、窓の分の記録はもう変わらない
// (parentFrozen) が、尋ねる列が終わることを、手の列として確かめるためである。いまの持ち主の答え (自分の記録の確かめ、時計を to
// まで進めること、intent の push) は、尋ねる列が終わった後の 1 手である。
//
// 書き手は M23 と同じで、K2 に書く autocommit の書き込み W 1 回と、K2 に書く 2PC の取引 Y 1 件である。どちらも、そのときの持ち主で
// 書く。Y の intent は、pull に乗って移動のたびに運ばれ、phase 2 は、移動の記録 (__moved_txn) をたどって、いまの持ち主に届く。
// 取引 X は M23 と同じ形で、全表 (K1 と K2) を読み、形によって全表をもう 1 回読み、K2 を書いて確定する。Worker は、NotOwner で
// 断られるたびに Meta から範囲表を取り直す (ep を Meta の epoch にする)。X の intent も、prepare の後でグループが動けば運ばれる。
// BACK のインスタンスは読むだけである (X が書くと、S0 で 1 シャードの確定になり、そこにも同じ規則が要るが、モデルにしていない)。
//
// invariant
//   serializable          確定した X の読みは、確定の点の値と一致する (M23 と同じ)
//   readConsistent        シャードが答えた読みは、その時刻の真の値と一致する
//   placementIndependent  X が失敗するのは、読んだ行が読んだ後に別の取引に書かれたとき、または書く X が読んだ行に別の取引の intent
//                         があったときだけである
//   boundedRefusals       X が移動を理由に断られる回数は、移動の数以下である
//   boundedAsks           1 回の確かめが前の持ち主に尋ねる回数は、移動の数以下である
//   parentFrozen          K2 を pull で渡したシャードは、受け取り直すまで K2 の書き込みを適用しない
//   readOnlyBelowStart    読むだけの X が失敗するのは、refresh の窓 (from, to] に、読んだ行の別の取引の確定があったときだけである
// temporal
//   refreshTerminates     始めた refresh は、いつか終わる
//   asksEnd               前の持ち主に尋ね始めた確かめは、いつか尋ね終わる
//   chainLive             上の 2 つを合わせたもの (check.sh はこれを確かめる)
module m23b_core {
  // ---- 規則の条件。赤は 1 つずつ外す ----
  const FOLLOW: bool            // 尋ねられたシャードも、自分の受け取りの記録をたどって、前の持ち主に尋ね続ける
  const KEEP: bool              // 受け取りの記録 (渡した側と m) を、受け取りを終えた (finish) 後も残す
  const BY_TIME: bool           // 尋ねられたシャードは、窓の上端 up より前に受け取った記録を選ぶ (false: いちばん新しい記録を選ぶ)
  const MID_FROM_ARRIVAL: bool  // 赤: 尋ねられたシャードが、自分の記録を、lo ではなく、自分の到着の m から確かめる
  const MID_REFUSES: bool       // 移動 2 で渡した S1 も、渡した K2 の、Worker からの確かめを NotOwner で断る
  const SKIP_PUSH: bool         // 赤: いまの持ち主の確かめが、c の決まっていない intent を、push せずに通す (失敗もしない)
  // ---- 場面 ----
  const MOVES_N: int            // 移動の数 (1 か 2)
  const BACK: bool              // 移動 2 の行き先は S0 (閉路)
  const SCAN2: bool             // X は全表をもう 1 回読む
  const WRITE: bool             // X は K2 を書く
  const PESSIMISTIC: bool       // X の書き込みは悲観
  const OTHER: bool             // X は、ほかのシャードの ReadTooOld で、任意の to への refresh を始める
  const HAS_W: bool
  const HAS_Y: bool
  const TICKS: int
  const T_MAX: int

  pure val S0 = 1
  pure val S1 = 2
  pure val S2 = 3
  pure val SHARDS = Set(1, 2, 3)
  pure val K1 = 1                 // S0 に残る行
  pure val K2 = 2                 // 動く行
  pure val KEYS = Set(1, 2)
  pure val X = 10
  pure val W = 11
  pure val Y = 12
  pure val INF = 1000
  pure val MOVES = Set(1, 2)
  // 移動 i の渡す側と受け取る側
  pure def src(i: int): int = if (i == 1) S0 else S1
  pure def dst(i: int): int = if (i == 1) S1 else if (BACK) S0 else S2
  // X の状態
  pure val IDLE = 0
  pure val ACTIVE = 1
  pure val PREPARED = 2
  pure val COMMITTED = 3
  pure val ABORTED = 4
  // X の次の文
  pure val PC_SCAN1 = 0
  pure val PC_SCAN2 = 1
  pure val PC_WRITE = 2
  pure val PC_COMMIT = 3
  // 前の持ち主に尋ねる列
  pure val C_NONE = 0             // 尋ねていない
  pure val C_ASK = 1              // 尋ねている (ask に (lo, up] を尋ねる)
  pure val C_DONE = 2             // 尋ね終わり、どの前の持ち主にも変更がなかった

  type Ver = { ver: int, writer: int }
  type Intent = { where: int, pts: int, c: int, pushed: int }      // where: 0 なし、1..3 シャード、4 適用済み
  type Move = { moved: int, flying: bool, carry: bool, img: Ver, arrived: int, floor: int }
  type Txn = {
    st: int, pc: int, done: Set[int], T: int, ep: int,
    lo: int -> int,               // 行 -> 検証の下限 (-1 は読んでいない)
    seen: int -> Set[int],        // 行 -> 読んだ値 (書き手の id)
    at: Set[int],                 // K2 を読んだシャード
    rTo: int,                     // refresh の to (0 は refresh の途中でない)
    rRem: Set[(int, int)],        // 確かめが残っている (行, シャード)
    rFatal: bool,                 // 移動による ReadTooOld で始めた refresh
    ask: int, up: int,            // 尋ねている前の持ち主と、窓の上端
    chain: int, asks: int,        // 尋ねる列の状態と、尋ねた数
    wrote: bool, wAt: int, ptsC: int, c: int, applied: bool
  }
  type Ghost = {
    whyChange: bool,              // X が失敗したとき、読んだ行に、読んだ後の別の取引の確定があった
    whyIntent: bool,              // X が失敗したとき、K2 に別の取引の intent があった
    whyBelow: bool,               // X の refresh が通らなかったとき、読んだ行に、読んだ後で to 以下の時刻の、別の取引の確定があった
    crossed1: bool,               // 移動 1 の時刻をまたいで T を進めた refresh が通った
    crossed2: bool,               // 移動 1 と移動 2 の両方の時刻をまたいで T を進めた refresh が通った
    oneHop: bool,                 // 移動 1 の後、移動 2 の前に読んだ K2 の refresh が、移動 2 をまたいで、前の持ち主 1 つに尋ねて通った
    refusals: int,                // 移動を理由に断られた回数 (3 で止める)
    maxAsks: int,                 // 1 回の確かめが尋ねた数の最大 (3 で止める)
    badRead: bool,
    frozenBroken: bool,
    wAt: int, wC: int
  }

  var hlc: int -> int
  var log: int -> (int -> Set[Ver])
  var meta: int                   // Meta の epoch。移動 i の start で i になる
  var mv: int -> Move
  var y: Intent
  var wDone: bool
  var ticks: int
  var x: Txn
  var g: Ghost

  pure def max(a: int, b: int): int = if (a > b) a else b
  pure def min(a: int, b: int): int = if (a < b) a else b
  pure def latest(vs: Set[Ver]): Ver = vs.fold({ ver: -1, writer: -1 }, (acc, v) => if (v.ver > acc.ver) v else acc)
  pure def valueAt(vs: Set[Ver], t: int): int = latest(vs.filter(v => v.ver <= t)).writer
  pure val init0: Set[Ver] = Set({ ver: 0, writer: 0 })
  pure val noMove: Move = { moved: 0, flying: false, carry: false, img: { ver: -1, writer: -1 }, arrived: 0, floor: 0 }

  pure val idleTxn: Txn = {
    st: IDLE, pc: PC_SCAN1, done: Set(), T: 0, ep: 0,
    lo: KEYS.mapBy(_ => -1), seen: KEYS.mapBy(_ => Set()), at: Set(),
    rTo: 0, rRem: Set(), rFatal: false, ask: 0, up: 0, chain: C_NONE, asks: 0,
    wrote: false, wAt: 0, ptsC: 0, c: 0, applied: false
  }

  action init = all {
    hlc' = SHARDS.mapBy(_ => 0),
    log' = Map(S0 -> KEYS.mapBy(_ => init0), S1 -> KEYS.mapBy(_ => Set()), S2 -> KEYS.mapBy(_ => Set())),
    meta' = 0,
    mv' = MOVES.mapBy(_ => noMove),
    y' = { where: 0, pts: 0, c: 0, pushed: 0 },
    wDone' = not(HAS_W),
    ticks' = 0,
    x' = idleTxn,
    g' = { whyChange: false, whyIntent: false, whyBelow: false, crossed1: false, crossed2: false, oneHop: false,
           refusals: 0, maxAsks: 0, badRead: false, frozenBroken: false, wAt: 0, wC: 0 }
  }
  action keepWorld = all { hlc' = hlc, log' = log, meta' = meta, mv' = mv, y' = y, wDone' = wDone, ticks' = ticks }

  // ---- 状態から引くもの ----------------------------------------------------------
  def m1: Move = mv.get(1)
  def m2: Move = mv.get(2)
  // d は、いま K2 の持ち主で、グループが届いている (読み、書き込み、確かめに答える)
  def holds(d: int): bool =
    (d == S0 and meta == 0) or (d == S1 and m1.arrived > 0 and meta < 2) or (d == dst(2) and m2.arrived > 0)
  // d は、K2 を渡した (Worker からの K2 の要求を NotOwner で断る)。いまの親と同じく、fence (start) の後から断る。
  // BACK で受け取り直す途中の S0 は断らない (届くのを待ってから答える)
  def handedOff(d: int): bool = (d == S0 and meta >= 1 and not(dst(2) == S0 and meta >= 2)) or (d == S1 and meta >= 2)
  // refresh の確かめ。MID_REFUSES でなければ、S1 は、移動 2 で渡した後も、自分の記録と前の持ち主で答える (赤)
  def refusesConfirm(d: int): bool = handedOff(d) and (d != S1 or MID_REFUSES)
  def answersConfirm(d: int): bool = holds(d) or (d == S1 and meta >= 2 and not(MID_REFUSES))
  // d が K2 の読みに答える、いちばん小さい T (到着の m と床の大きい方)
  def startAt(d: int): int =
    if (d == dst(2) and m2.arrived > 0) max(m2.arrived, m2.floor)
    else if (d == S1) max(m1.arrived, m1.floor)
    else 0
  // d が、行 k の読みに答えるのに使う版。受け取った行 (pull のときの渡す側の最新の版) と、受け取った後の自分の記録である
  def histAt(d: int, k: int): Set[Ver] =
    if (k == K1) log.get(S0).get(K1)
    else log.get(d).get(K2).union(
      if (d == dst(2) and m2.arrived > 0) Set(m2.img) else if (d == S1 and m1.arrived > 0) Set(m1.img) else Set())
  // グループをいま持つシャード。phase 2 は、移動の記録をたどって、ここに届く (受け取りの前なら待つ)
  def holder: int = if (m2.moved > 0) dst(2) else if (m1.moved > 0) S1 else S0
  def holderReady: bool = if (m2.moved > 0) m2.arrived > 0 else if (m1.moved > 0) m1.arrived > 0 else true
  // d は K2 を pull で渡し、まだ受け取り直していない
  def pulledOut(d: int): bool = (d == S0 and m1.moved > 0 and not(dst(2) == S0 and m2.arrived > 0)) or (d == S1 and m2.moved > 0)
  def yOpen: bool = y.where >= 1 and y.where <= 3
  def yAt(d: int): bool = y.where == d
  def allWrites(k: int): Set[Ver] =
    log.get(S0).get(k).union(log.get(S1).get(k)).union(log.get(S2).get(k))
      .union(if (k == K2 and yOpen and y.c > 0) Set({ ver: y.c, writer: Y }) else Set())
  // d の記録に、(from, hi] の、X 以外の書き込みがあるか
  def changedIn(d: int, k: int, from: int, hi: int): bool =
    log.get(d).get(k).exists(v => v.ver > from and v.ver <= hi and v.writer != X)
  def xIntentOpen: bool = x.st == PREPARED or (x.st == COMMITTED and x.ptsC > 0 and not(x.applied))
  def xIntentAt(d: int): bool = xIntentOpen and d == holder
  // Worker の範囲表での宛先
  def ownerAt(e: int): int = if (e == 0) S0 else if (e == 1) S1 else dst(2)
  def route(k: int): int = if (k == K1) S0 else ownerAt(x.ep)
  def yBlocks(d: int, t: int): bool = yAt(d) and y.c > 0 and y.c <= t
  def pushedTo(d: int, t: int): Intent = if (yAt(d) and y.c == 0 and y.pts <= t) y.with("pushed", max(y.pushed, t)) else y
  def yWaits(d: int, upTo: int): bool = yAt(d) and y.c > 0 and y.c <= upTo

  // ---- 受け取りの記録と、前の持ち主に尋ねる規則 -------------------------------------------
  // シャード d の受け取りの記録のうち、時刻 up より前に受け取った、いちばん新しいもの (BY_TIME)。BY_TIME でなければ、up に関わらず、
  // いちばん新しいもの。記録がなければ 0。d が up で手放した持ち方は、up より前のいちばん新しい受け取りで始まっている
  def recBefore(d: int, up: int): int =
    MOVES.filter(i => dst(i) == d and mv.get(i).arrived > 0 and (not(BY_TIME) or mv.get(i).arrived < up))
         .fold(0, (acc, i) => if (acc == 0) i else if (mv.get(i).arrived > mv.get(acc).arrived) i else acc)
  // 受け取りの記録を覚えているか。KEEP でなければ、受け取りを終えると (finish) 忘れる (メモリの this.incoming だけを引く実装)
  def knows(i: int): bool = KEEP or mv.get(i).floor == 0
  // 窓 (lo, ...] の確かめで、シャード d (窓の上端 up) が次に尋ねる先と、その窓の上端。尋ねなければ (0, 0)。
  // top は、Worker から確かめを受けたシャードである。FOLLOW でなければ、尋ねられたシャードは、それ以上尋ねない
  def nextAsk(d: int, up: int, lo: int, top: bool): (int, int) =
    val i = recBefore(d, up)
    if (i == 0) (0, 0)
    else if (knows(i) and (top or FOLLOW) and lo < mv.get(i).arrived) (src(i), mv.get(i).arrived)
    else (0, 0)
  // 尋ねられたシャード a が、自分の記録を確かめる下限
  def askedFrom(a: int, up: int, lo: int): int =
    val i = recBefore(a, up)
    if (MID_FROM_ARRIVAL and i != 0) max(lo, mv.get(i).arrived) else lo
  pure def noChain(t: Txn): Txn = t.with("ask", 0).with("up", 0).with("chain", C_NONE).with("asks", 0)
  def startChain(nx: (int, int)): Txn = x.with("chain", C_ASK).with("ask", nx._1).with("up", nx._2).with("asks", 1)

  // X が失敗するときの理由を、そのときの状態から記録する
  def changeNow: bool = KEYS.exists(k => x.lo.get(k) >= 0 and allWrites(k).exists(v => v.writer != X and v.ver > x.lo.get(k)))
  def intentNow: bool = x.lo.get(K2) >= 0 and yOpen
  def belowNow: bool = x.rTo > 0 and KEYS.exists(k => x.lo.get(k) >= 0 and
    allWrites(k).exists(v => v.writer != X and v.ver > x.lo.get(k) and v.ver <= x.rTo))
  def noted: Ghost = g.with("whyChange", g.whyChange or changeNow).with("whyIntent", g.whyIntent or intentNow)
                      .with("whyBelow", g.whyBelow or belowNow)
  def refused: Ghost = g.with("refusals", min(g.refusals + 1, 3))

  pure def nextPc(pc: int): int =
    if (pc == PC_SCAN1) (if (SCAN2) PC_SCAN2 else if (WRITE) PC_WRITE else PC_COMMIT)
    else if (pc == PC_SCAN2) (if (WRITE) PC_WRITE else PC_COMMIT)
    else PC_COMMIT

  // ---- 取引 X: 開始と読み -----------------------------------------------------------
  action xBegin = all {
    x.st == IDLE,
    x' = idleTxn.with("st", ACTIVE).with("T", hlc.get(S0)).with("ep", meta),
    keepWorld, g' = g
  }

  def inStatement(k: int, w: bool): bool =
    x.st == ACTIVE and x.rTo == 0 and x.chain == C_NONE and
    (if (w) (x.pc == PC_WRITE and k == K2 and not(PESSIMISTIC))
     else ((x.pc == PC_SCAN1 or x.pc == PC_SCAN2) and not(x.done.contains(k))))

  def afterRead(k: int, w: bool, d: int, v: int): Txn =
    val t1 = x.with("seen", x.seen.set(k, x.seen.get(k).union(Set(v))))
              .with("lo", if (x.lo.get(k) < 0) x.lo.set(k, x.T) else x.lo)
              .with("at", if (k == K2) x.at.union(Set(d)) else x.at)
    if (w) t1.with("wrote", true).with("wAt", d).with("pc", PC_COMMIT)
    else if (x.done.union(Set(k)) == KEYS) t1.with("done", Set()).with("pc", nextPc(x.pc))
    else t1.with("done", x.done.union(Set(k)))

  // K1 は S0 が、K2 は持ち主が、到着の m と床の両方以上の T で答える
  action xAnswer(k: int, w: bool, d: int): bool = all {
    inStatement(k, w),
    route(k) == d,
    k == K1 or (holds(d) and x.T >= startAt(d)),
    not(k == K2 and yBlocks(d, x.T)),
    val v = valueAt(histAt(d, k), x.T)
    all {
      x' = afterRead(k, w, d, v),
      hlc' = hlc.set(d, max(hlc.get(d), x.T)),
      y' = if (k == K2) pushedTo(d, x.T) else y,
      g' = g.with("badRead", g.badRead or v != valueAt(allWrites(k), x.T)),
      log' = log, meta' = meta, mv' = mv, wDone' = wDone, ticks' = ticks
    }
  }

  // K2 を渡したシャードが、K2 の文を NotOwner で断る。Worker は Meta から範囲表を取り直す
  def k2Next: bool = x.st == ACTIVE and x.rTo == 0 and x.chain == C_NONE and
    (((x.pc == PC_SCAN1 or x.pc == PC_SCAN2) and not(x.done.contains(K2))) or x.pc == PC_WRITE)
  action xNotOwner = all {
    k2Next, handedOff(route(K2)),
    x' = x.with("ep", meta), g' = refused, keepWorld
  }

  def readKeys: Set[int] = KEYS.filter(k => x.lo.get(k) >= 0)
  def refreshPlan(upTo: int, fatal: bool): Txn =
    if (readKeys == Set()) x.with("T", upTo)
    else x.with("rTo", upTo).with("rFatal", fatal).with("rRem", readKeys.map(k => (k, route(k))))

  // 持ち主が、到着の m か床より小さい T の読みを ReadTooOld で断る。Worker は、T をそこまで進める refresh を始める
  action xTooOld(k: int, w: bool): bool = all {
    inStatement(k, w), k == K2, holds(route(K2)), x.T < startAt(route(K2)),
    x' = refreshPlan(startAt(route(K2)), true),
    keepWorld, g' = g
  }

  // ほかのシャードの ReadTooOld で、任意の to への refresh を始める (範囲表の古い Worker も始める)
  action xOther(upTo: int): bool = all {
    OTHER, x.st == ACTIVE, x.rTo == 0, x.chain == C_NONE, x.pc != PC_COMMIT, upTo > x.T, upTo <= T_MAX,
    x' = refreshPlan(upTo, false),
    keepWorld, g' = g
  }

  // ---- refresh の確かめ ------------------------------------------------------------
  def lastOne(k: int, d: int): bool = x.rRem.exclude(Set((k, d))) == Set()
  def confirmed(k: int, d: int): Txn =
    val t = if (k == K2) noChain(x) else x
    if (not(lastOne(k, d))) t.with("rRem", x.rRem.exclude(Set((k, d))))
    else t.with("T", x.rTo).with("lo", KEYS.mapBy(j => if (x.lo.get(j) >= 0) x.rTo else -1)).with("rTo", 0).with("rRem", Set())
  // 通った refresh が、K2 を読んだ時刻から移動の時刻をまたいだか (witness 用)
  def passedGhost(k: int, d: int): Ghost =
    val lo = x.lo.get(K2)
    val last = lastOne(k, d) and lo >= 0
    g.with("crossed1", g.crossed1 or (last and m1.moved > 0 and lo < m1.moved and m1.moved <= x.rTo))
     .with("crossed2", g.crossed2 or (last and m2.moved > 0 and lo < m1.moved and m2.moved <= x.rTo))
     .with("oneHop", g.oneHop or (k == K2 and m1.moved > 0 and m2.moved > 0 and m1.moved <= lo and lo < m2.moved
                                  and m2.moved <= x.rTo and x.asks == 1))
  // 通らなかった refresh。移動による ReadTooOld の refresh なら、窓 (from, to] に確定があったので、どう進めても通らず、取引は失敗する。
  // ほかの refresh は、後の refresh を止めない (M23 の BOUNDED の案)
  def failed: Txn = noChain(if (x.rFatal) x.with("st", ABORTED) else x).with("rTo", 0).with("rRem", Set())

  action confirmK1 = all {
    x.st == ACTIVE, x.rTo > 0, x.rRem.contains((K1, S0)),
    val ok = not(changedIn(S0, K1, x.lo.get(K1), x.rTo))
    all {
      x' = if (ok) confirmed(K1, S0) else failed,
      g' = if (ok) passedGhost(K1, S0) else noted,
      hlc' = hlc.set(S0, max(hlc.get(S0), x.rTo)),
      log' = log, meta' = meta, mv' = mv, y' = y, wDone' = wDone, ticks' = ticks
    }
  }

  // K2 の確かめを受けたシャード d。渡した後なら断り、Worker は範囲表を取り直していまの持ち主へ送り直す。持ち主なら、
  // 自分の受け取りの記録を見て、前の持ち主に尋ね始める。尋ね終わったら (か、尋ねる要がなければ)、自分の記録を lo から (lo, to] で
  // 確かめ、時計を to まで進め、c の決まっていない intent を to より上へ push する。c の決まった to 以下の intent は適用を待つ
  action confirmK2(d: int): bool = all {
    x.st == ACTIVE, x.rTo > 0, x.rRem.contains((K2, d)),
    if (refusesConfirm(d)) all {
      x' = noChain(x).with("ep", meta).with("rRem", x.rRem.exclude(Set((K2, d))).union(Set((K2, ownerAt(meta))))),
      g' = refused, keepWorld
    } else all {
      answersConfirm(d),
      val lo = x.lo.get(K2)
      val nx = nextAsk(d, INF, lo, true)
      if (x.chain == C_NONE and nx._1 != 0) all {
        x' = startChain(nx), g' = g.with("maxAsks", max(g.maxAsks, 1)), keepWorld
      } else all {
        x.chain != C_ASK,
        not(yWaits(d, x.rTo)),
        val ok = not(changedIn(d, K2, lo, x.rTo))
        all {
          x' = if (ok) confirmed(K2, d) else failed,
          g' = if (ok) passedGhost(K2, d) else noted,
          hlc' = hlc.set(d, max(hlc.get(d), x.rTo)),
          y' = if (ok and not(SKIP_PUSH)) pushedTo(d, x.rTo) else y,
          log' = log, meta' = meta, mv' = mv, wDone' = wDone, ticks' = ticks
        }
      }
    }
  }

  // 前の持ち主 a に (lo, up] を尋ねる 1 手。a は自分の記録だけで答え (intent は見ない。グループの intent は、pull でいまの持ち主に
  // 移っている)、自分の受け取りの記録のうち up より前のものをたどって、さらに尋ねる。refresh なら窓の上端は to でも切る
  action askStep = all {
    x.chain == C_ASK,
    val lo = x.lo.get(K2)
    val a = x.ask
    val hi = if (x.rTo > 0) x.rTo else INF
    val changed = changedIn(a, K2, askedFrom(a, x.up, lo), min(x.up, hi))
    val nx = nextAsk(a, x.up, lo, false)
    if (changed) all {
      x' = if (x.rTo > 0) failed else noChain(x).with("st", ABORTED),
      g' = noted, keepWorld
    } else if (nx._1 == 0) all {
      x' = x.with("chain", C_DONE).with("ask", 0).with("up", 0), g' = g, keepWorld
    } else all {
      x' = x.with("ask", nx._1).with("up", nx._2).with("asks", min(x.asks + 1, 3)),
      g' = g.with("maxAsks", max(g.maxAsks, min(x.asks + 1, 3))),
      keepWorld
    }
  }

  // ---- 取引 X: 悲観の書き込み ---------------------------------------------------------
  action xDml = all {
    x.st == ACTIVE, x.rTo == 0, x.chain == C_NONE, x.pc == PC_WRITE, PESSIMISTIC,
    val d = route(K2)
    val F = hlc.get(d) + 1
    val v = valueAt(histAt(d, K2), F)
    all {
      holds(d),
      not(yBlocks(d, F)),
      x' = x.with("seen", x.seen.set(K2, x.seen.get(K2).union(Set(v))))
            .with("lo", x.lo.set(K2, if (x.lo.get(K2) < 0) F else min(x.lo.get(K2), F)))
            .with("wrote", true).with("wAt", d).with("pc", PC_COMMIT).with("at", x.at.union(Set(d))),
      hlc' = hlc.set(d, F),
      y' = pushedTo(d, F),
      g' = g.with("badRead", g.badRead or v != valueAt(allWrites(K2), F)),
      log' = log, meta' = meta, mv' = mv, wDone' = wDone, ticks' = ticks
    }
  }

  // ---- 取引 X: 確定 ---------------------------------------------------------------
  action xFinishRO = all {
    x.st == ACTIVE, x.rTo == 0, x.chain == C_NONE, x.pc == PC_COMMIT, not(x.wrote),
    x' = x.with("st", COMMITTED).with("c", x.T),
    keepWorld, g' = g
  }
  // 1 シャードの確定 (K2 の持ち主が S0。移動の前)。S0 は fence の後、K2 の書き込みを断る
  action xCommitLocal = all {
    x.st == ACTIVE, x.rTo == 0, x.chain == C_NONE, x.pc == PC_COMMIT, x.wrote, route(K2) == S0, not(BACK),
    if (handedOff(S0)) all {
      x' = x.with("ep", meta), g' = refused, keepWorld
    } else all {
      holds(S0),
      val ok = KEYS.forall(k => x.lo.get(k) < 0 or not(changedIn(S0, k, x.lo.get(k), INF))) and not(yAt(S0))
      val c = hlc.get(S0) + 1
      all {
        x' = if (ok) x.with("st", COMMITTED).with("c", c).with("applied", true) else x.with("st", ABORTED),
        hlc' = if (ok) hlc.set(S0, c) else hlc,
        log' = if (ok) log.set(S0, log.get(S0).set(K2, log.get(S0).get(K2).union(Set({ ver: c, writer: X })))) else log,
        g' = if (ok) g else noted,
        meta' = meta, mv' = mv, y' = y, wDone' = wDone, ticks' = ticks
      }
    }
  }
  // K2 の持ち主 (S1 か S2) での prepare。refresh と同じ規則で、前の持ち主に尋ねてから、自分の記録を lo から確かめる (上限なし)
  action xPrepare = all {
    x.st == ACTIVE, x.rTo == 0, x.pc == PC_COMMIT, x.wrote, route(K2) != S0,
    val d = route(K2)
    if (handedOff(d)) all {
      x' = noChain(x).with("ep", meta), g' = refused, keepWorld
    } else all {
      holds(d),
      val lo = x.lo.get(K2)
      val nx = nextAsk(d, INF, lo, true)
      if (x.chain == C_NONE and nx._1 != 0) all {
        x' = startChain(nx), g' = g.with("maxAsks", max(g.maxAsks, 1)), keepWorld
      } else all {
        x.chain != C_ASK,
        val ok = not(changedIn(d, K2, lo, INF)) and not(yAt(d))
        val pts = hlc.get(d) + 1
        all {
          x' = noChain(if (ok) x.with("st", PREPARED).with("ptsC", pts) else x.with("st", ABORTED)),
          hlc' = if (ok) hlc.set(d, pts) else hlc,
          g' = if (ok) g else noted,
          log' = log, meta' = meta, mv' = mv, y' = y, wDone' = wDone, ticks' = ticks
        }
      }
    }
  }
  // S0 (anchor) の prepare。最後に prepare し、c を決める。K1 を検証する
  action xPrepareP = all {
    x.st == PREPARED,
    val lo1 = x.lo.get(K1)
    val ok = lo1 < 0 or not(changedIn(S0, K1, lo1, INF))
    val c = max(hlc.get(S0), x.ptsC) + 1
    all {
      x' = if (ok) x.with("st", COMMITTED).with("c", c) else x.with("st", ABORTED),
      hlc' = if (ok) hlc.set(S0, c) else hlc,
      g' = if (ok) g else noted,
      log' = log, meta' = meta, mv' = mv, y' = y, wDone' = wDone, ticks' = ticks
    }
  }
  // phase 2。移動の記録をたどって、グループをいま持つシャードで適用する
  action xApply = all {
    x.st == COMMITTED, x.ptsC > 0, not(x.applied), holderReady,
    val d = holder
    all {
      x' = x.with("applied", true),
      log' = log.set(d, log.get(d).set(K2, log.get(d).get(K2).union(Set({ ver: x.c, writer: X })))),
      hlc' = hlc.set(d, max(hlc.get(d), x.c)),
      g' = g.with("frozenBroken", g.frozenBroken or pulledOut(d)),
      meta' = meta, mv' = mv, y' = y, wDone' = wDone, ticks' = ticks
    }
  }

  // ---- ほかの書き手 ----------------------------------------------------------------
  action wWrite(d: int): bool = all {
    not(wDone), holds(d), not(yAt(d)), not(xIntentAt(d)),
    val c = hlc.get(d) + 1
    all {
      hlc' = hlc.set(d, c),
      log' = log.set(d, log.get(d).set(K2, log.get(d).get(K2).union(Set({ ver: c, writer: W })))),
      wDone' = true,
      g' = g.with("wAt", d).with("wC", c),
      meta' = meta, mv' = mv, y' = y, ticks' = ticks, x' = x
    }
  }
  action yPrepare(d: int): bool = all {
    HAS_Y, y.where == 0, holds(d), not(xIntentAt(d)),
    val pts = hlc.get(d) + 1
    all {
      hlc' = hlc.set(d, pts),
      y' = { where: d, pts: pts, c: 0, pushed: 0 },
      log' = log, meta' = meta, mv' = mv, wDone' = wDone, ticks' = ticks, x' = x, g' = g
    }
  }
  action yDecide(c: int): bool = all {
    yOpen, y.c == 0, c >= y.pts, c > y.pushed, c <= y.pts + 2,
    y' = y.with("c", c),
    hlc' = hlc, log' = log, meta' = meta, mv' = mv, wDone' = wDone, ticks' = ticks, x' = x, g' = g
  }
  action yPhase2 = all {
    yOpen, y.c > 0, holderReady,
    val d = holder
    all {
      log' = log.set(d, log.get(d).set(K2, log.get(d).get(K2).union(Set({ ver: y.c, writer: Y })))),
      hlc' = hlc.set(d, max(hlc.get(d), y.c)),
      y' = y.with("where", 4),
      g' = g.with("frozenBroken", g.frozenBroken or pulledOut(d)),
      meta' = meta, mv' = mv, wDone' = wDone, ticks' = ticks, x' = x
    }
  }

  // ---- 移動 ------------------------------------------------------------------------
  // 移動 2 は、移動 1 を終えた後でだけ始まる (受け取り中のシャードは fence しない)
  action start(i: int): bool = all {
    i <= MOVES_N, meta == i - 1, i == 1 or m1.floor > 0,
    meta' = i,
    hlc' = hlc, log' = log, mv' = mv, y' = y, wDone' = wDone, ticks' = ticks, x' = x, g' = g
  }
  action pull(i: int): bool = all {
    meta >= i, mv.get(i).moved == 0,
    val s = src(i)
    val m = hlc.get(s) + 1
    all {
      hlc' = hlc.set(s, m),
      mv' = mv.set(i, mv.get(i).with("moved", m).with("flying", true).with("carry", yAt(s)).with("img", latest(histAt(s, K2)))),
      log' = log, meta' = meta, y' = y, wDone' = wDone, ticks' = ticks, x' = x, g' = g
    }
  }
  action recv(i: int): bool = all {
    mv.get(i).flying,
    val d = dst(i)
    all {
      mv' = mv.set(i, mv.get(i).with("flying", false).with("arrived", mv.get(i).moved)),
      hlc' = hlc.set(d, max(hlc.get(d), mv.get(i).moved)),
      y' = if (mv.get(i).carry and y.where == src(i)) y.with("where", d) else y,
      log' = log, meta' = meta, wDone' = wDone, ticks' = ticks, x' = x, g' = g
    }
  }
  action finish(i: int): bool = all {
    mv.get(i).arrived > 0, mv.get(i).floor == 0,
    val s = src(i)
    val d = dst(i)
    val f = hlc.get(s) + 1
    all {
      hlc' = hlc.set(s, f).set(d, max(hlc.get(d), f)),
      mv' = mv.set(i, mv.get(i).with("floor", f)),
      log' = log, meta' = meta, y' = y, wDone' = wDone, ticks' = ticks, x' = x, g' = g
    }
  }
  action tick(d: int): bool = all {
    ticks < TICKS,
    hlc' = hlc.set(d, hlc.get(d) + 1), ticks' = ticks + 1,
    log' = log, meta' = meta, mv' = mv, y' = y, wDone' = wDone, x' = x, g' = g
  }

  action step = any {
    xBegin,
    xNotOwner,
    { nondet k = oneOf(KEYS) nondet w = oneOf(Set(true, false)) nondet d = oneOf(SHARDS) xAnswer(k, w, d) },
    { nondet k = oneOf(KEYS) nondet w = oneOf(Set(true, false)) xTooOld(k, w) },
    { nondet upTo = oneOf(1.to(T_MAX)) xOther(upTo) },
    confirmK1,
    { nondet d = oneOf(SHARDS) confirmK2(d) },
    askStep,
    xDml, xFinishRO, xCommitLocal, xPrepare, xPrepareP, xApply,
    { nondet d = oneOf(SHARDS) wWrite(d) },
    { nondet d = oneOf(SHARDS) yPrepare(d) },
    { nondet c = oneOf(1.to(T_MAX + 8)) yDecide(c) },
    yPhase2,
    { nondet i = oneOf(MOVES) any { start(i), pull(i), recv(i), finish(i) } },
    { nondet d = oneOf(SHARDS) tick(d) }
  }

  // ---- 不変条件 ---------------------------------------------------------------------
  def expected(k: int): int =
    if (x.wrote) latest(allWrites(k).filter(v => v.writer != X and v.ver < x.c)).writer
    else valueAt(allWrites(k), x.T)
  val serializable = x.st != COMMITTED or KEYS.forall(k => x.lo.get(k) < 0 or x.seen.get(k) == Set(expected(k)))
  val readConsistent = not(g.badRead)
  val placementIndependent = x.st != ABORTED or g.whyChange or (WRITE and g.whyIntent)
  val readOnlyBelowStart = WRITE or x.st != ABORTED or g.whyBelow
  val boundedRefusals = g.refusals <= MOVES_N
  val boundedAsks = g.maxAsks <= MOVES_N
  val parentFrozen = not(g.frozenBroken)
  val m23bSafe = serializable and readConsistent and placementIndependent and boundedRefusals and boundedAsks and parentFrozen
  // 読むだけの取引のインスタンスで、m23bSafe と readOnlyBelowStart を 1 回の検査で確かめる
  val m23bSafeRO = m23bSafe and readOnlyBelowStart

  // ---- witness ----------------------------------------------------------------------
  // 再現の形を移動 2 回で: 移動 1 の前に S0 で全表を読み、2 回の移動の後に refresh で T を進めて読み直し (K2 は移動 2 の行き先で
  // 読む)、動いた行をそこで書いて確定した。読んだ値はどれも変わっていない。確かめは、前の持ち主 2 つ (S1 と S0) に尋ねた
  val witnessReproduction2 = not(x.st == COMMITTED and x.applied and x.ptsC > 0 and x.at.contains(S0) and x.at.contains(dst(2))
                                  and g.crossed2 and g.maxAsks == 2 and KEYS.forall(k => x.seen.get(k).size() == 1))
  // 移動 1 と移動 2 の間に S1 で読んだ K2 の refresh が、移動 2 をまたいで、S1 だけに尋ねて通り、X が確定した
  val witnessOneHop = not(g.oneHop and x.st == COMMITTED)
  // T が移動 1 の m より小さいまま、X が移動 2 の行き先で確定した (悲観の取引)
  val witnessBelowArrival2 = not(x.st == COMMITTED and x.ptsC > 0 and x.applied and m2.arrived > 0 and x.T < m1.moved)
  // 2 回の移動をまたいで T を進めた refresh が通り、読むだけの X が確定した (BACK では、範囲が S0 へ戻った後)
  val witnessReadAcross2 = not(g.crossed2 and x.st == COMMITTED and g.maxAsks == 2)
  // 前の持ち主の S0 で、移動 1 の前に確定した W を、尋ねる列が見つけ、X が競合になった
  val witnessFoundAtS0 = not(x.st == ABORTED and g.whyChange and g.wAt == S0 and m2.arrived > 0)

  // ---- 活性 -------------------------------------------------------------------------
  val vars = (hlc, log, meta, mv, y, wDone, ticks, x, g)
  temporal fairness = and {
    weakFair(confirmK1, vars), weakFair(confirmK2(S0), vars), weakFair(confirmK2(S1), vars), weakFair(confirmK2(S2), vars),
    weakFair(askStep, vars),
    weakFair(pull(1), vars), weakFair(recv(1), vars), weakFair(pull(2), vars), weakFair(recv(2), vars),
    weakFair(yPhase2, vars)
  }
  temporal refreshTerminates = fairness implies always(x.rTo > 0 implies eventually(x.rTo == 0))
  temporal asksEnd = fairness implies always(x.chain == C_ASK implies eventually(x.chain != C_ASK))
  // 2 つを 1 回の検査で確かめる (check.sh はこれを使う)
  temporal chainLive = fairness implies always((x.rTo > 0 implies eventually(x.rTo == 0))
                                               and (x.chain == C_ASK implies eventually(x.chain != C_ASK)))
}

// ---- 規則 (緑) ---------------------------------------------------------------------------------------------------------

// 全表を 2 回読み、K2 を楽観で書く (再現の形)。W と Y がある。範囲表の古い Worker の refresh (OTHER) もある。T の上限 6。
// 大きいので、check.sh では HEAVY にした。既定では、書き手を 1 つずつにした m23b_green_w と m23b_green_y を確かめる
module m23b_green {
  import m23b_core(FOLLOW = true, KEEP = true, BY_TIME = true, MID_FROM_ARRIVAL = false, MID_REFUSES = true, SKIP_PUSH = false,
                   MOVES_N = 2, BACK = false, SCAN2 = true, WRITE = true, PESSIMISTIC = false, OTHER = true, HAS_W = true, HAS_Y = true,
                   TICKS = 0, T_MAX = 6).*
  // 再現の 1 つ目を移動 2 回で: 移動 1 の前に全表を読み、2 回の移動の後に読み直して、動いた行を書いて確定する
  run reproductionTest =
    init.then(xBegin)                                                        // T = 0
        .then(xAnswer(K1, false, S0)).then(xAnswer(K2, false, S0))
        .then(start(1)).then(pull(1)).then(recv(1)).then(finish(1))           // m1 = 1、床 2
        .then(start(2)).then(pull(2)).then(recv(2)).then(finish(2))           // m2 = 3、床 4
        .expect(m1.moved == 1 and m2.moved == 3 and m2.floor == 4)
        .then(xAnswer(K1, false, S0))
        .then(xNotOwner)                                                     // S0 が K2 を断る。範囲表を取り直す
        .expect(x.ep == 2)
        .then(xTooOld(K2, false))                                            // S2: T = 0 < 床 4
        .expect(x.rTo == 4 and x.rRem == Set((K1, S0), (K2, S2)))
        .then(confirmK1)
        .then(confirmK2(S2))                                                 // S2 は、受け取りの記録から S1 に (0, 3] を尋ねる
        .expect(x.chain == C_ASK and x.ask == S1 and x.up == 3)
        .then(askStep)                                                       // S1 は変更なし。自分の記録から S0 に (0, 1] を尋ねる
        .expect(x.ask == S0 and x.up == 1)
        .then(askStep)                                                       // S0 は変更なし。S0 に受け取りの記録はない
        .expect(x.chain == C_DONE)
        .then(confirmK2(S2))                                                 // S2 が自分の記録を (0, 4] で確かめる
        .expect(x.T == 4 and x.rTo == 0 and g.crossed2)
        .then(xAnswer(K2, false, S2))
        .then(xAnswer(K2, true, S2))                                         // UPDATE
        .then(xPrepare).then(xPrepareP).then(xApply)
        .expect(x.st == COMMITTED and m23bSafe and not(witnessReproduction2))
  // 移動 1 の前に、別の接続が S0 で動く行を書いた。尋ねる列が S0 でそれを見つけ、読み直しは競合になる
  run conflictTest =
    init.then(xBegin)
        .then(xAnswer(K1, false, S0)).then(xAnswer(K2, false, S0))         // T = 0
        .then(wWrite(S0))                                                    // c = 1
        .then(start(1)).then(pull(1)).then(recv(1)).then(finish(1))
        .then(start(2)).then(pull(2)).then(recv(2)).then(finish(2))
        .then(xAnswer(K1, false, S0)).then(xNotOwner).then(xTooOld(K2, false))
        .then(confirmK1).then(confirmK2(S2)).then(askStep).then(askStep)
        .expect(x.st == ABORTED and g.whyChange and m23bSafe and not(witnessFoundAtS0))
  // 移動 1 と 2 の間に S1 で読み直した取引は、移動 2 の後の refresh で、S1 だけに尋ねる
  run oneHopTest =
    init.then(xBegin)
        .then(xAnswer(K1, false, S0)).then(xAnswer(K2, false, S0))
        .then(start(1)).then(pull(1)).then(recv(1)).then(finish(1))           // m1 = 1、床 2
        .then(xAnswer(K1, false, S0)).then(xNotOwner).then(xTooOld(K2, false))
        .then(confirmK1).then(confirmK2(S1)).then(askStep).then(confirmK2(S1))
        .expect(x.T == 2 and g.crossed1)
        .then(xAnswer(K2, false, S1))                                        // lo = 2
        .then(start(2)).then(pull(2)).then(recv(2)).then(finish(2))           // m2 = 3、床 4
        .then(xNotOwner)                                                     // UPDATE を、渡した S1 が断る
        .expect(x.st == ACTIVE and x.ep == 2)
        .then(xOther(5))
        .then(confirmK1).then(confirmK2(S2))                                 // S2 は S1 に (2, 3] を尋ねる
        .expect(x.ask == S1)
        .then(askStep)                                                       // S1 の受け取りは m1 = 1 <= 2 なので、それ以上尋ねない
        .expect(x.chain == C_DONE)
        .then(confirmK2(S2))
        .expect(x.T == 5 and g.oneHop)
        .then(xAnswer(K2, true, S2)).then(xPrepare).then(xPrepareP).then(xApply)
        .expect(x.st == COMMITTED and m23bSafe and not(witnessOneHop))
}

// m23b_green の書き手を 1 つずつにした形 (check.sh の既定。m23b_green は HEAVY)。W だけ、Y だけ。T の上限 5
module m23b_green_w {
  import m23b_core(FOLLOW = true, KEEP = true, BY_TIME = true, MID_FROM_ARRIVAL = false, MID_REFUSES = true, SKIP_PUSH = false,
                   MOVES_N = 2, BACK = false, SCAN2 = true, WRITE = true, PESSIMISTIC = false, OTHER = true, HAS_W = true, HAS_Y = false,
                   TICKS = 0, T_MAX = 5).*
}
module m23b_green_y {
  import m23b_core(FOLLOW = true, KEEP = true, BY_TIME = true, MID_FROM_ARRIVAL = false, MID_REFUSES = true, SKIP_PUSH = false,
                   MOVES_N = 2, BACK = false, SCAN2 = true, WRITE = true, PESSIMISTIC = false, OTHER = true, HAS_W = false, HAS_Y = true,
                   TICKS = 0, T_MAX = 5).*
}

// 読むだけの取引。読むだけの X が失敗するのは、窓 (読んだ時刻, to] に確定があるときだけである (案 A')。W と Y の両方 (HEAVY)
module m23b_green_ro {
  import m23b_core(FOLLOW = true, KEEP = true, BY_TIME = true, MID_FROM_ARRIVAL = false, MID_REFUSES = true, SKIP_PUSH = false,
                   MOVES_N = 2, BACK = false, SCAN2 = true, WRITE = false, PESSIMISTIC = false, OTHER = true, HAS_W = true, HAS_Y = true,
                   TICKS = 0, T_MAX = 5).*
}
// 同じく、書き手を 1 つずつにした形 (check.sh の既定)
module m23b_green_ro_w {
  import m23b_core(FOLLOW = true, KEEP = true, BY_TIME = true, MID_FROM_ARRIVAL = false, MID_REFUSES = true, SKIP_PUSH = false,
                   MOVES_N = 2, BACK = false, SCAN2 = true, WRITE = false, PESSIMISTIC = false, OTHER = true, HAS_W = true, HAS_Y = false,
                   TICKS = 0, T_MAX = 5).*
}
module m23b_green_ro_y {
  import m23b_core(FOLLOW = true, KEEP = true, BY_TIME = true, MID_FROM_ARRIVAL = false, MID_REFUSES = true, SKIP_PUSH = false,
                   MOVES_N = 2, BACK = false, SCAN2 = true, WRITE = false, PESSIMISTIC = false, OTHER = true, HAS_W = false, HAS_Y = true,
                   TICKS = 0, T_MAX = 5).*
}

// 悲観の取引。全表を読み、動いた行を DML で書く。T は最初の読みのまま、2 回の移動の後に確定する
module m23b_green_pess {
  import m23b_core(FOLLOW = true, KEEP = true, BY_TIME = true, MID_FROM_ARRIVAL = false, MID_REFUSES = true, SKIP_PUSH = false,
                   MOVES_N = 2, BACK = false, SCAN2 = false, WRITE = true, PESSIMISTIC = true, OTHER = true, HAS_W = true, HAS_Y = true,
                   TICKS = 0, T_MAX = 5).*
  run belowArrivalTest =
    init.then(xBegin)
        .then(xAnswer(K1, false, S0)).then(xAnswer(K2, false, S0))         // T = 0
        .then(start(1)).then(pull(1)).then(recv(1)).then(finish(1))
        .then(start(2)).then(pull(2)).then(recv(2)).then(finish(2))           // m1 = 1、m2 = 3
        .then(xNotOwner)                                                     // 悲観の DML は、渡した S0 に断られる
        .then(xDml)                                                          // S2 の F = 5 の最新を読む。T は 0 のまま
        .expect(x.T == 0 and x.lo.get(K2) == 0 and x.wAt == S2)
        .then(xPrepare).then(askStep).then(askStep).then(xPrepare)           // (0, 3] を S1 に、(0, 1] を S0 に尋ねてから検証する
        .then(xPrepareP).then(xApply)
        .expect(x.st == COMMITTED and m23bSafe and not(witnessBelowArrival2))
}

// 範囲が S0 へ戻る形の、書き手を Y だけにしたもの (check.sh の既定。m23b_green_back は W と Y の両方で HEAVY)
module m23b_green_back_y {
  import m23b_core(FOLLOW = true, KEEP = true, BY_TIME = true, MID_FROM_ARRIVAL = false, MID_REFUSES = true, SKIP_PUSH = false,
                   MOVES_N = 2, BACK = true, SCAN2 = true, WRITE = false, PESSIMISTIC = false, OTHER = true, HAS_W = false, HAS_Y = true,
                   TICKS = 0, T_MAX = 5).*
}

// 範囲が前の持ち主 S0 へ戻る (閉路)。読むだけの取引。受け取りの記録を時刻で選べば、尋ねる列は閉路でも終わる
module m23b_green_back {
  import m23b_core(FOLLOW = true, KEEP = true, BY_TIME = true, MID_FROM_ARRIVAL = false, MID_REFUSES = true, SKIP_PUSH = false,
                   MOVES_N = 2, BACK = true, SCAN2 = true, WRITE = false, PESSIMISTIC = false, OTHER = true, HAS_W = true, HAS_Y = true,
                   TICKS = 0, T_MAX = 5).*
  run backTest =
    init.then(xBegin)
        .then(xAnswer(K1, false, S0)).then(xAnswer(K2, false, S0))         // T = 0
        .then(start(1)).then(pull(1)).then(recv(1)).then(finish(1))           // m1 = 1
        .then(start(2)).then(pull(2)).then(recv(2)).then(finish(2))           // S1 から S0 へ。m2 = 3、床 4
        .then(xAnswer(K1, false, S0))
        .then(xTooOld(K2, false))                                            // 範囲表の古い Worker の宛先 S0 が、いまの持ち主である
        .then(confirmK1).then(confirmK2(S0))                                 // S0 は S1 に (0, 3] を尋ねる
        .then(askStep)                                                       // S1 は S0 に (0, 1] を尋ねる
        .expect(x.ask == S0 and x.up == 1)
        .then(askStep)                                                       // S0 の受け取り (m2 = 3) は 1 より後なので、それ以上尋ねない
        .expect(x.chain == C_DONE)
        .then(confirmK2(S0)).then(xAnswer(K2, false, S0)).then(xFinishRO)
        .expect(x.st == COMMITTED and m23bSafe and not(witnessReadAcross2))
}

// 活性。読むだけの取引、Y あり、W なし、tick なし
module m23b_live {
  import m23b_core(FOLLOW = true, KEEP = true, BY_TIME = true, MID_FROM_ARRIVAL = false, MID_REFUSES = true, SKIP_PUSH = false,
                   MOVES_N = 2, BACK = false, SCAN2 = true, WRITE = false, PESSIMISTIC = false, OTHER = true, HAS_W = false, HAS_Y = true,
                   TICKS = 0, T_MAX = 4).*
}
module m23b_live_back {
  import m23b_core(FOLLOW = true, KEEP = true, BY_TIME = true, MID_FROM_ARRIVAL = false, MID_REFUSES = true, SKIP_PUSH = false,
                   MOVES_N = 2, BACK = true, SCAN2 = true, WRITE = false, PESSIMISTIC = false, OTHER = true, HAS_W = false, HAS_Y = true,
                   TICKS = 0, T_MAX = 4).*
}

// ---- 赤: 条件を 1 つずつ外す ------------------------------------------------------------------------------------------
// W で破れる赤は m23b_green_w と、Y で破れる赤は m23b_green_y と、外した条件のほかは同じ定数である

// 赤: 尋ねられたシャード (最初の前の持ち主) が、それ以上尋ねない。移動 1 の前に S0 で確定した書き込みを見落とす
module m23b_red_stop_first {
  import m23b_core(FOLLOW = false, KEEP = true, BY_TIME = true, MID_FROM_ARRIVAL = false, MID_REFUSES = true, SKIP_PUSH = false,
                   MOVES_N = 2, BACK = false, SCAN2 = true, WRITE = true, PESSIMISTIC = false, OTHER = true, HAS_W = true, HAS_Y = false,
                   TICKS = 0, T_MAX = 5).*
  run counterexampleTest =
    init.then(xBegin)
        .then(xAnswer(K1, false, S0)).then(xAnswer(K2, false, S0))         // T = 0
        .then(wWrite(S0))                                                    // c = 1 (移動 1 の前)
        .then(start(1)).then(pull(1)).then(recv(1)).then(finish(1))           // m1 = 2
        .then(start(2)).then(pull(2)).then(recv(2)).then(finish(2))           // m2 = 4、床 5
        .then(xAnswer(K1, false, S0)).then(xNotOwner).then(xTooOld(K2, false))
        .then(confirmK1).then(confirmK2(S2)).then(askStep)                   // S1 は変更なし。S0 には尋ねない
        .expect(x.chain == C_DONE)
        .then(confirmK2(S2))
        .expect(x.T == 5)
        .then(xAnswer(K2, false, S2))
        .expect(x.seen.get(K2) == Set(0, W))
        .then(xAnswer(K2, true, S2)).then(xPrepare).then(xPrepareP)
        .expect(x.st == COMMITTED and not(serializable))
}

// 赤: 受け取りの記録を、受け取りを終えたら忘れる (メモリの受け取り中の範囲 this.incoming だけを引く)。S1 は、移動 2 を始める前に
// 移動 1 を終えているので、尋ねられたときにはもう S0 を知らない
module m23b_red_forget {
  import m23b_core(FOLLOW = true, KEEP = false, BY_TIME = true, MID_FROM_ARRIVAL = false, MID_REFUSES = true, SKIP_PUSH = false,
                   MOVES_N = 2, BACK = false, SCAN2 = true, WRITE = true, PESSIMISTIC = false, OTHER = true, HAS_W = true, HAS_Y = false,
                   TICKS = 0, T_MAX = 5).*
  run counterexampleTest =
    init.then(xBegin)
        .then(xAnswer(K1, false, S0)).then(xAnswer(K2, false, S0))         // T = 0
        .then(wWrite(S0))                                                    // c = 1
        .then(start(1)).then(pull(1)).then(recv(1)).then(finish(1))           // S1 は S0 から受け取ったことを忘れる
        .then(start(2)).then(pull(2)).then(recv(2))                          // m2 = 4。S2 はまだ受け取り中で、S1 を覚えている
        .then(xAnswer(K1, false, S0)).then(xNotOwner).then(xTooOld(K2, false))
        .then(confirmK1).then(confirmK2(S2))
        .expect(x.ask == S1)
        .then(askStep)                                                       // S1 は変更なし。S0 には尋ねない
        .expect(x.chain == C_DONE)
        .then(confirmK2(S2)).then(xAnswer(K2, false, S2))
        .expect(x.seen.get(K2) == Set(0, W))
        .then(xAnswer(K2, true, S2)).then(xPrepare).then(xPrepareP)
        .expect(x.st == COMMITTED and not(serializable))
}

// 赤: 尋ねられたシャードが、自分の記録を、自分の到着の m から確かめる。pull に乗った intent が、m 以下の c で S1 で適用された
// 書き込みを見落とす (M23 の m23_red_child_from_arrival を、尋ねられた側で)
module m23b_red_mid_from_arrival {
  import m23b_core(FOLLOW = true, KEEP = true, BY_TIME = true, MID_FROM_ARRIVAL = true, MID_REFUSES = true, SKIP_PUSH = false,
                   MOVES_N = 2, BACK = false, SCAN2 = true, WRITE = true, PESSIMISTIC = false, OTHER = true, HAS_W = false, HAS_Y = true,
                   TICKS = 0, T_MAX = 5).*
  run counterexampleTest =
    init.then(xBegin)
        .then(xAnswer(K1, false, S0)).then(xAnswer(K2, false, S0))         // T = 0
        .then(yPrepare(S0))                                                  // Y の intent (pts 1) を S0 に置く
        .then(start(1)).then(pull(1)).then(recv(1))                          // m1 = 2。intent は S1 へ
        .then(yDecide(1)).then(yPhase2)                                      // Y は c = 1 < m1 で、S1 で適用される
        .expect(log.get(S1).get(K2) == Set({ ver: 1, writer: Y }))
        .then(finish(1)).then(start(2)).then(pull(2)).then(recv(2)).then(finish(2))
        .then(xAnswer(K1, false, S0)).then(xNotOwner).then(xTooOld(K2, false))
        .then(confirmK1).then(confirmK2(S2))
        .then(askStep)                                                       // S1 は (2, 4] だけを見る
        .then(askStep)                                                       // S0 の (0, 2] に Y はない
        .then(confirmK2(S2)).then(xAnswer(K2, false, S2))
        .expect(x.seen.get(K2) == Set(0, Y))
        .then(xAnswer(K2, true, S2)).then(xPrepare).then(xPrepareP)
        .expect(x.st == COMMITTED and not(serializable))
}

// 赤: 移動 2 で渡した S1 が、範囲表の古い Worker からの確かめに、自分の記録と前の持ち主で答える。S2 の記録を見ない
// (M23 の m23_red_parent_alone を、2 回目の移動で)
module m23b_red_mid_alone {
  import m23b_core(FOLLOW = true, KEEP = true, BY_TIME = true, MID_FROM_ARRIVAL = false, MID_REFUSES = false, SKIP_PUSH = false,
                   MOVES_N = 2, BACK = false, SCAN2 = true, WRITE = true, PESSIMISTIC = false, OTHER = true, HAS_W = true, HAS_Y = false,
                   TICKS = 0, T_MAX = 5).*
  run counterexampleTest =
    init.then(xBegin)
        .then(xAnswer(K1, false, S0)).then(xAnswer(K2, false, S0))         // T = 0
        .then(start(1)).then(pull(1)).then(recv(1)).then(finish(1))           // m1 = 1、床 2
        .then(xAnswer(K1, false, S0)).then(xNotOwner).then(xTooOld(K2, false))
        .then(confirmK1).then(confirmK2(S1)).then(askStep).then(confirmK2(S1))
        .then(xAnswer(K2, false, S1))                                        // T = 2。範囲表は epoch 1
        .then(start(2)).then(pull(2)).then(recv(2))                          // m2 = 3
        .then(wWrite(S2))                                                    // S2 が K2 を c = 4 で確定する
        .then(xOther(5))                                                     // 範囲表の古い X が、T を 5 へ進める
        .expect(x.rRem == Set((K1, S0), (K2, S1)))
        .then(confirmK1).then(confirmK2(S1))                                 // S1 は、自分の記録に変更がないので通す
        .expect(x.T == 5)
        .then(xNotOwner).then(xAnswer(K2, true, S2))                         // S2 で読み直すと、W の値
        .expect(x.seen.get(K2) == Set(0, W))
        .then(xPrepare).then(xPrepareP)
        .expect(x.st == COMMITTED and not(serializable))
}

// 赤: いまの持ち主の確かめが、c の決まっていない Y の intent を push せずに通す。Y の anchor (モデルでは任意の c を選ぶ。3 つ目の
// シャードの anchor にあたる) が、to 以下の c を決める。M1b の 2 シャードでは、後で決まる c が必ず to より大きいので、この赤は出ない
module m23b_red_skip_push {
  import m23b_core(FOLLOW = true, KEEP = true, BY_TIME = true, MID_FROM_ARRIVAL = false, MID_REFUSES = true, SKIP_PUSH = true,
                   MOVES_N = 2, BACK = false, SCAN2 = true, WRITE = true, PESSIMISTIC = false, OTHER = true, HAS_W = false, HAS_Y = true,
                   TICKS = 0, T_MAX = 5).*
  run counterexampleTest =
    init.then(xBegin)
        .then(xAnswer(K1, false, S0)).then(xAnswer(K2, false, S0))         // T = 0
        .then(start(1)).then(pull(1)).then(recv(1)).then(finish(1))
        .then(start(2)).then(pull(2)).then(recv(2)).then(finish(2))           // S2 の時計 4
        .then(yPrepare(S2))                                                  // Y の intent (pts 5)。c はまだ決まっていない
        .then(xAnswer(K1, false, S0)).then(xNotOwner)
        .then(xOther(5))                                                     // ほかのシャードの ReadTooOld で、to = 5
        .then(confirmK1).then(confirmK2(S2)).then(askStep).then(askStep).then(confirmK2(S2))
        .expect(x.T == 5 and y.pushed == 0)                                  // Y を push していない
        .then(yDecide(5)).then(yPhase2)                                      // c = 5 <= to
        .then(xAnswer(K2, false, S2))
        .expect(x.seen.get(K2) == Set(0, Y))
        .then(xAnswer(K2, true, S2)).then(xPrepare).then(xPrepareP)
        .expect(x.st == COMMITTED and not(serializable))
}

// 活性の赤: 範囲が S0 へ戻り、尋ねられたシャードが、窓の上端より後に受け取った記録もたどる。S0 と S1 が互いに尋ね合い、終わらない
module m23b_live_red_cycle {
  import m23b_core(FOLLOW = true, KEEP = true, BY_TIME = false, MID_FROM_ARRIVAL = false, MID_REFUSES = true, SKIP_PUSH = false,
                   MOVES_N = 2, BACK = true, SCAN2 = true, WRITE = false, PESSIMISTIC = false, OTHER = true, HAS_W = false, HAS_Y = true,
                   TICKS = 0, T_MAX = 4).*
  run counterexampleTest =
    init.then(xBegin)
        .then(xAnswer(K1, false, S0)).then(xAnswer(K2, false, S0))
        .then(start(1)).then(pull(1)).then(recv(1)).then(finish(1))           // m1 = 1
        .then(start(2)).then(pull(2)).then(recv(2)).then(finish(2))           // m2 = 3
        .then(xAnswer(K1, false, S0)).then(xTooOld(K2, false))
        .then(confirmK1).then(confirmK2(S0))                                 // S0 は S1 に (0, 3] を尋ねる
        .then(askStep)                                                       // S1 は S0 に (0, 1] を尋ねる
        .then(askStep)                                                       // S0 は、m2 = 3 の記録をたどって、S1 に (0, 3] を尋ねる
        .expect(x.ask == S1 and x.up == 3 and not(boundedAsks))
        .then(askStep).then(askStep)
        .expect(x.ask == S1 and x.up == 3 and x.chain == C_ASK)
}

// ---- 移動 1 回 (M23 の推奨の組み合わせと同じ規則) ---------------------------------------------------------------------
// 新しい core が、移動 1 回では M23 と同じ答えを出すことの確かめ (受け取りを終えると記録を忘れる実装は、移動 1 回でも破れる)
module m23b_red_forget_one {
  import m23b_core(FOLLOW = true, KEEP = false, BY_TIME = true, MID_FROM_ARRIVAL = false, MID_REFUSES = true, SKIP_PUSH = false,
                   MOVES_N = 1, BACK = false, SCAN2 = true, WRITE = true, PESSIMISTIC = false, OTHER = true, HAS_W = true, HAS_Y = true,
                   TICKS = 0, T_MAX = 5).*
}
module m23b_green_one {
  import m23b_core(FOLLOW = true, KEEP = true, BY_TIME = true, MID_FROM_ARRIVAL = false, MID_REFUSES = true, SKIP_PUSH = false,
                   MOVES_N = 1, BACK = false, SCAN2 = true, WRITE = true, PESSIMISTIC = false, OTHER = true, HAS_W = true, HAS_Y = true,
                   TICKS = 1, T_MAX = 5).*
}
