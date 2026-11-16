// M23c: 範囲の移動をまたぐ取引の古い読み。読み取り時刻のまま、前の持ち主の記録で答える (未解決の問題 37 の続き、案 A' の残る失敗)
//
// 2026-11-16 に書いた。実装より先に書いたモデルで、対応する実装はまだない。設計は docs/design-refresh-across-move.md の「古い読み」
// にある。
//
// M23 と M23b では、移動の前の読み取り時刻 T で、動いた範囲を移動の後に読む文を、子が ReadTooOld で断り、Worker が refresh で T を
// 到着の m か床まで進める。窓 (T, m か床] に、読んだ行の別の接続の確定があると、refresh が通らず、読むだけの取引も競合で失敗する
// (案 A' の残る失敗)。SQLite では、移動がなくても、ほかの接続が書いただけで、読むだけの取引は失敗しない。ここでは、その読みに
// T のまま答える。
//
// 規則 (古い読み)。
//   持ち主 d は、グループの閾値 (到着の m。行がなく運ばれなかったグループは範囲の床) より小さい T の K2 の読みを、受け取りの記録の
//   渡した側 (前の持ち主) に、窓の上端 up = その時刻で尋ねる。尋ねられたシャードは、自分の記録で答え、自分の受け取りの記録のうち
//   up より前のものを時刻で選んで、T がその時刻より小さければ、さらに尋ねる (M23b の尋ね方と同じ)。
//   答えは版の集まりで、尋ねた側は、自分の記録の T 以下の版を重ねる。重ねる版は、pull に乗った intent を m より小さい c で適用した
//   ものである。前の持ち主はこれを知らない (「受け取る前に、子の書き込みはない」は、確定の時刻では成り立たない)。いちばん新しい版が
//   答えである。尋ねる列の終わりのシャードは、自分の行 (受け取った行か、最初からの行) を土台にする。
//   intent は、持ち主 d だけが、今の読みと同じ規則で扱う (c が決まっていなければ T より上へ push し、c が決まって T 以下なら適用を
//   待つ)。前の持ち主は intent を見ない (グループの intent は pull で持ち主へ運ばれ、phase 2 も持ち主へ届く)。
//   前の持ち主は、Worker からの、渡した範囲の要求を、今と同じく NotOwner で断る。答えるのは、移動の epoch を運ぶ、持ち主からの
//   尋ねだけである (epoch の確かめ)。
//   保持。渡したシャードは、渡した行を、自分の logLowWater が手放した時刻以上になるまで残す。受け取ったシャードは、受け取りの
//   記録を、自分の logLowWater が受け取った時刻以上になるまで残す。どのシャードも、T (確かめでは下限 lo) が自分の logLowWater より
//   小さい要求を「古すぎる」で断る (read too old。移動がなくても同じに起きる。資源の限り)。logLowWater は、時計から保持の幅 R を
//   引いた値までしか上がらない (実装では LOG_RETAIN_MS)。
// 前の持ち主の記録は、pull の後は変わらない (parentFrozen) ので、尋ねる列の答えは 1 手で作る。手の間に logLowWater が上がる順序は、
// 各シャードが、logLowWater との比べと、自分の記録の読みを、同じ同期区間で行えば、1 手の答えのどれかと同じになる (前提として置く)。
//
// 舞台と書き手と移動は M23b と同じである。シャード S0、S1、S2。行 K1 は S0 に残り、行 K2 のグループが S0 から S1 へ (移動 1)、
// S1 から S2 へ (移動 2。BACK なら S0 へ戻る) 移る。移動は start、pull、recv、finish の 4 手で、移動 2 は移動 1 を終えた後でだけ
// 始まる。EMPTY なら、W の書き込みは行を消す。fence の後に K2 に行も intent もなければ、そのグループは pull されず、finish で子が
// 到着なしで受け持つ (M5b の finishRange)。子の窓の始まりは範囲の床である。
// 読みの土台の版は、時刻を持たない (版の時刻を -1 にする)。子は、受け取った行より前へは時間をさかのぼれないので、受け取った行を
// そのまま答える。最初からの行 (版 0) も S0 の土台に置く。
// M23b の確かめ (read refresh と確定の検証。受け取りの記録をたどって前の持ち主に尋ねる) は、M23b の緑の条件に固定した
// (尋ね続ける、記録を時刻で選ぶ、尋ねられた側も lo から見る、移動 2 で渡した S1 も断る、intent を push する)。赤は M23b にある。
// 確かめも、窓の下限 lo を logLowWater と比べて断る。
//
// invariant
//   serializable          確定した X の読みは、確定の点の値と一致する (M23 と同じ)
//   readConsistent        シャードが答えた読みは、その時刻の真の値と一致する
//   placementIndependent  X が失敗するのは、読んだ行が読んだ後に別の取引に書かれたとき、書く X が読んだ行に別の取引の intent が
//                         あったとき、読み取り時刻か窓の下限が logLowWater より古かったときだけである (移動がなくても同じに起きる)
//   roNeverFails          読むだけの X が失敗するのは、logLowWater より古いときだけである (移動では失敗しない)
//   boundedRefusals       X が移動を理由に断られる回数は、移動の数以下である
//   boundedAsks           1 回の確かめが前の持ち主に尋ねる回数は、移動の数以下である
//   boundedHops           1 回の読みが前の持ち主に尋ねる回数は、移動の数以下である
//   parentFrozen          K2 を渡したシャードは、受け取り直すまで K2 の書き込みを適用しない
// temporal
//   txnEnds               X は、いつか確定するか失敗する (読みが待ち続けない)。refresh と尋ねる列も、いつか終わる
module m23c_core {
  // ---- 古い読みの規則の条件。赤は 1 つずつ外す ----
  const OLD_READS: bool         // 古い T の読みに、持ち主が前の持ち主の記録で答える (false: M23b のまま。子は ReadTooOld で断る)
  const FWD: bool               // 持ち主は、閾値より小さい T の読みを、前の持ち主に尋ねる (false: 自分の状態で答える)
  const MERGE: bool             // 尋ねた側は、自分の記録の T 以下の版を、前の持ち主の答えに重ねる (false: 前の持ち主の答えをそのまま使う)
  const SPLIT_FLOOR: bool       // 閾値は、到着の m と範囲の床の大きい方 (false: 到着の m。行がなく運ばれなかったグループは床)
  const EMPTY_FLOOR: bool       // 運ばれなかったグループの窓の始まりを、範囲の床として記録に残す (false: 到着の記録 __arrived だけを引く)
  const PREV_ANSWERS: bool      // 赤: 渡したシャードが、範囲表の古い Worker の、手放した時刻より前の T の読みに、残した記録で答える
  const WORKER_ROUTES: bool     // 赤: Worker が、古い T の読みを前の持ち主へ直接送る。持ち主は重ねず、intent も扱わない
  const RETAIN: bool            // 渡したシャードは、渡した行を、logLowWater が手放した時刻以上になるまで残す (false: 移動を終えたら消す)
  // ---- 場面 ----
  const MOVES_N: int            // 移動の数 (1 か 2)
  const BACK: bool              // 移動 2 の行き先は S0
  const EMPTY: bool             // W の書き込みは、K2 の行を消す
  const SCAN2: bool             // X は全表をもう 1 回読む
  const WRITE: bool             // X は K2 を書く
  const PESSIMISTIC: bool       // X の書き込みは悲観
  const OTHER: bool             // X は、ほかのシャードの ReadTooOld で、任意の to への refresh を始める
  const HAS_W: bool
  const HAS_Y: bool
  const TICKS: int
  const T_MAX: int
  const GCS: int                // 変更ログを切り詰める (logLowWater を上げる) 回数の上限
  const R: int                  // 保持の幅。logLowWater は、時計 - R までしか上がらない

  pure val S0 = 1
  pure val S1 = 2
  pure val S2 = 3
  pure val SHARDS = Set(1, 2, 3)
  pure val K1 = 1
  pure val K2 = 2
  pure val KEYS = Set(1, 2)
  pure val X = 10
  pure val W = 11
  pure val Y = 12
  pure val INF = 1000
  pure val MOVES = Set(1, 2)
  pure def src(i: int): int = if (i == 1) S0 else S1
  pure def dst(i: int): int = if (i == 1) S1 else if (BACK) S0 else S2
  pure val IDLE = 0
  pure val ACTIVE = 1
  pure val PREPARED = 2
  pure val COMMITTED = 3
  pure val ABORTED = 4
  pure val PC_SCAN1 = 0
  pure val PC_SCAN2 = 1
  pure val PC_WRITE = 2
  pure val PC_COMMIT = 3
  pure val C_NONE = 0
  pure val C_ASK = 1
  pure val C_DONE = 2

  type Ver = { ver: int, writer: int }
  type Intent = { where: int, pts: int, c: int, pushed: int }      // where: 0 なし、1..3 シャード、4 適用済み
  type Move = { moved: int, flying: bool, carry: bool, img: Ver, arrived: int, floor: int }
  type Txn = {
    st: int, pc: int, done: Set[int], T: int, ep: int,
    lo: int -> int, seen: int -> Set[int], at: Set[int],
    rTo: int, rRem: Set[(int, int)], rFatal: bool,
    ask: int, up: int, chain: int, asks: int,
    wrote: bool, wAt: int, ptsC: int, c: int, applied: bool
  }
  type Ghost = {
    whyChange: bool,              // X が失敗したとき、読んだ行に、読んだ後の別の取引の確定があった
    whyIntent: bool,              // X が失敗したとき、K2 に別の取引の intent があった
    whyTooOld: bool,              // X が、logLowWater より古い読みか窓で断られた
    prevOld: bool,                // その「古すぎる」は、前の持ち主の logLowWater による
    adv: bool,                    // refresh が T を進めた
    oldRead: bool,                // 持ち主が、閾値より小さい T の読みを、前の持ち主に尋ねて答えた
    hops: int,                    // 1 回の読みが前の持ち主に尋ねた数の最大
    overlay: bool,                // 尋ねて答えた読みの答えが、持ち主が重ねた自分の版 (受け取る前の c で適用した intent) だった
    refusals: int, maxAsks: int, badRead: bool, frozenBroken: bool, wAt: int, wC: int
  }
  type Chain = { vs: Set[Ver], hops: int, old: bool, prevOld: bool }

  var hlc: int -> int
  var log: int -> (int -> Set[Ver])
  var meta: int
  var mv: int -> Move
  var y: Intent
  var wDone: bool
  var ticks: int
  var low: int -> int             // シャードの logLowWater
  var gcs: int
  var drop: int -> bool           // 移動 i で渡したシャードが、渡した行を消した
  var x: Txn
  var g: Ghost

  pure def max(a: int, b: int): int = if (a > b) a else b
  pure def min(a: int, b: int): int = if (a < b) a else b
  pure def latest(vs: Set[Ver]): Ver = vs.fold({ ver: -2, writer: -1 }, (acc, v) => if (v.ver > acc.ver) v else acc)
  pure def valueAt(vs: Set[Ver], t: int): int = latest(vs.filter(v => v.ver <= t)).writer
  pure val init0: Ver = { ver: 0, writer: 0 }
  pure val noMove: Move = { moved: 0, flying: false, carry: false, img: { ver: -2, writer: -1 }, arrived: 0, floor: 0 }

  pure val idleTxn: Txn = {
    st: IDLE, pc: PC_SCAN1, done: Set(), T: 0, ep: 0,
    lo: KEYS.mapBy(_ => -1), seen: KEYS.mapBy(_ => Set()), at: Set(),
    rTo: 0, rRem: Set(), rFatal: false, ask: 0, up: 0, chain: C_NONE, asks: 0,
    wrote: false, wAt: 0, ptsC: 0, c: 0, applied: false
  }

  action init = all {
    hlc' = SHARDS.mapBy(_ => 0),
    // K2 の最初の行 (版 0) は S0 の土台 (baseOf) に置き、記録には入れない
    log' = Map(S0 -> Map(K1 -> Set(init0), K2 -> Set()), S1 -> KEYS.mapBy(_ => Set()), S2 -> KEYS.mapBy(_ => Set())),
    meta' = 0,
    mv' = MOVES.mapBy(_ => noMove),
    y' = { where: 0, pts: 0, c: 0, pushed: 0 },
    wDone' = not(HAS_W),
    ticks' = 0,
    low' = SHARDS.mapBy(_ => 0),
    gcs' = 0,
    drop' = MOVES.mapBy(_ => false),
    x' = idleTxn,
    g' = { whyChange: false, whyIntent: false, whyTooOld: false, prevOld: false, adv: false, oldRead: false, hops: 0,
           overlay: false, refusals: 0, maxAsks: 0, badRead: false, frozenBroken: false, wAt: 0, wC: 0 }
  }
  action keepRet = all { low' = low, gcs' = gcs, drop' = drop }
  action keepWorld = all { hlc' = hlc, log' = log, meta' = meta, mv' = mv, y' = y, wDone' = wDone, ticks' = ticks, keepRet }

  // ---- 移動の記録 ------------------------------------------------------------------
  def m1: Move = mv.get(1)
  def m2: Move = mv.get(2)
  // 移動 i で、受け取った側が範囲を受け持ち始めた時刻 (到着の m。運ばれなかったグループは範囲の床)。受け持っていなければ 0
  def recTime(i: int): int =
    if (i == 0) 0
    else if (mv.get(i).arrived > 0) mv.get(i).arrived
    else if (mv.get(i).moved == 0 and mv.get(i).floor > 0) mv.get(i).floor
    else 0
  def got(i: int): bool = recTime(i) > 0
  // 受け取った側が記録に残す、窓の始まり。EMPTY_FLOOR でなければ、運ばれなかったグループには残さない
  def arr(i: int): int = if (i == 0) 0 else if (mv.get(i).arrived > 0) mv.get(i).arrived else if (EMPTY_FLOOR) recTime(i) else 0
  // 渡した側が手放した時刻 (pull の m。運ばれなかったグループは範囲の床)
  def handTime(i: int): int = if (i == 0) 0 else if (mv.get(i).moved > 0) mv.get(i).moved else mv.get(i).floor
  // d は、いま K2 の持ち主で、グループを受け持っている
  def holds(d: int): bool =
    (d == S0 and meta == 0) or (d == S1 and got(1) and meta < 2) or (d == dst(2) and got(2))
  // d は、K2 を渡した (Worker からの K2 の要求を NotOwner で断る)。fence (start) の後から断る
  def handedOff(d: int): bool = (d == S0 and meta >= 1 and not(dst(2) == S0 and meta >= 2)) or (d == S1 and meta >= 2)
  // M23b の、到着の m と床の大きい方 (OLD_READS でないときの、読みに答えるいちばん小さい T)
  def startAt(d: int): int =
    if (d == dst(2) and got(2)) max(m2.arrived, m2.floor)
    else if (d == S1) max(m1.arrived, m1.floor)
    else 0
  // d の受け取りの記録のうち、時刻 up より前に受け持ち始めた、いちばん新しいもの (なければ 0)
  def recBefore(d: int, up: int): int =
    MOVES.filter(i => dst(i) == d and recTime(i) > 0 and recTime(i) < up)
         .fold(0, (acc, i) => if (acc == 0) i else if (recTime(i) > recTime(acc)) i else acc)
  // 受け取りの記録は、受け取ったシャードの logLowWater が受け持ち始めた時刻以上になると消してよい (消したものとして扱う)
  def knows(i: int): bool = low.get(dst(i)) < recTime(i)
  // d が持つ K2 の土台の版 (受け取った行。S0 の最初の行)。時刻は元の版のもの
  def realBase(d: int): Set[Ver] =
    val i = recBefore(d, INF)
    if (i == 0) (if (d == S0) Set(init0) else Set()) else Set(mv.get(i).img)
  def histAt(d: int, k: int): Set[Ver] = if (k == K1) log.get(S0).get(K1) else log.get(d).get(K2).union(realBase(d))
  def holder: int = if (m2.moved > 0 or got(2)) dst(2) else if (m1.moved > 0 or got(1)) S1 else S0
  def holderReady: bool = if (m2.moved > 0 or got(2)) got(2) else if (m1.moved > 0 or got(1)) got(1) else true
  // d は K2 を渡し、まだ受け取り直していない
  def pulledOut(d: int): bool =
    (d == S0 and handTime(1) > 0 and not(dst(2) == S0 and got(2))) or (d == S1 and handTime(2) > 0)
  def yOpen: bool = y.where >= 1 and y.where <= 3
  def yAt(d: int): bool = y.where == d
  def allWrites(k: int): Set[Ver] =
    log.get(S0).get(k).union(log.get(S1).get(k)).union(log.get(S2).get(k))
      .union(if (k == K2) Set(init0) else Set())
      .union(if (k == K2 and yOpen and y.c > 0) Set({ ver: y.c, writer: Y }) else Set())
  def changedIn(d: int, k: int, from: int, hi: int): bool =
    log.get(d).get(k).exists(v => v.ver > from and v.ver <= hi and v.writer != X)
  def xIntentOpen: bool = x.st == PREPARED or (x.st == COMMITTED and x.ptsC > 0 and not(x.applied))
  def xIntentAt(d: int): bool = xIntentOpen and d == holder
  // K2 に行も intent もない (EMPTY のとき、W の削除が最新)。fence の後なら、そのグループは pull されない
  def emptyAt(s: int): bool = EMPTY and latest(histAt(s, K2)).writer == W and not(yAt(s)) and not(xIntentAt(s))
  def ownerAt(e: int): int = if (e == 0) S0 else if (e == 1) S1 else dst(2)
  def route(k: int): int = if (k == K1) S0 else ownerAt(x.ep)
  def yBlocks(d: int, t: int): bool = yAt(d) and y.c > 0 and y.c <= t
  def pushedTo(d: int, t: int): Intent = if (yAt(d) and y.c == 0 and y.pts <= t) y.with("pushed", max(y.pushed, t)) else y
  def yWaits(d: int, upTo: int): bool = yAt(d) and y.c > 0 and y.c <= upTo

  // ---- 古い読み: 前の持ち主に尋ねる列 -----------------------------------------------------
  // 閾値。SPLIT_FLOOR なら、到着の m と範囲の床の大きい方
  def split(i: int): int = if (SPLIT_FLOOR) max(arr(i), mv.get(i).floor) else arr(i)
  // シャード s (窓の上端 up) は、T の読みを、さらに前の持ち主に尋ねるか
  def below(s: int, up: int, t: int): bool =
    val i = recBefore(s, up)
    i != 0 and knows(i) and t < split(i)
  // s の記録の、窓 (.., up) の T 以下の版
  def ownLE(s: int, up: int, t: int): Set[Ver] = log.get(s).get(K2).filter(v => v.ver <= t and v.ver < up)
  // s が、窓 (.., up) について残している行。up が INF (いまの持ち主) なら残っている
  def kept(s: int, up: int): bool = up >= INF or MOVES.forall(j => not(src(j) == s and handTime(j) == up and drop.get(j)))
  // 尋ねる列の終わりのシャードの土台。時刻を持たない (行より前へはさかのぼれないので、そのまま答える)
  def baseAt(s: int, up: int): Set[Ver] =
    val i = recBefore(s, up)
    if (not(kept(s, up))) Set()
    else if (i == 0) (if (s == S0) Set({ ver: -1, writer: 0 }) else Set())
    else Set({ ver: -1, writer: mv.get(i).img.writer })
  // 尋ねた側が重ねる、自分の記録の版
  def overlayOf(s: int, up: int, t: int): Set[Ver] = if (MERGE and not(WORKER_ROUTES)) ownLE(s, up, t) else Set()
  // s0 (窓の上端 u0) から始まる尋ねる列で、T の読みの答えになる版の集まり。尋ねる列は M23b と同じく、移動の数で終わるので、3 段で切る
  // (3 段目の尋ねが要るなら hops = 3 になり、boundedHops が破れる)
  def chainFrom(s0: int, u0: int, t: int, fwd: bool): Chain =
    val i0 = recBefore(s0, u0)
    val n0 = fwd and below(s0, u0, t)
    val s1 = src(i0)
    val u1 = recTime(i0)
    val n1 = n0 and below(s1, u1, t)
    val i1 = recBefore(s1, u1)
    val s2 = src(i1)
    val u2 = recTime(i1)
    val n2 = n1 and below(s2, u2, t)
    val v2 = if (n2) Set() else ownLE(s2, u2, t).union(baseAt(s2, u2))
    val v1 = if (n1) overlayOf(s1, u1, t).union(v2) else ownLE(s1, u1, t).union(baseAt(s1, u1))
    val v0 = if (n0) overlayOf(s0, u0, t).union(v1) else ownLE(s0, u0, t).union(baseAt(s0, u0))
    val pOld = (n0 and t < low.get(s1)) or (n1 and t < low.get(s2))
    { vs: v0, hops: (if (n0) 1 else 0) + (if (n1) 1 else 0) + (if (n2) 1 else 0), old: t < low.get(s0) or pOld, prevOld: pOld }

  // ---- 確かめ: 前の持ち主に尋ねる規則 (M23b の緑) ----------------------------------------------
  def nextAsk(d: int, up: int, lo: int): (int, int) =
    val i = recBefore(d, up)
    if (i == 0) (0, 0)
    else if (knows(i) and lo < arr(i)) (src(i), recTime(i))
    else (0, 0)
  pure def noChain(t: Txn): Txn = t.with("ask", 0).with("up", 0).with("chain", C_NONE).with("asks", 0)
  def startChain(nx: (int, int)): Txn = x.with("chain", C_ASK).with("ask", nx._1).with("up", nx._2).with("asks", 1)

  def changeNow: bool = KEYS.exists(k => x.lo.get(k) >= 0 and allWrites(k).exists(v => v.writer != X and v.ver > x.lo.get(k)))
  def intentNow: bool = x.lo.get(K2) >= 0 and yOpen
  def noted: Ghost = g.with("whyChange", g.whyChange or changeNow).with("whyIntent", g.whyIntent or intentNow)
  def tooOldG: Ghost = g.with("whyTooOld", true)
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

  // 持ち主の答えた K2 の読みの記録
  def readGhost(v: int, ch: Chain, d: int): Ghost =
    g.with("badRead", g.badRead or v != valueAt(allWrites(K2), x.T))
     .with("oldRead", g.oldRead or ch.hops > 0)
     .with("hops", max(g.hops, ch.hops))
     .with("overlay", g.overlay or (ch.hops > 0 and log.get(d).get(K2).contains(latest(ch.vs))))

  // K1 は S0 が答える。K2 は持ち主が答え、閾値より小さい T なら前の持ち主に尋ねて、自分の版を重ねる。
  // OLD_READS でなければ、M23b のとおり、到着の m と床の両方以上の T にだけ答える
  action xAnswer(k: int, w: bool, d: int): bool = all {
    inStatement(k, w),
    route(k) == d,
    if (k == K1) all {
      x.T >= low.get(S0),
      val v = valueAt(log.get(S0).get(K1), x.T)
      all {
        x' = afterRead(K1, w, S0, v),
        hlc' = hlc.set(S0, max(hlc.get(S0), x.T)),
        g' = g.with("badRead", g.badRead or v != valueAt(allWrites(K1), x.T)),
        log' = log, meta' = meta, mv' = mv, y' = y, wDone' = wDone, ticks' = ticks, keepRet
      }
    } else all {
      holds(d),
      OLD_READS or x.T >= startAt(d),
      val ch = chainFrom(d, INF, x.T, OLD_READS and FWD)
      // WORKER_ROUTES: Worker が前の持ち主へ直接送る。持ち主は答えに加わらない
      val routed = WORKER_ROUTES and ch.hops > 0
      all {
        not(ch.old),
        routed or not(yBlocks(d, x.T)),
        val v = latest(ch.vs).writer
        all {
          x' = afterRead(K2, w, d, v),
          hlc' = hlc.set(d, max(hlc.get(d), x.T)),
          y' = if (routed) y else pushedTo(d, x.T),
          g' = readGhost(v, ch, d),
          log' = log, meta' = meta, mv' = mv, wDone' = wDone, ticks' = ticks, keepRet
        }
      }
    }
  }

  // 読み取り時刻が、答えに要るシャードの logLowWater より古い。read too old で、取引は失敗する
  action xReadTooOld(k: int, w: bool): bool = all {
    inStatement(k, w),
    if (k == K1) all { x.T < low.get(S0), x' = x.with("st", ABORTED), g' = tooOldG, keepWorld }
    else all {
      holds(route(K2)),
      OLD_READS or x.T >= startAt(route(K2)),
      val ch = chainFrom(route(K2), INF, x.T, OLD_READS and FWD)
      all { ch.old, x' = x.with("st", ABORTED), g' = tooOldG.with("prevOld", g.prevOld or ch.prevOld), keepWorld }
    }
  }

  // 赤 (PREV_ANSWERS): K2 を渡したシャード d が、範囲表の古い Worker の読みに、手放した時刻より前の T なら、残した記録で答える
  def handOf(d: int): int =
    MOVES.filter(i => src(i) == d and handTime(i) > 0).fold(0, (acc, i) => if (acc == 0 or handTime(i) > handTime(acc)) i else acc)
  action xAnswerPrev(w: bool, d: int): bool = all {
    PREV_ANSWERS, inStatement(K2, w), route(K2) == d, handedOff(d),
    val j = handOf(d)
    all {
      j != 0, x.T < handTime(j),
      val ch = chainFrom(d, handTime(j), x.T, true)
      all {
        not(ch.old),
        val v = latest(ch.vs).writer
        all {
          x' = afterRead(K2, w, d, v),
          g' = g.with("badRead", g.badRead or v != valueAt(allWrites(K2), x.T)),
          keepWorld
        }
      }
    }
  }

  // K2 を渡したシャードが、K2 の文を NotOwner で断る (epoch の確かめ)。Worker は Meta から範囲表を取り直す
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

  // OLD_READS でないとき (M23b): 持ち主が、到着の m か床より小さい T の読みを ReadTooOld で断り、Worker が refresh を始める
  action xTooOld(k: int, w: bool): bool = all {
    not(OLD_READS),
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

  // ---- refresh の確かめ (M23b の緑。窓の下限を logLowWater と比べる) -------------------------------
  def lastOne(k: int, d: int): bool = x.rRem.exclude(Set((k, d))) == Set()
  def confirmed(k: int, d: int): Txn =
    val t = if (k == K2) noChain(x) else x
    if (not(lastOne(k, d))) t.with("rRem", x.rRem.exclude(Set((k, d))))
    else t.with("T", x.rTo).with("lo", KEYS.mapBy(j => if (x.lo.get(j) >= 0) x.rTo else -1)).with("rTo", 0).with("rRem", Set())
  def passedGhost(k: int, d: int): Ghost = g.with("adv", g.adv or lastOne(k, d))
  def failed: Txn = noChain(if (x.rFatal) x.with("st", ABORTED) else x).with("rTo", 0).with("rRem", Set())

  action confirmK1 = all {
    x.st == ACTIVE, x.rTo > 0, x.rRem.contains((K1, S0)),
    val old = x.lo.get(K1) < low.get(S0)
    val ok = not(old) and not(changedIn(S0, K1, x.lo.get(K1), x.rTo))
    all {
      x' = if (ok) confirmed(K1, S0) else failed,
      g' = if (ok) passedGhost(K1, S0) else if (old) tooOldG else noted,
      hlc' = hlc.set(S0, max(hlc.get(S0), x.rTo)),
      log' = log, meta' = meta, mv' = mv, y' = y, wDone' = wDone, ticks' = ticks, keepRet
    }
  }

  action confirmK2(d: int): bool = all {
    x.st == ACTIVE, x.rTo > 0, x.rRem.contains((K2, d)),
    if (handedOff(d)) all {
      x' = noChain(x).with("ep", meta).with("rRem", x.rRem.exclude(Set((K2, d))).union(Set((K2, ownerAt(meta))))),
      g' = refused, keepWorld
    } else all {
      holds(d),
      val lo = x.lo.get(K2)
      val nx = nextAsk(d, INF, lo)
      if (x.chain == C_NONE and nx._1 != 0) all {
        x' = startChain(nx), g' = g.with("maxAsks", max(g.maxAsks, 1)), keepWorld
      } else all {
        x.chain != C_ASK,
        not(yWaits(d, x.rTo)),
        val old = lo < low.get(d)
        val ok = not(old) and not(changedIn(d, K2, lo, x.rTo))
        all {
          x' = if (ok) confirmed(K2, d) else failed,
          g' = if (ok) passedGhost(K2, d) else if (old) tooOldG else noted,
          hlc' = hlc.set(d, max(hlc.get(d), x.rTo)),
          y' = if (ok) pushedTo(d, x.rTo) else y,
          log' = log, meta' = meta, mv' = mv, wDone' = wDone, ticks' = ticks, keepRet
        }
      }
    }
  }

  // 前の持ち主 a に (lo, up] を尋ねる 1 手。a は自分の記録だけで答え、受け取りの記録のうち up より前のものをたどって、さらに尋ねる
  action askStep = all {
    x.chain == C_ASK,
    val lo = x.lo.get(K2)
    val a = x.ask
    val hi = if (x.rTo > 0) x.rTo else INF
    val old = lo < low.get(a)
    val changed = changedIn(a, K2, lo, min(x.up, hi))
    val nx = nextAsk(a, x.up, lo)
    if (old or changed) all {
      x' = if (x.rTo > 0) failed else noChain(x).with("st", ABORTED),
      g' = if (old) tooOldG else noted, keepWorld
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
      log' = log, meta' = meta, mv' = mv, wDone' = wDone, ticks' = ticks, keepRet
    }
  }

  // ---- 取引 X: 確定 ---------------------------------------------------------------
  action xFinishRO = all {
    x.st == ACTIVE, x.rTo == 0, x.chain == C_NONE, x.pc == PC_COMMIT, not(x.wrote),
    x' = x.with("st", COMMITTED).with("c", x.T),
    keepWorld, g' = g
  }
  action xCommitLocal = all {
    x.st == ACTIVE, x.rTo == 0, x.chain == C_NONE, x.pc == PC_COMMIT, x.wrote, route(K2) == S0, not(BACK),
    if (handedOff(S0)) all {
      x' = x.with("ep", meta), g' = refused, keepWorld
    } else all {
      holds(S0),
      val old = KEYS.exists(k => x.lo.get(k) >= 0 and x.lo.get(k) < low.get(S0))
      val ok = not(old) and KEYS.forall(k => x.lo.get(k) < 0 or not(changedIn(S0, k, x.lo.get(k), INF))) and not(yAt(S0))
      val c = hlc.get(S0) + 1
      all {
        x' = if (ok) x.with("st", COMMITTED).with("c", c).with("applied", true) else x.with("st", ABORTED),
        hlc' = if (ok) hlc.set(S0, c) else hlc,
        log' = if (ok) log.set(S0, log.get(S0).set(K2, log.get(S0).get(K2).union(Set({ ver: c, writer: X })))) else log,
        g' = if (ok) g else if (old) tooOldG else noted,
        meta' = meta, mv' = mv, y' = y, wDone' = wDone, ticks' = ticks, keepRet
      }
    }
  }
  // K2 の持ち主 (S1 か S2) での prepare。前の持ち主に尋ねてから、自分の記録を lo から確かめる (上限なし)
  action xPrepare = all {
    x.st == ACTIVE, x.rTo == 0, x.pc == PC_COMMIT, x.wrote, route(K2) != S0,
    val d = route(K2)
    if (handedOff(d)) all {
      x' = noChain(x).with("ep", meta), g' = refused, keepWorld
    } else all {
      holds(d),
      val lo = x.lo.get(K2)
      val nx = nextAsk(d, INF, lo)
      if (x.chain == C_NONE and nx._1 != 0) all {
        x' = startChain(nx), g' = g.with("maxAsks", max(g.maxAsks, 1)), keepWorld
      } else all {
        x.chain != C_ASK,
        val old = lo < low.get(d)
        val ok = not(old) and not(changedIn(d, K2, lo, INF)) and not(yAt(d))
        val pts = hlc.get(d) + 1
        all {
          x' = noChain(if (ok) x.with("st", PREPARED).with("ptsC", pts) else x.with("st", ABORTED)),
          hlc' = if (ok) hlc.set(d, pts) else hlc,
          g' = if (ok) g else if (old) tooOldG else noted,
          log' = log, meta' = meta, mv' = mv, y' = y, wDone' = wDone, ticks' = ticks, keepRet
        }
      }
    }
  }
  action xPrepareP = all {
    x.st == PREPARED,
    val lo1 = x.lo.get(K1)
    val old = lo1 >= 0 and lo1 < low.get(S0)
    val ok = not(old) and (lo1 < 0 or not(changedIn(S0, K1, lo1, INF)))
    val c = max(hlc.get(S0), x.ptsC) + 1
    all {
      x' = if (ok) x.with("st", COMMITTED).with("c", c) else x.with("st", ABORTED),
      hlc' = if (ok) hlc.set(S0, c) else hlc,
      g' = if (ok) g else if (old) tooOldG else noted,
      log' = log, meta' = meta, mv' = mv, y' = y, wDone' = wDone, ticks' = ticks, keepRet
    }
  }
  action xApply = all {
    x.st == COMMITTED, x.ptsC > 0, not(x.applied), holderReady,
    val d = holder
    all {
      x' = x.with("applied", true),
      log' = log.set(d, log.get(d).set(K2, log.get(d).get(K2).union(Set({ ver: x.c, writer: X })))),
      hlc' = hlc.set(d, max(hlc.get(d), x.c)),
      g' = g.with("frozenBroken", g.frozenBroken or pulledOut(d)),
      meta' = meta, mv' = mv, y' = y, wDone' = wDone, ticks' = ticks, keepRet
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
      meta' = meta, mv' = mv, y' = y, ticks' = ticks, x' = x, keepRet
    }
  }
  action yPrepare(d: int): bool = all {
    HAS_Y, y.where == 0, holds(d), not(xIntentAt(d)),
    val pts = hlc.get(d) + 1
    all {
      hlc' = hlc.set(d, pts),
      y' = { where: d, pts: pts, c: 0, pushed: 0 },
      log' = log, meta' = meta, mv' = mv, wDone' = wDone, ticks' = ticks, x' = x, g' = g, keepRet
    }
  }
  action yDecide(c: int): bool = all {
    yOpen, y.c == 0, c >= y.pts, c > y.pushed, c <= y.pts + 2,
    y' = y.with("c", c),
    hlc' = hlc, log' = log, meta' = meta, mv' = mv, wDone' = wDone, ticks' = ticks, x' = x, g' = g, keepRet
  }
  action yPhase2 = all {
    yOpen, y.c > 0, holderReady,
    val d = holder
    all {
      log' = log.set(d, log.get(d).set(K2, log.get(d).get(K2).union(Set({ ver: y.c, writer: Y })))),
      hlc' = hlc.set(d, max(hlc.get(d), y.c)),
      y' = y.with("where", 4),
      g' = g.with("frozenBroken", g.frozenBroken or pulledOut(d)),
      meta' = meta, mv' = mv, wDone' = wDone, ticks' = ticks, x' = x, keepRet
    }
  }

  // ---- 移動 ------------------------------------------------------------------------
  action start(i: int): bool = all {
    i <= MOVES_N, meta == i - 1, i == 1 or m1.floor > 0,
    meta' = i,
    hlc' = hlc, log' = log, mv' = mv, y' = y, wDone' = wDone, ticks' = ticks, x' = x, g' = g, keepRet
  }
  // 行か intent のあるグループだけを pull する
  action pull(i: int): bool = all {
    meta >= i, mv.get(i).moved == 0, mv.get(i).floor == 0,
    val s = src(i)
    val m = hlc.get(s) + 1
    all {
      not(emptyAt(s)),
      hlc' = hlc.set(s, m),
      mv' = mv.set(i, mv.get(i).with("moved", m).with("flying", true).with("carry", yAt(s)).with("img", latest(histAt(s, K2)))),
      log' = log, meta' = meta, y' = y, wDone' = wDone, ticks' = ticks, x' = x, g' = g, keepRet
    }
  }
  action recv(i: int): bool = all {
    mv.get(i).flying,
    val d = dst(i)
    all {
      mv' = mv.set(i, mv.get(i).with("flying", false).with("arrived", mv.get(i).moved)),
      hlc' = hlc.set(d, max(hlc.get(d), mv.get(i).moved)),
      y' = if (mv.get(i).carry and y.where == src(i)) y.with("where", d) else y,
      log' = log, meta' = meta, wDone' = wDone, ticks' = ticks, x' = x, g' = g, keepRet
    }
  }
  // 範囲の移動を終える。運ばれなかったグループ (行も intent もない) は、子が床から受け持つ (土台は、渡した側の最新の版、つまり行なし)
  action finish(i: int): bool = all {
    meta >= i, mv.get(i).floor == 0,
    val s = src(i)
    val d = dst(i)
    val emptied = mv.get(i).moved == 0 and emptyAt(s)
    val f = hlc.get(s) + 1
    all {
      mv.get(i).arrived > 0 or emptied,
      hlc' = hlc.set(s, f).set(d, max(hlc.get(d), f)),
      mv' = mv.set(i, mv.get(i).with("floor", f).with("img", if (emptied) latest(histAt(s, K2)) else mv.get(i).img)),
      log' = log, meta' = meta, y' = y, wDone' = wDone, ticks' = ticks, x' = x, g' = g, keepRet
    }
  }
  action tick(d: int): bool = all {
    ticks < TICKS,
    hlc' = hlc.set(d, hlc.get(d) + 1), ticks' = ticks + 1,
    log' = log, meta' = meta, mv' = mv, y' = y, wDone' = wDone, x' = x, g' = g, keepRet
  }

  // ---- 保持 ------------------------------------------------------------------------
  // 変更ログの世代を消し、logLowWater を上げる。時計 - R までしか上げない (実装では min(時計, 今) - LOG_RETAIN_MS)
  action gc(d: int, v: int): bool = all {
    gcs < GCS, low.get(d) < v, v <= hlc.get(d) - R,
    low' = low.set(d, v), gcs' = gcs + 1, drop' = drop,
    hlc' = hlc, log' = log, meta' = meta, mv' = mv, y' = y, wDone' = wDone, ticks' = ticks, x' = x, g' = g
  }
  // 移動 i で渡したシャードが、渡した行を消す。RETAIN なら、logLowWater が手放した時刻以上になってから。そうでなければ、移動を終えたら
  action dropRows(i: int): bool = all {
    not(drop.get(i)), mv.get(i).floor > 0,
    if (RETAIN) low.get(src(i)) >= handTime(i) else true,
    drop' = drop.set(i, true), low' = low, gcs' = gcs,
    hlc' = hlc, log' = log, meta' = meta, mv' = mv, y' = y, wDone' = wDone, ticks' = ticks, x' = x, g' = g
  }

  // X の手 (活性の公平性に使う)
  action xStep = any {
    xBegin,
    xNotOwner,
    { nondet k = oneOf(KEYS) nondet w = oneOf(Set(true, false)) nondet d = oneOf(SHARDS) xAnswer(k, w, d) },
    { nondet w = oneOf(Set(true, false)) nondet d = oneOf(SHARDS) xAnswerPrev(w, d) },
    { nondet k = oneOf(KEYS) nondet w = oneOf(Set(true, false)) xReadTooOld(k, w) },
    { nondet k = oneOf(KEYS) nondet w = oneOf(Set(true, false)) xTooOld(k, w) },
    { nondet upTo = oneOf(1.to(T_MAX)) xOther(upTo) },
    confirmK1,
    { nondet d = oneOf(SHARDS) confirmK2(d) },
    askStep,
    xDml, xFinishRO, xCommitLocal, xPrepare, xPrepareP, xApply
  }

  action step = any {
    xStep,
    { nondet d = oneOf(SHARDS) wWrite(d) },
    { nondet d = oneOf(SHARDS) yPrepare(d) },
    { nondet c = oneOf(1.to(T_MAX + 8)) yDecide(c) },
    yPhase2,
    { nondet i = oneOf(MOVES) any { start(i), pull(i), recv(i), finish(i), dropRows(i) } },
    { nondet d = oneOf(SHARDS) tick(d) },
    { nondet d = oneOf(SHARDS) nondet v = oneOf(1.to(T_MAX)) gc(d, v) }
  }

  // ---- 不変条件 ---------------------------------------------------------------------
  def expected(k: int): int =
    if (x.wrote) latest(allWrites(k).filter(v => v.writer != X and v.ver < x.c)).writer
    else valueAt(allWrites(k), x.T)
  val serializable = x.st != COMMITTED or KEYS.forall(k => x.lo.get(k) < 0 or x.seen.get(k) == Set(expected(k)))
  val readConsistent = not(g.badRead)
  val placementIndependent = x.st != ABORTED or g.whyChange or (WRITE and g.whyIntent) or g.whyTooOld
  val roNeverFails = WRITE or x.st != ABORTED or g.whyTooOld
  val boundedRefusals = g.refusals <= MOVES_N
  val boundedAsks = g.maxAsks <= MOVES_N
  val boundedHops = g.hops <= MOVES_N
  val parentFrozen = not(g.frozenBroken)
  val m23cSafe = serializable and readConsistent and placementIndependent and boundedRefusals and boundedAsks and boundedHops and parentFrozen
  val m23cSafeRO = m23cSafe and roNeverFails

  // ---- witness ----------------------------------------------------------------------
  // 案 A' の形: 読むだけの X が T で読み、W が、動く行を (T, 移動 1 の m] の時刻で S0 に確定する。X は、T を進めずに、移動の後に
  // 動いた行を前の持ち主に尋ねて読み、確定する
  val witnessAPrime = not(x.st == COMMITTED and not(x.wrote) and not(g.adv) and g.oldRead and g.wAt == S0
                          and x.T < g.wC and g.wC <= m1.moved)
  // 2 回の移動をまたいで、前の持ち主 2 つに尋ねた読みがあり、X が確定した
  val witnessForward2 = not(x.st == COMMITTED and g.hops == 2)
  // 尋ねて答えた読みの答えが、持ち主の重ねた版 (pull に乗った intent を、受け取る前の c で適用したもの) で、X が確定した
  val witnessOverlay = not(x.st == COMMITTED and g.overlay)
  // 前の持ち主の logLowWater より古い読みが「古すぎる」で断られ、X が失敗した
  val witnessTooOld = not(x.st == ABORTED and g.prevOld)
  // 書く X が、T を進めずに、2 回の移動の後に動いた行を読み直し、移動 2 の行き先で書いて確定した
  val witnessWriteAcross2 = not(x.st == COMMITTED and x.applied and x.ptsC > 0 and not(g.adv) and g.hops == 2)
  // 運ばれなかった (空にされた) グループを、子が前の持ち主に尋ねて、削除の前の T の行を答え、X が確定した
  val witnessEmptyRead = not(x.st == COMMITTED and g.oldRead and MOVES.exists(i => mv.get(i).moved == 0 and mv.get(i).floor > 0)
                             and x.seen.get(K2) == Set(0) and g.wC > x.T)

  // ---- 活性 -------------------------------------------------------------------------
  val vars = (hlc, log, meta, mv, y, wDone, ticks, low, gcs, drop, x, g)
  temporal fairness = and {
    weakFair(xStep, vars),
    weakFair(pull(1), vars), weakFair(recv(1), vars), weakFair(finish(1), vars),
    weakFair(pull(2), vars), weakFair(recv(2), vars), weakFair(finish(2), vars),
    weakFair(yPhase2, vars)
  }
  temporal txnEnds = fairness implies (eventually(x.st == COMMITTED or x.st == ABORTED)
                                       and always(x.rTo > 0 implies eventually(x.rTo == 0))
                                       and always(x.chain == C_ASK implies eventually(x.chain != C_ASK)))
}

// ---- 規則 (緑) ---------------------------------------------------------------------------------------------------------

// 読むだけの取引 (全表を 2 回読む)。書き手 W。2 回の移動、範囲表の古い Worker の refresh あり
module m23c_green_ro_w {
  import m23c_core(OLD_READS = true, FWD = true, MERGE = true, SPLIT_FLOOR = false, EMPTY_FLOOR = true, PREV_ANSWERS = false,
                   WORKER_ROUTES = false, RETAIN = true,
                   MOVES_N = 2, BACK = false, EMPTY = false, SCAN2 = true, WRITE = false, PESSIMISTIC = false, OTHER = true,
                   HAS_W = true, HAS_Y = false, TICKS = 0, T_MAX = 5, GCS = 0, R = 1).*
  // 案 A' の形。移動 1 の前に、W が動く行を (T, m] で確定する。X は T = 0 のまま、子に読み直し、子は S0 に尋ねて答える
  run aPrimeTest =
    init.then(xBegin)                                                        // T = 0
        .then(xAnswer(K1, false, S0)).then(xAnswer(K2, false, S0))
        .then(wWrite(S0))                                                    // c = 1
        .then(start(1)).then(pull(1)).then(recv(1)).then(finish(1))           // m1 = 2、床 3
        .then(xAnswer(K1, false, S0))
        .then(xNotOwner)                                                     // S0 が K2 を断る。範囲表を取り直す
        .then(xAnswer(K2, false, S1))                                        // T = 0 < 2。S1 は S0 に up = 2 で尋ねる
        .expect(x.seen.get(K2) == Set(0) and g.oldRead and g.hops == 1)
        .then(xFinishRO)
        .expect(x.st == COMMITTED and x.T == 0 and m23cSafeRO and not(witnessAPrime))
  // 2 回の移動の後に、S2 が S1 に、S1 が S0 に尋ねる
  run forward2Test =
    init.then(xBegin)
        .then(xAnswer(K1, false, S0)).then(xAnswer(K2, false, S0))         // T = 0
        .then(start(1)).then(pull(1)).then(recv(1)).then(finish(1))           // m1 = 1、床 2
        .then(wWrite(S1))                                                    // c = 3
        .then(start(2)).then(pull(2)).then(recv(2)).then(finish(2))           // m2 = 4
        .then(xAnswer(K1, false, S0)).then(xNotOwner)
        .expect(x.ep == 2)
        .then(xAnswer(K2, false, S2))
        .expect(g.hops == 2 and x.seen.get(K2) == Set(0))
        .then(xFinishRO)
        .expect(x.st == COMMITTED and m23cSafeRO and not(witnessForward2))
}

// 同じく、書き手 Y。pull に乗った intent が、受け取る前の c で、子で適用される
module m23c_green_ro_y {
  import m23c_core(OLD_READS = true, FWD = true, MERGE = true, SPLIT_FLOOR = false, EMPTY_FLOOR = true, PREV_ANSWERS = false,
                   WORKER_ROUTES = false, RETAIN = true,
                   MOVES_N = 2, BACK = false, EMPTY = false, SCAN2 = true, WRITE = false, PESSIMISTIC = false, OTHER = true,
                   HAS_W = false, HAS_Y = true, TICKS = 0, T_MAX = 5, GCS = 0, R = 1).*
  // Y が S0 で prepare し (pts 1)、X は T = 1 で読み始める。intent は pull に乗り、c = 1 (< m1 = 2) で S1 で適用される。
  // S1 は S0 に尋ね (S0 の記録は最初の行だけ)、自分の版 (Y、c = 1) を重ねて答える
  run overlayTest =
    init.then(yPrepare(S0))
        .then(xBegin)                                                        // T = 1
        .then(xAnswer(K1, false, S0))
        .then(start(1)).then(pull(1)).then(recv(1))                          // m1 = 2。intent は S1 へ
        .then(yDecide(1)).then(yPhase2)                                      // c = 1、S1 で適用する
        .then(xNotOwner)
        .then(xAnswer(K2, false, S1))
        .expect(x.seen.get(K2) == Set(Y) and g.overlay)
        .then(xAnswer(K1, false, S0)).then(xAnswer(K2, false, S1)).then(xFinishRO)
        .expect(x.st == COMMITTED and m23cSafeRO and not(witnessOverlay))
}

// 書く取引 (全表を 2 回読み、K2 を楽観で書く)。書き手 W / Y
module m23c_green_w {
  import m23c_core(OLD_READS = true, FWD = true, MERGE = true, SPLIT_FLOOR = false, EMPTY_FLOOR = true, PREV_ANSWERS = false,
                   WORKER_ROUTES = false, RETAIN = true,
                   MOVES_N = 2, BACK = false, EMPTY = false, SCAN2 = true, WRITE = true, PESSIMISTIC = false, OTHER = true,
                   HAS_W = true, HAS_Y = false, TICKS = 0, T_MAX = 5, GCS = 0, R = 1).*
  // 再現の形を、refresh なしで。移動 1 の前に全表を読み、2 回の移動の後に T = 0 のまま読み直して、動いた行を S2 で書いて確定する
  run writeAcrossTest =
    init.then(xBegin)
        .then(xAnswer(K1, false, S0)).then(xAnswer(K2, false, S0))         // T = 0
        .then(start(1)).then(pull(1)).then(recv(1)).then(finish(1))
        .then(start(2)).then(pull(2)).then(recv(2)).then(finish(2))
        .then(xAnswer(K1, false, S0)).then(xNotOwner)
        .then(xAnswer(K2, false, S2))                                        // S2 は S1 に、S1 は S0 に尋ねる
        .then(xAnswer(K2, true, S2))                                         // UPDATE (同じ T で読む)
        .expect(x.T == 0 and g.hops == 2)
        .then(xPrepare).then(askStep).then(askStep).then(xPrepare)           // 確定の検証は、M23b のとおり S1 と S0 に尋ねる
        .then(xPrepareP).then(xApply)
        .expect(x.st == COMMITTED and m23cSafe and not(witnessWriteAcross2))
}
module m23c_green_y {
  import m23c_core(OLD_READS = true, FWD = true, MERGE = true, SPLIT_FLOOR = false, EMPTY_FLOOR = true, PREV_ANSWERS = false,
                   WORKER_ROUTES = false, RETAIN = true,
                   MOVES_N = 2, BACK = false, EMPTY = false, SCAN2 = true, WRITE = true, PESSIMISTIC = false, OTHER = true,
                   HAS_W = false, HAS_Y = true, TICKS = 0, T_MAX = 5, GCS = 0, R = 1).*
}
// 悲観の取引。全表を 1 回読み、動いた行を DML で書く
module m23c_green_pess {
  import m23c_core(OLD_READS = true, FWD = true, MERGE = true, SPLIT_FLOOR = false, EMPTY_FLOOR = true, PREV_ANSWERS = false,
                   WORKER_ROUTES = false, RETAIN = true,
                   MOVES_N = 2, BACK = false, EMPTY = false, SCAN2 = false, WRITE = true, PESSIMISTIC = true, OTHER = true,
                   HAS_W = true, HAS_Y = true, TICKS = 0, T_MAX = 5, GCS = 0, R = 1).*
}
// 範囲が S0 へ戻る。読むだけ、書き手 Y
module m23c_green_back_y {
  import m23c_core(OLD_READS = true, FWD = true, MERGE = true, SPLIT_FLOOR = false, EMPTY_FLOOR = true, PREV_ANSWERS = false,
                   WORKER_ROUTES = false, RETAIN = true,
                   MOVES_N = 2, BACK = true, EMPTY = false, SCAN2 = true, WRITE = false, PESSIMISTIC = false, OTHER = true,
                   HAS_W = false, HAS_Y = true, TICKS = 0, T_MAX = 5, GCS = 0, R = 1).*
}
// 閾値を範囲の床にしても (前の持ち主が [到着の m, 床) の T にも答える)、持ち主が自分の版を重ねれば安全である。全表の span (グループごとの
// 到着の m を引かない) は、この形になる
module m23c_green_split_floor {
  import m23c_core(OLD_READS = true, FWD = true, MERGE = true, SPLIT_FLOOR = true, EMPTY_FLOOR = true, PREV_ANSWERS = false,
                   WORKER_ROUTES = false, RETAIN = true,
                   MOVES_N = 2, BACK = false, EMPTY = false, SCAN2 = true, WRITE = false, PESSIMISTIC = false, OTHER = true,
                   HAS_W = true, HAS_Y = false, TICKS = 0, T_MAX = 5, GCS = 0, R = 1).*
}
module m23c_green_split_floor_y {
  import m23c_core(OLD_READS = true, FWD = true, MERGE = true, SPLIT_FLOOR = true, EMPTY_FLOOR = true, PREV_ANSWERS = false,
                   WORKER_ROUTES = false, RETAIN = true,
                   MOVES_N = 2, BACK = false, EMPTY = false, SCAN2 = true, WRITE = false, PESSIMISTIC = false, OTHER = true,
                   HAS_W = false, HAS_Y = true, TICKS = 0, T_MAX = 5, GCS = 0, R = 1).*
}
// 保持。変更ログを 2 回まで切り詰める (保持の幅 1)。移動 1 回、読むだけ、書き手 W。S0 が渡した行を消すことと、S1 が受け取りの
// 記録を消すことの両方が起きる。移動 2 回の形 (m23c_green_retain2、切り詰め 1 回) は HEAVY
module m23c_green_retain {
  import m23c_core(OLD_READS = true, FWD = true, MERGE = true, SPLIT_FLOOR = false, EMPTY_FLOOR = true, PREV_ANSWERS = false,
                   WORKER_ROUTES = false, RETAIN = true,
                   MOVES_N = 1, BACK = false, EMPTY = false, SCAN2 = true, WRITE = false, PESSIMISTIC = false, OTHER = true,
                   HAS_W = true, HAS_Y = false, TICKS = 0, T_MAX = 5, GCS = 2, R = 1).*
  // 移動の後、S0 の logLowWater が 1 に上がる。T = 0 の読みは、S1 から S0 に尋ねて、S0 で「古すぎる」と断られる
  run tooOldTest =
    init.then(xBegin)
        .then(xAnswer(K1, false, S0))                                        // T = 0
        .then(start(1)).then(pull(1)).then(recv(1)).then(finish(1))           // m1 = 1、S0 の時計 2
        .then(gc(S0, 1))
        .then(xNotOwner)
        .then(xReadTooOld(K2, false))
        .expect(x.st == ABORTED and g.prevOld and m23cSafeRO and not(witnessTooOld))
}
// 同じく、書く取引 (確定の検証も窓の下限を logLowWater と比べる)
module m23c_green_retain_w {
  import m23c_core(OLD_READS = true, FWD = true, MERGE = true, SPLIT_FLOOR = false, EMPTY_FLOOR = true, PREV_ANSWERS = false,
                   WORKER_ROUTES = false, RETAIN = true,
                   MOVES_N = 1, BACK = false, EMPTY = false, SCAN2 = true, WRITE = true, PESSIMISTIC = false, OTHER = true,
                   HAS_W = true, HAS_Y = false, TICKS = 0, T_MAX = 5, GCS = 2, R = 1).*
}
// 移動 2 回で、変更ログを 1 回切り詰める (S1 が、移動 2 で渡した行を残すことも確かめる)。読むだけ、書き手 W (HEAVY)
module m23c_green_retain2 {
  import m23c_core(OLD_READS = true, FWD = true, MERGE = true, SPLIT_FLOOR = false, EMPTY_FLOOR = true, PREV_ANSWERS = false,
                   WORKER_ROUTES = false, RETAIN = true,
                   MOVES_N = 2, BACK = false, EMPTY = false, SCAN2 = true, WRITE = false, PESSIMISTIC = false, OTHER = true,
                   HAS_W = true, HAS_Y = false, TICKS = 0, T_MAX = 5, GCS = 1, R = 1).*
}
// 空にされたグループ (W が行を消す)。fence の後に行も intent もなければ、pull されず、子が床から受け持つ。読むだけ
module m23c_green_empty {
  import m23c_core(OLD_READS = true, FWD = true, MERGE = true, SPLIT_FLOOR = false, EMPTY_FLOOR = true, PREV_ANSWERS = false,
                   WORKER_ROUTES = false, RETAIN = true,
                   MOVES_N = 2, BACK = false, EMPTY = true, SCAN2 = true, WRITE = false, PESSIMISTIC = false, OTHER = true,
                   HAS_W = true, HAS_Y = false, TICKS = 0, T_MAX = 5, GCS = 0, R = 1).*
  // X が T = 0 で読む。W が K2 の行を消す (c = 1)。移動 1 は行を運ばず、子は床 2 から受け持つ。子は、床より前の T を S0 に尋ねる
  run emptyTest =
    init.then(xBegin)
        .then(xAnswer(K1, false, S0)).then(xAnswer(K2, false, S0))         // T = 0
        .then(wWrite(S0))                                                    // 行を消す、c = 1
        .then(start(1)).then(finish(1))                                      // pull なし。床 2
        .expect(m1.moved == 0 and m1.floor == 2)
        .then(xAnswer(K1, false, S0)).then(xNotOwner).then(xAnswer(K2, false, S1))
        .expect(x.seen.get(K2) == Set(0) and g.oldRead)
        .then(xFinishRO)
        .expect(x.st == COMMITTED and m23cSafeRO and not(witnessEmptyRead))
}

// 活性。読むだけ、書き手 Y、T の上限 4
module m23c_live {
  import m23c_core(OLD_READS = true, FWD = true, MERGE = true, SPLIT_FLOOR = false, EMPTY_FLOOR = true, PREV_ANSWERS = false,
                   WORKER_ROUTES = false, RETAIN = true,
                   MOVES_N = 2, BACK = false, EMPTY = false, SCAN2 = true, WRITE = false, PESSIMISTIC = false, OTHER = true,
                   HAS_W = false, HAS_Y = true, TICKS = 0, T_MAX = 4, GCS = 0, R = 1).*
}

// ---- 赤: 条件を 1 つずつ外す ------------------------------------------------------------------------------------------

// M23b のまま (古い読みなし)。案 A' の形で、読むだけの取引が、移動のために失敗する
module m23c_base_ro {
  import m23c_core(OLD_READS = false, FWD = true, MERGE = true, SPLIT_FLOOR = false, EMPTY_FLOOR = true, PREV_ANSWERS = false,
                   WORKER_ROUTES = false, RETAIN = true,
                   MOVES_N = 2, BACK = false, EMPTY = false, SCAN2 = true, WRITE = false, PESSIMISTIC = false, OTHER = true,
                   HAS_W = true, HAS_Y = false, TICKS = 0, T_MAX = 5, GCS = 0, R = 1).*
  run counterexampleTest =
    init.then(xBegin)
        .then(xAnswer(K1, false, S0)).then(xAnswer(K2, false, S0))         // T = 0
        .then(wWrite(S0))                                                    // c = 1
        .then(start(1)).then(pull(1)).then(recv(1)).then(finish(1))           // m1 = 2、床 3
        .then(xAnswer(K1, false, S0)).then(xNotOwner)
        .then(xTooOld(K2, false))                                            // S1: T = 0 < 床 3。refresh で T を 3 へ
        .then(confirmK1).then(confirmK2(S1)).then(askStep)                   // S0 の (0, 2] に W がある
        .expect(x.st == ABORTED and not(roNeverFails))
}

// 赤: 持ち主が、到着より前の T の読みに、自分の状態 (受け取った行) で答える
module m23c_red_child_below {
  import m23c_core(OLD_READS = true, FWD = false, MERGE = true, SPLIT_FLOOR = false, EMPTY_FLOOR = true, PREV_ANSWERS = false,
                   WORKER_ROUTES = false, RETAIN = true,
                   MOVES_N = 2, BACK = false, EMPTY = false, SCAN2 = true, WRITE = false, PESSIMISTIC = false, OTHER = true,
                   HAS_W = true, HAS_Y = false, TICKS = 0, T_MAX = 5, GCS = 0, R = 1).*
  run counterexampleTest =
    init.then(xBegin)
        .then(xAnswer(K1, false, S0)).then(xAnswer(K2, false, S0))         // T = 0
        .then(wWrite(S0))                                                    // c = 1
        .then(start(1)).then(pull(1)).then(recv(1))                          // m1 = 2。受け取った行は W の値
        .then(xAnswer(K1, false, S0)).then(xNotOwner).then(xAnswer(K2, false, S1))
        .expect(x.seen.get(K2) == Set(0, W) and not(readConsistent))
}

// 赤: 尋ねた側が、自分の版を重ねない (「受け取る前に、子の書き込みはない」と置く)。pull に乗った intent を、受け取る前の c で適用したものを落とす
module m23c_red_no_merge {
  import m23c_core(OLD_READS = true, FWD = true, MERGE = false, SPLIT_FLOOR = false, EMPTY_FLOOR = true, PREV_ANSWERS = false,
                   WORKER_ROUTES = false, RETAIN = true,
                   MOVES_N = 2, BACK = false, EMPTY = false, SCAN2 = true, WRITE = false, PESSIMISTIC = false, OTHER = true,
                   HAS_W = false, HAS_Y = true, TICKS = 0, T_MAX = 5, GCS = 0, R = 1).*
  run counterexampleTest =
    init.then(yPrepare(S0))                                                  // pts 1
        .then(xBegin)                                                        // T = 1
        .then(xAnswer(K1, false, S0))
        .then(start(1)).then(pull(1)).then(recv(1))                          // m1 = 2
        .then(yDecide(1)).then(yPhase2)                                      // Y は c = 1 で S1 で適用される
        .then(xNotOwner).then(xAnswer(K2, false, S1))                        // S0 の答え (最初の行) をそのまま使う
        .expect(x.seen.get(K2) == Set(0) and not(readConsistent))
}

// 赤: 閾値を範囲の床にし、前の持ち主の答えをそのまま使う (前の持ち主が、到着の m 以上の T に答える)。子の書き込みを落とす
module m23c_red_prev_above {
  import m23c_core(OLD_READS = true, FWD = true, MERGE = false, SPLIT_FLOOR = true, EMPTY_FLOOR = true, PREV_ANSWERS = false,
                   WORKER_ROUTES = false, RETAIN = true,
                   MOVES_N = 2, BACK = false, EMPTY = false, SCAN2 = true, WRITE = false, PESSIMISTIC = false, OTHER = true,
                   HAS_W = true, HAS_Y = false, TICKS = 0, T_MAX = 5, GCS = 0, R = 1).*
  run counterexampleTest =
    init.then(xBegin)                                                        // T = 0
        .then(xAnswer(K1, false, S0))
        .then(start(1)).then(pull(1)).then(recv(1))                          // m1 = 1
        .then(wWrite(S1))                                                    // 子が c = 2 で確定する
        .then(xOther(2)).then(confirmK1)                                     // T = 2
        .then(finish(1))                                                     // 床 3
        .then(xNotOwner).then(xAnswer(K2, false, S1))                        // T = 2 < 床 3。S0 の答え (最初の行) をそのまま使う
        .expect(x.T == 2 and x.seen.get(K2) == Set(0) and not(readConsistent))
}

// 赤: 渡したシャードが、移動を終えたら、渡した行を消す (今のコードの ack)。前の持ち主は、尋ねられても行を答えられない
module m23c_red_no_retain {
  import m23c_core(OLD_READS = true, FWD = true, MERGE = true, SPLIT_FLOOR = false, EMPTY_FLOOR = true, PREV_ANSWERS = false,
                   WORKER_ROUTES = false, RETAIN = false,
                   MOVES_N = 2, BACK = false, EMPTY = false, SCAN2 = true, WRITE = false, PESSIMISTIC = false, OTHER = true,
                   HAS_W = true, HAS_Y = false, TICKS = 0, T_MAX = 5, GCS = 0, R = 1).*
  run counterexampleTest =
    init.then(xBegin)
        .then(xAnswer(K1, false, S0)).then(xAnswer(K2, false, S0))         // T = 0
        .then(start(1)).then(pull(1)).then(recv(1)).then(finish(1))
        .then(dropRows(1))                                                   // S0 が渡した行を消す
        .then(xAnswer(K1, false, S0)).then(xNotOwner).then(xAnswer(K2, false, S1))
        .expect(x.seen.get(K2) == Set(0, -1) and not(readConsistent))
}

// 赤: 渡したシャードが、範囲表の古い Worker の読みを断らず、手放した時刻より前の T なら、残した記録で答える (epoch の確かめなし)
module m23c_red_no_epoch {
  import m23c_core(OLD_READS = true, FWD = true, MERGE = true, SPLIT_FLOOR = false, EMPTY_FLOOR = true, PREV_ANSWERS = true,
                   WORKER_ROUTES = false, RETAIN = true,
                   MOVES_N = 2, BACK = false, EMPTY = false, SCAN2 = true, WRITE = false, PESSIMISTIC = false, OTHER = true,
                   HAS_W = false, HAS_Y = true, TICKS = 0, T_MAX = 5, GCS = 0, R = 1).*
  run counterexampleTest =
    init.then(yPrepare(S0))                                                  // pts 1
        .then(xBegin)                                                        // T = 1
        .then(xAnswer(K1, false, S0))
        .then(start(1)).then(pull(1)).then(recv(1))                          // m1 = 2
        .then(yDecide(1)).then(yPhase2)                                      // Y は c = 1 で S1 で適用される
        .then(xAnswerPrev(false, S0))                                        // 範囲表は epoch 0。S0 が T = 1 < 2 で答える
        .expect(x.seen.get(K2) == Set(0) and not(readConsistent))
}

// 赤: Worker が、古い T の読みを、前の持ち主へ直接送る (持ち主は答えに加わらず、intent も扱わない)
module m23c_red_worker_routes {
  import m23c_core(OLD_READS = true, FWD = true, MERGE = true, SPLIT_FLOOR = false, EMPTY_FLOOR = true, PREV_ANSWERS = false,
                   WORKER_ROUTES = true, RETAIN = true,
                   MOVES_N = 2, BACK = false, EMPTY = false, SCAN2 = true, WRITE = false, PESSIMISTIC = false, OTHER = true,
                   HAS_W = false, HAS_Y = true, TICKS = 0, T_MAX = 5, GCS = 0, R = 1).*
  run counterexampleTest =
    init.then(yPrepare(S0))
        .then(xBegin)                                                        // T = 1
        .then(xAnswer(K1, false, S0))
        .then(start(1)).then(pull(1)).then(recv(1))                          // m1 = 2。intent は S1 へ (c は未定)
        .then(xNotOwner).then(xAnswer(K2, false, S1))                        // S0 が答える。誰も Y を push しない
        .expect(x.seen.get(K2) == Set(0) and y.pushed == 0)
        .then(yDecide(1)).then(yPhase2)                                      // c = 1 <= T
        .then(xAnswer(K1, false, S0)).then(xAnswer(K2, false, S1))
        .expect(x.seen.get(K2) == Set(0) and not(readConsistent))
}

// 赤: 運ばれなかったグループの窓の始まりを記録しない (到着の記録 __arrived だけを引く)。子は、床より前の T に、行なしと答える
module m23c_red_empty_no_floor {
  import m23c_core(OLD_READS = true, FWD = true, MERGE = true, SPLIT_FLOOR = false, EMPTY_FLOOR = false, PREV_ANSWERS = false,
                   WORKER_ROUTES = false, RETAIN = true,
                   MOVES_N = 2, BACK = false, EMPTY = true, SCAN2 = true, WRITE = false, PESSIMISTIC = false, OTHER = true,
                   HAS_W = true, HAS_Y = false, TICKS = 0, T_MAX = 5, GCS = 0, R = 1).*
  run counterexampleTest =
    init.then(xBegin)
        .then(xAnswer(K1, false, S0)).then(xAnswer(K2, false, S0))         // T = 0
        .then(wWrite(S0))                                                    // 行を消す、c = 1
        .then(start(1)).then(finish(1))                                      // pull なし。床 2
        .then(xAnswer(K1, false, S0)).then(xNotOwner).then(xAnswer(K2, false, S1))
        .expect(x.seen.get(K2) == Set(0, W) and not(readConsistent))
}
