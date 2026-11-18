// M23d: 古い読みに重ねる自分の版を、変更ログの切り詰めで失わない (未解決の問題 37 の実装で見つけた欠陥 1)
//
// 2026-11-16 に書いた。直すより先に書いたモデルである (計画書の規則 3)。
// M23c (m23c_old_reads_across_move.qnt) の古い読みでは、いまの持ち主は、受け持ち始めた時刻 m より前の T の読みを前の持ち主に尋ね (土台)、
// 自分の記録の T 以下の版を重ねる。M23c の記録は、版を c と logLowWater で比べて切り詰める。実装の変更ログは、commit 時刻 c で分けた
// 世代の表で、世代ごとに消し、logLowWater は消した世代のいちばん大きな c になる。pull に乗った intent の phase 2 が遅れると、いまの
// 持ち主は、受け持ち始めた後に、m より小さい c で適用する。その版は古い世代に入り、次の切り詰めで消える。logLowWater は c になり、T
// より下に残るので、古い読みは断られずに、土台だけで答え、確定した版を落とす (test/open/old-read-overlay-after-log-truncation.test.ts)。
// M23c は、切り詰めを c の順だけで行い、受け持ち始める前の c の版がいつ消えるかを分けていなかった。
//
// 舞台。シャード P (=0) と C (=1)、行 k が 1 つ。k の範囲が P から C へ動く (fence、pull、recv、ack の 4 手)。
// 書き手は 2 つである。Y は 2 相の取引で、P で k の intent を prepare し、anchor が c を決め、phase 2 は遅れて届く。intent は、pull の前なら
// P にあり、pull の後は範囲と一緒に C へ行く。W は autocommit で、いまの持ち主の k を、intent がなければ今の時刻で書く。
// 読み手 X は、ある時刻 T を読み取り時刻にして、後で何度でも k を読む。読みは、いまの持ち主が答える (移動の途中は待つ)。
//   P が持ち主 (移動の前)     P の行を、自分の変更ログの T より後の確定で戻す。T < logLowWater なら断る
//   C が持ち主で T >= m       C の行を、自分の変更ログの T より後の確定で戻す
//   C が持ち主で T < m        P に尋ねる (土台: P の行か、ack の後は渡した行を、P の変更ログで T まで戻す)。C は、自分の版のうち c が T 以下の
//                            ものを重ね、いちばん新しい版を答える。P と C のどちらかで T < logLowWater なら断る
// 読みの前に、持ち主は intent を今の読みと同じ規則で扱う (c が決まっていなければ T より上へ push し、決まっていれば適用する)。
// 時計は 1 つで、tick で進む。変更ログの世代は c / G で、切り詰め (gc) は、今の世代より古い世代のうち、全部の確定が 時計 - RET 以下の
// いちばん古い世代を消し、logLowWater を、消した世代のいちばん大きな c に上げる。P は、渡した行を logLowWater が m 以上になるまで残す
// (M23c の RETAIN)。
//
// 規則の条件 (定数)。赤は 1 つずつ外す。
//   KEEP        受け持ち始めた後に、m より小さい c で適用した版 (受け持ち始める前の c の版) を、変更ログとは別に残し、古い読みに重ねる
//               (false: 変更ログだけから重ねる。いまの実装。赤)
//   KEEP_START  残した版を消すのは、logLowWater が m 以上になってから (false: c 以上になったら。赤)。m 以上になれば、m より前の T の
//               読みは logLowWater で断られる (資源の限り)
//
// invariant
//   readAtT          答えた読みは、時刻 T の、確定した版のうちいちばん新しいものである (M23c の readConsistent。読むだけの取引では、
//                    これが直列化可能であることと同じである)
//   answersInWindow  T が保持の窓 (時計 - RET 以上) にある読みは断られない (M23c の roNeverFails。移動では失敗しない)
module m23d_core {
  const KEEP: bool
  const KEEP_START: bool
  const HAS_W: bool
  const T_MAX: int
  const RET: int
  const G: int

  pure val P = 0
  pure val C = 1
  pure val NONE = -1
  // 書き手の名前 (版の値)。0 は最初の行
  pure val INIT = 0
  pure val BY_W = 1
  pure val BY_Y = 2
  // Y の intent の場所
  pure val Y_NONE = 0
  pure val Y_AT_P = 1
  pure val Y_FLYING = 2
  pure val Y_AT_C = 3
  pure val Y_APPLIED = 4

  type Ver = { c: int, w: int }
  type Entry = { c: int, w: int, before: int }
  type Kept = { c: int, w: int, start: int }

  var now: int
  // 移動の進み。0 は移動の前、1 は fence の後、2 は pull の後 (飛行中)、3 は C に着いた後、4 は ack の後
  var moved: int
  var m: int
  var row: int -> Ver
  var flying: Ver
  var log: int -> Set[Entry]
  var low: int -> int
  var handed: Ver
  var kept: Set[Kept]
  var yAt: int
  var yPts: int
  var yC: int
  var yPushed: int
  var wC: int
  var xT: int
  var bad: bool
  var refusedIn: bool
  var keptUsed: bool

  pure val noVer: Ver = { c: -1, w: NONE }
  pure def max(a: int, b: int): int = if (a > b) a else b
  pure def gen(c: int): int = c / G

  action init = all {
    now' = 1, moved' = 0, m' = 0,
    row' = Map(P -> { c: 0, w: INIT }, C -> noVer),
    flying' = noVer,
    log' = Map(P -> Set(), C -> Set()),
    low' = Map(P -> 0, C -> 0),
    handed' = noVer, kept' = Set(),
    yAt' = Y_NONE, yPts' = 0, yC' = 0, yPushed' = 0, wC' = 0, xT' = -1,
    bad' = false, refusedIn' = false, keptUsed' = false,
  }

  // 確定した版。Y は c が決まったら確定している (適用はまだでもよい)
  def committed: Set[Ver] =
    Set({ c: 0, w: INIT })
      .union(if (wC > 0) Set({ c: wC, w: BY_W }) else Set())
      .union(if (yC > 0) Set({ c: yC, w: BY_Y }) else Set())
  pure def newest(vs: Set[Ver]): Ver = vs.fold(noVer, (acc, v) => if (v.c > acc.c) v else acc)
  def truth(t: int): int = newest(committed.filter(v => v.c <= t)).w
  // 行 r を、変更ログ es の T より後の確定で戻す (行ごとに、T より後のいちばん古い確定の before-image)
  pure def rollback(r: Ver, es: Set[Entry], t: int): int =
    val after = es.filter(e => e.c > t)
    if (after == Set()) r.w else after.fold({ c: 1000, w: NONE, before: NONE }, (acc, e) => if (e.c < acc.c) e else acc).before
  def owner: int = if (moved == 0) P else C
  def yAtOwner: bool = (owner == P and yAt == Y_AT_P) or (owner == C and yAt == Y_AT_C)

  // ---- 時計と書き手 ----
  action tick = all {
    now < T_MAX, now' = now + 1,
    moved' = moved, m' = m, row' = row, flying' = flying, log' = log, low' = low, handed' = handed, kept' = kept,
    yAt' = yAt, yPts' = yPts, yC' = yC, yPushed' = yPushed, wC' = wC, xT' = xT, bad' = bad, refusedIn' = refusedIn, keptUsed' = keptUsed,
  }
  action yPrepare = all {
    // 読んだシャードは時計を T まで進めるので、X が読んだ後の prepare の時刻は T より大きい
    // prepare の時刻は、そのシャードが適用した確定より大きい
    yAt == Y_NONE, moved == 0, xT < 0 or now > xT, now > row.get(P).c,
    yAt' = Y_AT_P, yPts' = now,
    now' = now, moved' = moved, m' = m, row' = row, flying' = flying, log' = log, low' = low, handed' = handed, kept' = kept,
    yC' = yC, yPushed' = yPushed, wC' = wC, xT' = xT, bad' = bad, refusedIn' = refusedIn, keptUsed' = keptUsed,
  }
  // anchor が c を決める。c は prepare の時刻と push された時刻より大きく、今の時計以下である
  action yDecide(c: int): bool = all {
    yAt != Y_NONE, yAt != Y_APPLIED, yC == 0,
    c >= yPts, c > yPushed, c <= now, c >= 1,
    yC' = c,
    now' = now, moved' = moved, m' = m, row' = row, flying' = flying, log' = log, low' = low, handed' = handed, kept' = kept,
    yAt' = yAt, yPts' = yPts, yPushed' = yPushed, wC' = wC, xT' = xT, bad' = bad, refusedIn' = refusedIn, keptUsed' = keptUsed,
  }
  // s が Y を c で適用する。C が m より小さい c で適用した版は、KEEP なら別に残す
  action applyY(s: int): bool = all {
    log' = log.setBy(s, es => es.union(Set({ c: yC, w: BY_Y, before: row.get(s).w }))),
    row' = row.set(s, { c: yC, w: BY_Y }),
    kept' = if (KEEP and s == C and yC < m) kept.union(Set({ c: yC, w: BY_Y, start: m })) else kept,
    yAt' = Y_APPLIED,
  }
  // phase 2。intent が飛行中なら届かない (C は、グループが着いてから適用する)
  action yPhase2 = all {
    yC > 0, yAt == Y_AT_P or yAt == Y_AT_C,
    applyY(if (yAt == Y_AT_P) P else C),
    now' = now, moved' = moved, m' = m, flying' = flying, low' = low, handed' = handed,
    yPts' = yPts, yC' = yC, yPushed' = yPushed, wC' = wC, xT' = xT, bad' = bad, refusedIn' = refusedIn, keptUsed' = keptUsed,
  }
  action wWrite = all {
    HAS_W, wC == 0, moved == 0 or moved >= 3, not(yAtOwner), xT < 0 or now > xT,
    // W の c は今の時計で、持ち主の行のどの版より大きい
    now > row.get(owner).c,
    val s = owner
    all {
      log' = log.setBy(s, es => es.union(Set({ c: now, w: BY_W, before: row.get(s).w }))),
      row' = row.set(s, { c: now, w: BY_W }),
      wC' = now,
    },
    now' = now, moved' = moved, m' = m, flying' = flying, low' = low, handed' = handed, kept' = kept,
    yAt' = yAt, yPts' = yPts, yC' = yC, yPushed' = yPushed, xT' = xT, bad' = bad, refusedIn' = refusedIn, keptUsed' = keptUsed,
  }

  // ---- 移動 ----
  action fence = all {
    moved == 0, moved' = 1,
    now' = now, m' = m, row' = row, flying' = flying, log' = log, low' = low, handed' = handed, kept' = kept,
    yAt' = yAt, yPts' = yPts, yC' = yC, yPushed' = yPushed, wC' = wC, xT' = xT, bad' = bad, refusedIn' = refusedIn, keptUsed' = keptUsed,
  }
  action pull = all {
    moved == 1, moved' = 2,
    flying' = row.get(P),
    yAt' = if (yAt == Y_AT_P) Y_FLYING else yAt,
    now' = now, m' = m, row' = row, log' = log, low' = low, handed' = handed, kept' = kept,
    yPts' = yPts, yC' = yC, yPushed' = yPushed, wC' = wC, xT' = xT, bad' = bad, refusedIn' = refusedIn, keptUsed' = keptUsed,
  }
  action recv = all {
    moved == 2, moved' = 3,
    row' = row.set(C, flying), m' = now,
    yAt' = if (yAt == Y_FLYING) Y_AT_C else yAt,
    now' = now, flying' = flying, log' = log, low' = low, handed' = handed, kept' = kept,
    yPts' = yPts, yC' = yC, yPushed' = yPushed, wC' = wC, xT' = xT, bad' = bad, refusedIn' = refusedIn, keptUsed' = keptUsed,
  }
  action ack = all {
    moved == 3, moved' = 4,
    handed' = row.get(P), row' = row.set(P, noVer),
    now' = now, m' = m, flying' = flying, log' = log, low' = low, kept' = kept,
    yAt' = yAt, yPts' = yPts, yC' = yC, yPushed' = yPushed, wC' = wC, xT' = xT, bad' = bad, refusedIn' = refusedIn, keptUsed' = keptUsed,
  }

  // ---- 切り詰め ----
  // s の変更ログの、いちばん古い世代 g を消す。g は今の世代より古く、その全部の確定が 時計 - RET 以下である
  action gc(s: int, g: int): bool = all {
    val es = log.get(s)
    val inG = es.filter(e => gen(e.c) == g)
    val water = now - RET
    all {
      inG != Set(), g < gen(now),
      es.forall(e => gen(e.c) >= g),
      inG.forall(e => e.c <= water),
      val l = max(low.get(s), inG.fold(0, (acc, e) => max(acc, e.c)))
      all {
        log' = log.set(s, es.exclude(inG)),
        low' = low.set(s, l),
        kept' = if (s != C) kept else kept.filter(k => if (KEEP_START) k.start > l else k.c > l),
        handed' = if (s == P and l >= m and moved == 4) noVer else handed,
      },
    },
    now' = now, moved' = moved, m' = m, row' = row, flying' = flying,
    yAt' = yAt, yPts' = yPts, yC' = yC, yPushed' = yPushed, wC' = wC, xT' = xT, bad' = bad, refusedIn' = refusedIn, keptUsed' = keptUsed,
  }

  // ---- 読み手 ----
  action xBegin = all {
    xT < 0, xT' = now,
    now' = now, moved' = moved, m' = m, row' = row, flying' = flying, log' = log, low' = low, handed' = handed, kept' = kept,
    yAt' = yAt, yPts' = yPts, yC' = yC, yPushed' = yPushed, wC' = wC, bad' = bad, refusedIn' = refusedIn, keptUsed' = keptUsed,
  }
  // 持ち主が、読みの前に intent を扱う。c が決まっていなければ T より上へ push する。決まっていれば適用する (適用は phase 2 と同じ)
  action xSettle = all {
    xT >= 0, moved == 0 or moved >= 3, yAtOwner,
    if (yC == 0) all {
      yPushed' = max(yPushed, xT),
      log' = log, row' = row, kept' = kept, yAt' = yAt,
    } else all { applyY(owner), yPushed' = yPushed },
    now' = now, moved' = moved, m' = m, flying' = flying, low' = low, handed' = handed,
    yPts' = yPts, yC' = yC, wC' = wC, xT' = xT, bad' = bad, refusedIn' = refusedIn, keptUsed' = keptUsed,
  }
  // 古い読みの答え (C が持ち主で T < m)。土台は P の行 (ack の前) か渡した行を、P の変更ログで T まで戻したもの。C の版を重ねる
  def baseAtP: int = rollback(if (moved == 4) handed else row.get(P), log.get(P), xT)
  def overlay: Set[Ver] =
    log.get(C).filter(e => e.c <= xT).map(e => { c: e.c, w: e.w })
      .union(kept.filter(k => k.c <= xT).map(k => { c: k.c, w: k.w }))
  def oldAnswer: int = if (overlay == Set()) baseAtP else newest(overlay).w
  action xRead = all {
    xT >= 0, moved == 0 or moved >= 3, not(yAtOwner),
    val old = owner == C and xT < m
    val refused = xT < low.get(owner) or (old and (xT < low.get(P) or (moved == 4 and handed == noVer)))
    val ans = if (owner == P) rollback(row.get(P), log.get(P), xT) else if (old) oldAnswer else rollback(row.get(C), log.get(C), xT)
    all {
      bad' = (bad or (not(refused) and ans != truth(xT))),
      refusedIn' = (refusedIn or (refused and xT >= now - RET)),
      keptUsed' = (keptUsed or (not(refused) and old and kept.exists(k => k.c <= xT) and log.get(C).forall(e => e.c > xT))),
    },
    now' = now, moved' = moved, m' = m, row' = row, flying' = flying, log' = log, low' = low, handed' = handed, kept' = kept,
    yAt' = yAt, yPts' = yPts, yC' = yC, yPushed' = yPushed, wC' = wC, xT' = xT,
  }

  action step = any {
    tick, yPrepare, { nondet c = oneOf(1.to(T_MAX)) yDecide(c) }, yPhase2, wWrite,
    fence, pull, recv, ack,
    { nondet s = oneOf(Set(P, C)) nondet g = oneOf(0.to(T_MAX / G)) gc(s, g) },
    xBegin, xSettle, xRead,
  }

  // ---- 不変条件 ----
  val readAtT = not(bad)
  val answersInWindow = not(refusedIn)
  val m23dSafe = readAtT and answersInWindow

  // ---- witness ----
  // 古い読みが、変更ログから消えた自分の版を、残した版から答えた
  val witnessKeptUsed = not(keptUsed)
}

// 緑: 受け持ち始める前の c の版を残し、logLowWater が m 以上になってから消す
module m23d_green {
  import m23d_core(KEEP = true, KEEP_START = true, HAS_W = false, T_MAX = 8, RET = 2, G = 2).*
  // test/open/old-read-overlay-after-log-truncation.test.ts の順序
  run truncationTest =
    init.then(yPrepare).then(yDecide(1))                    // Y は c = 1 で確定し、P への phase 2 は届かない
        .then(tick).then(tick).then(xBegin)                  // X の T = 3
        .then(fence).then(pull).then(tick).then(tick).then(recv)   // Y の intent は C へ。m = 5
        .then(yPhase2)                                       // C が Y を c = 1 (< m) で適用する
        .expect(kept.size() == 1)
        .then(tick).then(gc(C, 0))                           // C の変更ログの世代 0 (c = 1) を消す。logLowWater = 1 < T
        .expect(low.get(C) == 1 and log.get(C) == Set())
        .then(xRead)
        .expect(m23dSafe and keptUsed)
}

// 緑: 同上、W も書く
module m23d_green_w {
  import m23d_core(KEEP = true, KEEP_START = true, HAS_W = true, T_MAX = 8, RET = 2, G = 2).*
}

// 赤: いまの実装。古い読みに重ねる版を、変更ログからだけ取る
module m23d_red_log_only {
  import m23d_core(KEEP = false, KEEP_START = true, HAS_W = false, T_MAX = 8, RET = 2, G = 2).*
  run lostTest =
    init.then(yPrepare).then(yDecide(1))
        .then(tick).then(tick).then(xBegin)
        .then(fence).then(pull).then(tick).then(tick).then(recv)
        .then(yPhase2)
        .then(tick).then(gc(C, 0))
        .then(xRead)
        .expect(not(readAtT))
}

// 赤: 残した版を、logLowWater が c 以上になったら消す
module m23d_red_keep_until_c {
  import m23d_core(KEEP = true, KEEP_START = false, HAS_W = false, T_MAX = 8, RET = 2, G = 2).*
  run lostTest =
    init.then(yPrepare).then(yDecide(1))
        .then(tick).then(tick).then(xBegin)
        .then(fence).then(pull).then(tick).then(tick).then(recv)
        .then(yPhase2)
        .then(tick).then(gc(C, 0))
        .expect(kept == Set())
        .then(xRead)
        .expect(not(readAtT))
}
