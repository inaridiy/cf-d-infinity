// -*- mode: Bluespec; -*-
// M23h: シャードの全表の読み。要求の claim の行だけを、時刻 T の値で答える (未解決の問題 37 の続き)
//
// 2026-11-17 に書いた。実装より先に書いたモデルである。設計は docs/design-refresh-across-move.md の「3 回目の実装の規則」にある。
//
// 背景。全表の読み (主キーも shard key も名指ししない文) は、Worker が、範囲表でシャードごとの区間 (claim) を切って送る。
// M23f (m23f_statement_snapshot.qnt) は、Worker の側の規則を確かめ、シャードについては次の約束を置いた。
//   シャードは、要求の claim の全部を、自分のスナップショットでいま持っているときだけ答え、持っていなければ NotOwner で断る。
//   答えるのは、claim の中の行の、時刻 T の値だけである。
// ここでは、シャードがこの約束を守る条件を確かめる。M23c の古い読みは、グループ 1 つ、claim なしで確かめた。全表の読みは、
// 複数のグループにまたがり、グループごとの到着を引かないので、閾値は範囲の床になる。2 回目の実装は、ここで、前は断っていた読みに
// 答えるようにした。移動の途中のシャード (受け取り中の子と、送り出している親) が migrating で断らずに答え、受け取った側は、claim を
// 受け取りの記録ごとに分けて、床より前の T を前の持ち主に尋ねる。
//
// 規則。
//   OWN_WHOLE       シャードは、claim の全部を自分のスナップショットで持っていなければ、NotOwner で断る (M18、M19 と同じ)
//   BY_CLAIM        答えるのは、claim の中の行だけである。本体の表にある行でも、claim の外の行と、もう自分のものでない行 (送り出して
//                   ack を待つ行、変更ログの before-image で戻った、渡した行) は答えない。Worker の範囲表のほうが新しいと、claim は、
//                   シャードが自分のスナップショットで持つ区間より狭い
//   SPLIT           受け取った側は、claim を、受け取りの記録ごとに分ける。記録ごとに、T が範囲の床より小さければ、その記録の渡した側に
//                   尋ね、床より前の c で自分が適用した版 (残した版) を重ねる。床以上なら、自分の行を、自分の変更ログで T まで戻す
//   WAIT            受け取った側は、claim が受け取り中の範囲に掛かるなら、受け取り終える (範囲の床が決まる) まで待ってから答える
//   PARENT_ANSWERS  送り出している側は、claim が送り出している範囲に掛からなければ、断らずに答える
// 前の持ち主の答えは、渡した行を、自分の変更ログで T まで戻したものである (M23c、M23g)。intent と、尋ねる列が 2 段以上になる形は
// M23c と M23g が扱うので、ここにはない。
//
// 舞台。シャード P (親) と C (子)。区間 1、2、3 に、行が 1 つずつある。区間 3 は P に残る。区間 1 と 2 は C へ動く。
//   SCENE 0  1 回の移動で、区間 1 と 2 が動く (区間ごとに pull、recv、ack。全部届いたら finish で範囲の床が決まる)
//   SCENE 1  2 回の移動で、区間 1、区間 2 の順に動く (受け取りの記録が 2 つになり、範囲の床が違う)
//            いまの Meta は、範囲を持つシャードを子にする移動を断る (child-owns) ので、この形は起きない。その決まりを緩めたときの
//            規則を、先に確かめておく
// 移動は、Meta が move-start を記録し (start。子は受け取り始める)、親がそれを適用して範囲を止め (fence)、区間ごとに行を渡す。
// 親は、move-start を適用するまで、自分のスナップショットでは範囲を持っていて、書き込みも受ける。時計は 1 つ。
// 別の接続の書き込み W は、区間の行を、そのときの持ち主で書く。
// 読みは 1 つで、宛先のシャード、claim (区間の任意の集まり)、T (今の時計以下) を任意に選ぶ。Worker の範囲表は、古くても新しくてもよい。
//
// invariant
//   answersClaim     答えは、claim の区間をちょうど持つ (claim の外の区間がなく、claim の区間が欠けない)
//   answersAtT       答えた区間の値は、時刻 T の値である
//   answeredOwned    答えたシャードは、答えた時点で、claim の全部を自分のスナップショットで持っている
//   neverMigrating   シャードは、移動の途中であることを理由に、読みを断らない
// temporal
//   readEnds         読みは、いつか答えられるか、NotOwner で断られる (移動の手に公平性を置く)
module m23h_core {
  // ---- 規則の条件。赤は 1 つずつ外す ----
  const OWN_WHOLE: bool
  const BY_CLAIM: bool
  const SPLIT: int              // 0: 受け取りの記録ごと。1 赤: claim の全部を、いちばん新しい記録の床で決める。2 赤: いちばん古い記録の床で
  const WAIT: int               // 1: 待つ。0 赤: migrating で断る (前のコード)。2 赤: 待たずに答える
  const PARENT_ANSWERS: bool    // false 赤: 送り出している親は、全表の読みを migrating で断る (前のコード)
  // ---- 場面 ----
  const SCENE: int
  const WRITES_N: int

  pure val P = 1
  pure val C = 2
  pure val G = Set(1, 2, 3)
  pure val MOVES = Set(1, 2)
  pure val NONE = -1
  // 読みの状態
  pure val R_NONE = 0
  pure val R_PENDING = 1
  pure val R_ANSWERED = 2
  pure val R_NOTOWNER = 3
  pure val R_MIGRATING = 4

  type Entry = { g: int, c: int, before: int }
  type Part = { g: int, v: int }
  type Move = { started: bool, fenced: bool, floor: int }
  type Read = { st: int, d: int, k: Set[int], t: int, rows: Set[Part], owned: bool, asked: bool, waited: bool, outgoing: bool }

  var now: int
  var commits: int -> Set[int]      // ghost: 区間 -> 確定の時刻
  var mv: int -> Move
  var m: int -> int                 // 区間 -> 手放した時刻 (0 = まだ)
  var arrived: int -> bool          // 区間 -> 子に届いた
  var acked: int -> bool            // 区間 -> 親が本体の表から消した
  var img: int -> int               // 区間 -> 親が残した、渡した行
  var rowP: int -> int              // 親の本体の表 (NONE = 行なし)
  var rowC: int -> int
  var logP: Set[Entry]
  var logC: Set[Entry]
  var wN: int
  var rd: Read

  pure def max(a: int, b: int): int = if (a > b) a else b
  pure def min(a: int, b: int): int = if (a < b) a else b
  // 移動 i の範囲
  pure def rangeOf(i: int): Set[int] = if (SCENE == 0) (if (i == 1) Set(1, 2) else Set()) else (if (i == 1) Set(1) else Set(2))
  // 区間 g を運ぶ移動 (区間 3 は動かない)
  pure def moveOf(g: int): int = if (SCENE == 0) (if (g == 3) 0 else 1) else (if (g == 3) 0 else g)
  pure val noRead: Read = { st: R_NONE, d: 0, k: Set(), t: 0, rows: Set(), owned: false, asked: false, waited: false, outgoing: false }

  action init = all {
    now' = 0, commits' = G.mapBy(_ => Set()), mv' = MOVES.mapBy(_ => { started: false, fenced: false, floor: 0 }),
    m' = G.mapBy(_ => 0), arrived' = G.mapBy(_ => false), acked' = G.mapBy(_ => false), img' = G.mapBy(_ => NONE),
    rowP' = G.mapBy(_ => 0), rowC' = G.mapBy(_ => NONE), logP' = Set(), logC' = Set(), wN' = 0, rd' = noRead,
  }
  action keepMove = all { mv' = mv, m' = m, arrived' = arrived, acked' = acked, img' = img }
  action keepRows = all { commits' = commits, rowP' = rowP, rowC' = rowC, logP' = logP, logC' = logC, wN' = wN }

  def valueAt(g: int, t: int): int = commits.get(g).filter(c => c <= t).fold(0, (a, c) => max(a, c))
  def started(g: int): bool = moveOf(g) != 0 and mv.get(moveOf(g)).started
  def fenced(g: int): bool = moveOf(g) != 0 and mv.get(moveOf(g)).fenced
  def floorOf(g: int): int = if (moveOf(g) == 0) 0 else mv.get(moveOf(g)).floor
  // シャードが、自分のスナップショットで持つ区間。親は move-start を適用するまで持ち、子は move-start から持つ
  def ownP: Set[int] = G.filter(g => not(fenced(g)))
  def ownC: Set[int] = G.filter(g => started(g))
  // 行 r を、変更ログ es の、区間 g の T より後の確定で戻す
  pure def rolled(r: int, es: Set[Entry], g: int, t: int): int =
    val after = es.filter(e => e.g == g and e.c > t)
    if (after == Set()) r else after.fold({ g: g, c: 1000, before: NONE }, (a, e) => if (e.c < a.c) e else a).before

  // ---- 移動 ----
  action start(i: int): bool = all {
    rangeOf(i) != Set(), not(mv.get(i).started), i == 1 or mv.get(1).floor > 0,
    mv' = mv.setBy(i, x => { ...x, started: true }),
    now' = now, m' = m, arrived' = arrived, acked' = acked, img' = img, rd' = rd, keepRows,
  }
  action fence(i: int): bool = all {
    mv.get(i).started, not(mv.get(i).fenced),
    mv' = mv.setBy(i, x => { ...x, fenced: true }),
    now' = now, m' = m, arrived' = arrived, acked' = acked, img' = img, rd' = rd, keepRows,
  }
  action pull(g: int): bool = all {
    fenced(g), m.get(g) == 0,
    m' = m.set(g, now + 1), now' = now + 1, img' = img.set(g, rowP.get(g)),
    mv' = mv, arrived' = arrived, acked' = acked, rd' = rd, keepRows,
  }
  action recv(g: int): bool = all {
    m.get(g) > 0, not(arrived.get(g)),
    arrived' = arrived.set(g, true), rowC' = rowC.set(g, img.get(g)),
    now' = now, mv' = mv, m' = m, acked' = acked, img' = img, commits' = commits, rowP' = rowP, logP' = logP, logC' = logC, wN' = wN, rd' = rd,
  }
  // 親が、渡した行を本体の表から消す (渡した行としては残す)
  action ack(g: int): bool = all {
    arrived.get(g), not(acked.get(g)),
    acked' = acked.set(g, true), rowP' = rowP.set(g, NONE),
    now' = now, mv' = mv, m' = m, arrived' = arrived, img' = img, commits' = commits, rowC' = rowC, logP' = logP, logC' = logC, wN' = wN, rd' = rd,
  }
  // 範囲の移動を終える。範囲の床が決まる
  action finish(i: int): bool = all {
    mv.get(i).started, mv.get(i).floor == 0, rangeOf(i).forall(g => arrived.get(g)),
    mv' = mv.setBy(i, x => { ...x, floor: now + 1 }), now' = now + 1,
    m' = m, arrived' = arrived, acked' = acked, img' = img, rd' = rd, keepRows,
  }

  // ---- 書き込み ----
  action wWrite(g: int): bool = all {
    wN < WRITES_N,
    val c = now + 1
    if (not(fenced(g))) all {
      rowP' = rowP.set(g, c), logP' = logP.union(Set({ g: g, c: c, before: rowP.get(g) })), rowC' = rowC, logC' = logC,
      now' = c, wN' = wN + 1, commits' = commits.setBy(g, cs => cs.union(Set(c))), rd' = rd, keepMove,
    } else all {
      arrived.get(g),
      rowC' = rowC.set(g, c), logC' = logC.union(Set({ g: g, c: c, before: rowC.get(g) })), rowP' = rowP, logP' = logP,
      now' = c, wN' = wN + 1, commits' = commits.setBy(g, cs => cs.union(Set(c))), rd' = rd, keepMove,
    }
  }

  // ---- 読み ----
  action read(d: int, k: Set[int], t: int): bool = all {
    rd.st == R_NONE, t <= now,
    rd' = { ...noRead, st: R_PENDING, d: d, k: k, t: t },
    now' = now, keepMove, keepRows,
  }
  // 親が答える。親は最初からの持ち主なので、自分の行を、自分の変更ログで T まで戻す
  action serveP = all {
    rd.st == R_PENDING, rd.d == P,
    val k = rd.k
    val whole = k.subseteq(ownP)
    // 送り出している途中 (move-start を適用して、まだ ack していない区間がある)
    val outgoing = G.exists(g => fenced(g) and not(acked.get(g)))
    // BY_CLAIM でなければ、本体の表に残る行と、変更ログで戻った行を、全部答える
    val held = G.filter(g => rowP.get(g) != NONE or logP.exists(e => e.g == g and e.c > rd.t))
    val ans = if (BY_CLAIM) k.intersect(ownP) else held
    val rows = ans.map(g => { g: g, v: rolled(rowP.get(g), logP, g, rd.t) }).filter(p => p.v != NONE or k.contains(p.g))
    all {
      rd' = if (OWN_WHOLE and not(whole)) { ...rd, st: R_NOTOWNER }
            else if (outgoing and not(PARENT_ANSWERS)) { ...rd, st: R_MIGRATING }
            else { ...rd, st: R_ANSWERED, rows: rows, owned: whole, outgoing: outgoing },
      now' = now, keepMove, keepRows,
    }
  }
  // 子が答える
  def incoming(k: Set[int]): bool = k.exists(g => started(g) and floorOf(g) == 0)
  // claim の、いちばん新しい (古い) 受け取りの記録の床
  def newestFloor(k: Set[int]): int = k.fold(0, (a, g) => max(a, floorOf(g)))
  def oldestFloor(k: Set[int]): int = k.fold(1000, (a, g) => min(a, floorOf(g)))
  // 区間 g の閾値
  def threshold(g: int, k: Set[int]): int = if (SPLIT == 0) floorOf(g) else if (SPLIT == 1) newestFloor(k) else oldestFloor(k)
  // 前の持ち主の答え (渡した行を T まで戻したもの) に、子が床より前の c で適用した版 (残した版) の、T 以下のいちばん新しいものを重ねる
  def askedValue(g: int, t: int): int =
    val kept = logC.filter(e => e.g == g and e.c <= t and e.c < floorOf(g))
    if (kept != Set()) kept.fold(0, (a, e) => max(a, e.c)) else rolled(img.get(g), logP, g, t)
  action serveC = all {
    rd.st == R_PENDING, rd.d == C,
    val k = rd.k
    val whole = k.subseteq(ownC)
    val inc = incoming(k)
    val held = G.filter(g => rowC.get(g) != NONE)
    val ans = if (BY_CLAIM) k.intersect(ownC) else held
    val rows = ans.map(g => { g: g, v: if (rd.t < threshold(g, k)) askedValue(g, rd.t) else rolled(rowC.get(g), logC, g, rd.t) })
                  .filter(p => p.v != NONE or k.contains(p.g))
    all {
      // 受け取り中の範囲に掛かる claim は、受け取り終えるまで待つ
      not(OWN_WHOLE and whole and inc and WAIT == 1),
      rd' = if (OWN_WHOLE and not(whole)) { ...rd, st: R_NOTOWNER }
            else if (inc and WAIT == 0) { ...rd, st: R_MIGRATING }
            else { ...rd, st: R_ANSWERED, rows: rows, owned: whole, asked: ans.exists(g => rd.t < threshold(g, k)),
                   waited: rd.waited },
      now' = now, keepMove, keepRows,
    }
  }
  // 子が、受け取り終えるのを待っている (witness のための印)
  action waitC = all {
    rd.st == R_PENDING, rd.d == C, not(rd.waited), rd.k.subseteq(ownC), incoming(rd.k), WAIT == 1,
    rd' = { ...rd, waited: true },
    now' = now, keepMove, keepRows,
  }

  action moveStep = any {
    { nondet i = oneOf(MOVES) any { start(i), fence(i), finish(i) } },
    { nondet g = oneOf(G) any { pull(g), recv(g), ack(g) } },
  }
  action serveStep = any { serveP, serveC }
  action step = any {
    moveStep, serveStep, waitC,
    { nondet g = oneOf(G) wWrite(g) },
    { nondet d = oneOf(Set(P, C)) nondet k = oneOf(G.powerset()) nondet t = oneOf(0.to(8)) read(d, k, t) },
  }

  // ---- 不変条件 ----
  val answersClaim = rd.st != R_ANSWERED or rd.rows.map(p => p.g) == rd.k
  val answersAtT = rd.st != R_ANSWERED or rd.rows.forall(p => p.v == valueAt(p.g, rd.t))
  val answeredOwned = rd.st != R_ANSWERED or rd.owned
  val neverMigrating = rd.st != R_MIGRATING
  val m23hSafe = and { answersClaim, answersAtT, answeredOwned, neverMigrating }

  // ---- witness ----
  // 子が、1 つの claim の中で、ある区間は前の持ち主に尋ね、別の区間は自分の行で答える (受け取りの記録が 2 つ)
  val witnessSplitAnswer = not(rd.st == R_ANSWERED and rd.d == C and rd.asked
                               and rd.k.exists(g => rd.t >= floorOf(g)) and rd.k.exists(g => rd.t < floorOf(g)))
  // 子が、受け取り終えるのを待ってから答える
  val witnessWaitedThenAnswered = not(rd.st == R_ANSWERED and rd.waited)
  // 親が、送り出している途中に、残る区間の claim に答える
  val witnessParentDuringMove = not(rd.st == R_ANSWERED and rd.d == P and rd.outgoing and rd.k != Set())
  // 親が、まだ適用していない move-start を知っている Worker の、狭い claim に答える
  val witnessNarrowClaim = not(rd.st == R_ANSWERED and rd.d == P and rd.k != ownP and G.exists(g => started(g) and not(fenced(g))))

  // ---- 活性 ----
  val vars = (now, commits, mv, m, arrived, acked, img, rowP, rowC, logP, logC, wN, rd)
  temporal fairness = weakFair(moveStep, vars) and weakFair(serveStep, vars)
  temporal readEnds = fairness implies always(rd.st == R_PENDING implies eventually(rd.st != R_PENDING))
}

// ---- 規則 (緑) ----------------------------------------------------------------------------------------------------------

// 1 回の移動で、区間 1 と 2 が動く
module m23h_green {
  import m23h_core(OWN_WHOLE = true, BY_CLAIM = true, SPLIT = 0, WAIT = 1, PARENT_ANSWERS = true, SCENE = 0, WRITES_N = 2).*
  // 親が move-start を適用する前に、新しい範囲表の Worker が、親に区間 3 だけを聞く。親は、本体の表に 3 つの行を持つが、区間 3 だけを答える
  run narrowClaimTest =
    init.then(start(1))
        .then(read(P, Set(3), 0)).then(serveP)
        .expect(rd.st == R_ANSWERED and rd.rows == Set({ g: 3, v: 0 }) and m23hSafe and not(witnessNarrowClaim))
  // 子は、区間 1 だけが届いた間は待ち、受け取り終えてから、床より前の T の読みを親に尋ねて答える
  run waitTest =
    init.then(wWrite(2))                                                 // 区間 2 に時刻 1 の確定
        .then(start(1)).then(fence(1)).then(pull(1)).then(recv(1))       // 区間 1 が届く (m = 2)
        .then(read(C, Set(1, 2), 0)).then(waitC)
        .expect(rd.st == R_PENDING and rd.waited)
        .then(pull(2)).then(recv(2)).then(finish(1))                     // 区間 2 が届き (m = 3)、床 4
        .then(serveC)
        .expect(rd.st == R_ANSWERED and rd.rows == Set({ g: 1, v: 0 }, { g: 2, v: 0 }) and m23hSafe and not(witnessWaitedThenAnswered))
}
// 2 回の移動で、区間 1、区間 2 の順に動く (受け取りの記録が 2 つ)
module m23h_green2 {
  import m23h_core(OWN_WHOLE = true, BY_CLAIM = true, SPLIT = 0, WAIT = 1, PARENT_ANSWERS = true, SCENE = 1, WRITES_N = 2).*
  // T は、区間 1 の床以上で、区間 2 の床より小さい。子は、区間 1 を自分の行で、区間 2 を親に尋ねて答える
  run splitTest =
    init.then(start(1)).then(fence(1)).then(pull(1)).then(recv(1)).then(finish(1))    // m = 1、床 2
        .then(wWrite(1))                                                 // 子が区間 1 に時刻 3 で書く
        .then(wWrite(2))                                                 // 親が区間 2 に時刻 4 で書く
        .then(start(2)).then(fence(2)).then(pull(2)).then(recv(2)).then(finish(2))    // m = 5、床 6
        .then(read(C, Set(1, 2), 3)).then(serveC)
        .expect(rd.st == R_ANSWERED and rd.rows == Set({ g: 1, v: 3 }, { g: 2, v: 0 }) and m23hSafe and not(witnessSplitAnswer))
}
// 活性
module m23h_live {
  import m23h_core(OWN_WHOLE = true, BY_CLAIM = true, SPLIT = 0, WAIT = 1, PARENT_ANSWERS = true, SCENE = 0, WRITES_N = 1).*
}

// ---- 赤: 条件を 1 つずつ外す ----------------------------------------------------------------------------------------------

// 赤: 答える行を claim で絞らない。move-start を適用していない親が、動く区間の行も答える (子も、同じ行を答える)
module m23h_red_ignore_claim {
  import m23h_core(OWN_WHOLE = true, BY_CLAIM = false, SPLIT = 0, WAIT = 1, PARENT_ANSWERS = true, SCENE = 0, WRITES_N = 2).*
  run narrowClaimTest =
    init.then(start(1))
        .then(read(P, Set(3), 0)).then(serveP)
        .expect(rd.st == R_ANSWERED and rd.rows.size() == 3 and not(answersClaim))
  // 送り出して ack を待つ区間の行も、変更ログの before-image で戻った、渡した行も、答えに入る
  run handedRowsTest =
    init.then(wWrite(1))                                                 // 区間 1 に時刻 1 の確定
        .then(start(1)).then(fence(1)).then(pull(1)).then(recv(1)).then(ack(1))   // 親は区間 1 の行を消した
        .then(read(P, Set(3), 0)).then(serveP)                           // T = 0。区間 1 の確定の before-image が戻る
        .expect(rd.st == R_ANSWERED and rd.rows.exists(p => p.g == 1) and not(answersClaim))
}
// 赤: claim の一部しか持たなくても、持つ部分だけを答える (M18 の m18_red_partial_answer と同じ欠陥)
module m23h_red_partial {
  import m23h_core(OWN_WHOLE = false, BY_CLAIM = true, SPLIT = 0, WAIT = 1, PARENT_ANSWERS = true, SCENE = 0, WRITES_N = 2).*
  run partialTest =
    init.then(start(1)).then(fence(1))
        .then(read(P, G, 0)).then(serveP)                                // 古い範囲表の Worker が、親に全部を聞く
        .expect(rd.st == R_ANSWERED and rd.rows == Set({ g: 3, v: 0 }) and not(answersClaim) and not(answeredOwned))
}
// 赤: claim の全部を、いちばん新しい受け取りの記録の床で決める。床以上の T の区間まで親に尋ね、子の書き込みを落とす
module m23h_red_newest_floor {
  import m23h_core(OWN_WHOLE = true, BY_CLAIM = true, SPLIT = 1, WAIT = 1, PARENT_ANSWERS = true, SCENE = 1, WRITES_N = 2).*
  run lostChildWriteTest =
    init.then(start(1)).then(fence(1)).then(pull(1)).then(recv(1)).then(finish(1))    // 区間 1: m = 1、床 2
        .then(wWrite(1))                                                 // 子が区間 1 に時刻 3 で書く
        .then(start(2)).then(fence(2)).then(pull(2)).then(recv(2)).then(finish(2))    // 区間 2: m = 4、床 5
        .then(read(C, Set(1, 2), 3)).then(serveC)                        // T = 3 < 5。区間 1 も親に尋ねる
        .expect(rd.st == R_ANSWERED and rd.rows.contains({ g: 1, v: 0 }) and not(answersAtT))
}
// 赤: いちばん古い記録の床で決める。床より前の T の区間を、受け取った行で答える
module m23h_red_oldest_floor {
  import m23h_core(OWN_WHOLE = true, BY_CLAIM = true, SPLIT = 2, WAIT = 1, PARENT_ANSWERS = true, SCENE = 1, WRITES_N = 2).*
  run receivedRowTest =
    init.then(start(1)).then(fence(1)).then(pull(1)).then(recv(1)).then(finish(1))    // 床 2
        .then(wWrite(2))                                                 // 親が区間 2 に時刻 3 で書く
        .then(start(2)).then(fence(2)).then(pull(2)).then(recv(2)).then(finish(2))    // m = 4、床 5
        .then(read(C, Set(1, 2), 2)).then(serveC)                        // T = 2 は区間 1 の床以上。区間 2 も自分の行で答える
        .expect(rd.st == R_ANSWERED and rd.rows.contains({ g: 2, v: 3 }) and not(answersAtT))
}
// 赤: 受け取り中の子が、待たずに答える。まだ届いていない区間の行が落ちる
module m23h_red_no_wait {
  import m23h_core(OWN_WHOLE = true, BY_CLAIM = true, SPLIT = 0, WAIT = 2, PARENT_ANSWERS = true, SCENE = 0, WRITES_N = 2).*
  run missingRowTest =
    init.then(start(1)).then(fence(1)).then(pull(1)).then(recv(1))       // 区間 1 だけが届いた (m = 1)
        .then(read(C, Set(1, 2), 1)).then(serveC)
        .expect(rd.st == R_ANSWERED and not(answersAtT))
}
// 前のコード: 受け取り中の子と、送り出している親が、全表の読みを migrating で断る。答えは誤らないが、移動だけで文が失敗する
module m23h_red_child_migrating {
  import m23h_core(OWN_WHOLE = true, BY_CLAIM = true, SPLIT = 0, WAIT = 0, PARENT_ANSWERS = true, SCENE = 0, WRITES_N = 2).*
}
module m23h_red_parent_migrating {
  import m23h_core(OWN_WHOLE = true, BY_CLAIM = true, SPLIT = 0, WAIT = 1, PARENT_ANSWERS = false, SCENE = 0, WRITES_N = 2).*
}
