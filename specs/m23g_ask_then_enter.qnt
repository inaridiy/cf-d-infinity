// -*- mode: Bluespec; -*-
// M23g: 前の持ち主に尋ねてから同期区間に入る間に、範囲が戻ってくる。受け持った期間ごとに答える (未解決の問題 37 の続き)
//
// 2026-11-17 に書いた。実装より先に書いたモデルである。設計は docs/design-refresh-across-move.md の「3 回目の実装の規則」にある。
//
// 背景。M23、M23b、M23c の持ち主は、窓か読み取り時刻が、受け持ち始めた時刻より前なら、受け取りの記録の渡した側に尋ね、答えを
// 自分の記録と合わせる。M23c は、尋ねる列の答えを 1 手で作った。実装では、持ち主は、尋ねる先を受け取りの記録から決めて RPC を送り、
// 答えを待ってから、同期区間に入って自分の記録を読む。待つ間に、範囲は別のシャードへ動き、戻ってくることがある (C → D → C)。
// 戻った後の持ち主は、同期区間の入口の所有の確かめを通る。しかし、D が受け持っていた間の確定は、持ち主の記録にも、尋ねた列の答えにも
// ない。確定の検証はその確定を見落とし、古い読みは、D で適用された T 以下の版を落とす。
// 範囲が戻ると、1 つのシャードが同じ区間を 2 度受け持つ。M23c は、シャードの記録を確定の時刻 c で区切った (c < up)。pull に乗った
// intent は、受け持ち始めた時刻より小さい c で適用されるので、c では、どの期間に適用した確定か分からない。
//
// 規則。
//   RECHECK      持ち主は、同期区間の入口で、尋ねたときの受け取りの記録 (区間ごとの、移動の epoch) が、いまも自分のいちばん新しい
//                受け取りの記録であることを確かめる。違えば、いまの記録で尋ね直す。尋ね直す回数は、移動の数で抑えられる
//   HELD_WINDOW  シャードは、変更ログの行に、適用したときの時計 (at) を残す。前の持ち主として答えるときは、尋ねられた移動で手放した
//                期間に適用した確定だけを使う (土台を T まで戻すのにも、重ねる版にも)。期間は、受け取りを始めた時計から、次に受け取りを
//                始めた時計までである
//   BASE_ONLY    前の持ち主は、T にその区間を持っていた部分には、渡した行を T まで戻した土台だけを答え、版を重ねない。土台は、その
//                期間の T 以下の確定を全部含む。重ねる版は、受け持ち始める前の c で適用した版 (M23d の __kept) で、時刻を持たない土台に
//                勝つので、土台にある新しい確定を隠す
// 尋ねる列の答えは、ここでも 1 手で作るが、尋ねた後のいつでも作れる。同じ受け取りの記録についての答えは、いつ作っても同じである
// (answerStable)。前の持ち主の、終わった期間の記録は変わらないからで、これが、列をシャードごとの手に分けてよい理由である。
//
// 舞台。行 k が 1 つ。シャード P、C、D。k の範囲は、SHAPE の順に動く (0: P → C → P → C。1: P → C → D。2: P → C → D → C)。
// 移動は pull (手放す。m を決め、行と intent を応答に載せる) と recv (受け取る) の 2 手である。時計は 1 つで、確定と pull で進む。
// 書き手 W は autocommit で、持ち主の k を今の時刻で書く (intent があれば待つ)。Y は 2 相の取引で、持ち主で prepare し、anchor が c を
// 決め、phase 2 は遅れて、そのときの持ち主に届く (intent は pull に乗る)。
// 取引 X は、MODE 0 なら読むだけで、T を決めた後に k を T で読む。MODE 1 なら、k を読んで書き、確定の検証 (窓 (T, ∞)) を受ける。
// どちらも、持ち主は「尋ねる (ask)」「答えが届く (answer)」「同期区間に入る (enter)」の 3 手で答える。
//
// invariant
//   readConsistent        答えた読みは、時刻 T の、確定した版のうちいちばん新しいものである
//   serializable          確定した X の書き込みの前に、X が読んだ後の別の取引の確定はない
//   placementIndependent  X が失敗するのは、読んだ行が読んだ後に別の取引に書かれたか、その行に別の取引の intent があったときだけである
//   answerStable          同じ受け取りの記録についての、尋ねる列の答えは、作る時点に依らない
//   boundedReasks         尋ね直す回数は、移動の数以下である
//   boundedRefusals       X が NotOwner で断られる回数は、移動の数以下である
// temporal
//   xEnds                 X は、いつか確定するか失敗する
module m23g_core {
  // ---- 規則の条件。赤は 1 つずつ外す ----
  const RECHECK: bool
  const HELD_WINDOW: bool
  const BASE_ONLY: bool
  // ---- 場面 ----
  const SHAPE: int              // 0: P → C → P → C。1: P → C → D。2: P → C → D → C
  const MOVES_N: int
  const MODE: int               // 0: 読むだけの X。1: 読んで書く X (確定の検証)
  const HAS_Y: bool
  const WRITES_N: int

  pure val P = 1
  pure val C = 2
  pure val D = 3
  pure val SHARDS = Set(1, 2, 3)
  pure val MOVES = Set(1, 2, 3)
  pure val INF = 1000
  pure val FLYING = 8
  pure val APPLIED = 9
  // 書き手の名前 (行の値)。0 は最初の行
  pure val YW = 20
  pure val XW = 30
  pure val IDLE = 0
  pure val ACTIVE = 1
  pure val COMMITTED = 2
  pure val ABORTED = 3

  type Ver = { c: int, w: int }
  type Entry = { c: int, at: int, w: int, before: int }
  type Move = { m: int, arrived: bool, img: Ver, carry: bool }
  type Intent = { where: int, pts: int, c: int, pushed: int }
  // 持ち主の、1 つの要求の進み。ph: 0 なし、1 尋ねた (答えを待つ)、2 答えが届いた (同期区間に入れる)
  type Frame = { ph: int, o: int, rid: int, asked: bool, rows: Set[Ver], changed: bool }
  type Txn = { st: int, T: int, seen: Set[int], f: Frame }
  type Ghost = {
    bad: bool,                  // 答えた読みが、T の値と違う
    lost: bool,                 // X が、読んだ後の別の取引の確定を見ずに確定した
    why: bool,                  // X が失敗したとき、読んだ後の確定か、intent があった
    unstable: bool,             // 同じ受け取りの記録についての答えが、尋ねた後で変わった
    reasks: int, refusals: int,
    hops: int,                  // 読みに使った、尋ねる列の長さの最大
    overlaid: bool,             // 尋ね直した読みの答えが、ほかのシャードの期間に適用された版だった
  }

  var now: int
  var mv: int -> Move
  var row: int -> Ver
  var log: int -> Set[Entry]
  var vers: Set[Ver]              // ghost: 確定した版
  var y: Intent
  var wN: int
  var x: Txn
  var g: Ghost

  pure def max(a: int, b: int): int = if (a > b) a else b
  pure val noVer: Ver = { c: -2, w: -1 }
  pure val noMove: Move = { m: 0, arrived: false, img: noVer, carry: false }
  pure val noFrame: Frame = { ph: 0, o: 0, rid: 0, asked: false, rows: Set(), changed: false }
  pure def newest(vs: Set[Ver]): Ver = vs.fold(noVer, (acc, v) => if (v.c > acc.c) v else acc)
  // i 回の移動の後の持ち主
  pure def own(i: int): int =
    if (SHAPE == 0) (if (i == 0 or i == 2) P else C)
    else if (i == 0) P else if (i == 1) C else if (i == 2) D else C

  action init = all {
    now' = 0, mv' = MOVES.mapBy(_ => noMove),
    row' = SHARDS.mapBy(s => if (s == P) { c: 0, w: 0 } else noVer),
    log' = SHARDS.mapBy(_ => Set()), vers' = Set({ c: 0, w: 0 }),
    y' = { where: 0, pts: 0, c: 0, pushed: 0 }, wN' = 0,
    x' = { st: IDLE, T: 0, seen: Set(), f: noFrame },
    g' = { bad: false, lost: false, why: false, unstable: false, reasks: 0, refusals: 0, hops: 0, overlaid: false },
  }

  // ---- 受け持ちの期間 ----
  // 受け取り終えた移動の数。いまの受け持ちの期間の番号であり、いまの持ち主のいちばん新しい受け取りの記録 (移動の epoch) でもある
  def n: int = MOVES.filter(i => mv.get(i).arrived).fold(0, (a, i) => max(a, i))
  def flying: bool = MOVES.exists(i => mv.get(i).m > 0 and not(mv.get(i).arrived))
  def holder: int = if (flying) 0 else own(n)
  // 期間 j (移動 j の後、移動 j + 1 の前。受け持つのは own(j)) の始まりと終わり
  def m(j: int): int = if (j == 0) 0 else mv.get(j).m
  def endOf(j: int): int = if (j < 3 and mv.get(j + 1).m > 0) mv.get(j + 1).m else INF
  // own(j) が、期間 j に適用した確定。HELD_WINDOW でなければ、そのシャードの変更ログの全部
  def inPeriod(j: int): Set[Entry] =
    if (HELD_WINDOW) log.get(own(j)).filter(e => e.at >= m(j) and e.at < endOf(j)) else log.get(own(j))
  // 期間 j に適用した確定のうち、受け持ち始める前の c のもの (残した版。M23d の __kept) の、T 以下の版
  def overlay(j: int, t: int): Set[Ver] = inPeriod(j).filter(e => e.c < m(j) and e.c <= t).map(e => { c: e.c, w: e.w })
  // 行 r を、確定の集まり es の T より後の確定で戻す (T より後のいちばん古い確定の before-image)
  pure def rolled(r: Ver, es: Set[Entry], t: int): int =
    val after = es.filter(e => e.c > t)
    if (after == Set()) r.w else after.fold({ c: INF, at: 0, w: -1, before: -1 }, (acc, e) => if (e.c < acc.c) e else acc).before
  // 移動 e で手放した期間 (e - 1) を、T に持っていたシャードの答え。土台 (時刻を持たない) と、BASE_ONLY でなければ残した版
  def heldRows(e: int, t: int): Set[Ver] =
    Set({ c: -1, w: rolled(mv.get(e).img, inPeriod(e - 1), t) }).union(if (BASE_ONLY) Set() else overlay(e - 1, t))
  // 移動 e で渡した側から始まる、尋ねる列の答え。T が期間の始まりより前なら、さらに前へ尋ね、その期間の残した版を重ねる
  def rows1(t: int): Set[Ver] = heldRows(1, t)
  def rows2(t: int): Set[Ver] = if (t < m(1)) rows1(t).union(overlay(1, t)) else heldRows(2, t)
  def rows3(t: int): Set[Ver] = if (t < m(2)) rows2(t).union(overlay(2, t)) else heldRows(3, t)
  def rowsFor(e: int, t: int): Set[Ver] = if (e == 1) rows1(t) else if (e == 2) rows2(t) else rows3(t)
  def hopsFor(e: int, t: int): int = if (e >= 2 and t < m(e - 1)) (if (e == 3 and t < m(1)) 3 else 2) else 1
  // 確かめ (M23b の規則)。尋ねられたシャードは、自分の記録の (lo, up] を見て、lo が期間の始まりより前なら、さらに前へ尋ねる
  def chg(s: int, lo: int, hi: int): bool = log.get(s).exists(e => e.w != XW and e.c > lo and e.c <= hi)
  def chain1(lo: int): bool = chg(own(0), lo, m(1))
  def chain2(lo: int): bool = chg(own(1), lo, m(2)) or (lo < m(1) and chain1(lo))
  def chain3(lo: int): bool = chg(own(2), lo, m(3)) or (lo < m(2) and chain2(lo))
  def chainFor(e: int, lo: int): bool = if (e == 1) chain1(lo) else if (e == 2) chain2(lo) else chain3(lo)

  def truth(t: int): int = newest(vers.filter(v => v.c <= t)).w
  def yOpen: bool = y.where >= 1 and y.where <= 3
  def yAt(s: int): bool = y.where == s

  // ---- 書き手 ----
  action wWrite = all {
    wN < WRITES_N, holder != 0, not(yAt(holder)),
    val h = holder
    val c = now + 1
    val v = { c: c, w: 11 + wN }
    all {
      now' = c, wN' = wN + 1,
      log' = log.setBy(h, es => es.union(Set({ c: c, at: c, w: v.w, before: row.get(h).w }))),
      row' = row.set(h, v), vers' = vers.union(Set(v)),
      mv' = mv, y' = y, x' = x, g' = g,
    }
  }
  action yPrepare = all {
    HAS_Y, y.where == 0, holder != 0,
    now' = now + 1, y' = { where: holder, pts: now + 1, c: 0, pushed: 0 },
    mv' = mv, row' = row, log' = log, vers' = vers, wN' = wN, x' = x, g' = g,
  }
  // anchor が c を決める。prepare の時刻以上で、push された時刻より大きく、今の時計以下である。この時点で Y は確定している
  action yDecide(c: int): bool = all {
    y.where != 0, y.where != APPLIED, y.c == 0, c >= y.pts, c > y.pushed, c <= now,
    y' = y.with("c", c), vers' = vers.union(Set({ c: c, w: YW })),
    now' = now, mv' = mv, row' = row, log' = log, wN' = wN, x' = x, g' = g,
  }
  // phase 2 は、いまの持ち主に届く (intent は pull で持ち主へ運ばれる)。飛んでいる間は届かない
  action yPhase2 = all {
    yOpen, y.c > 0,
    val s = y.where
    all {
      log' = log.setBy(s, es => es.union(Set({ c: y.c, at: now, w: YW, before: row.get(s).w }))),
      row' = row.set(s, { c: y.c, w: YW }),
      y' = y.with("where", APPLIED),
      now' = now, mv' = mv, vers' = vers, wN' = wN, x' = x, g' = g,
    }
  }

  // ---- 移動 ----
  // 持ち主が手放す。渡した行は、渡した側に残す (M23c の保持)
  action pull(i: int): bool = all {
    i <= MOVES_N, i == n + 1, not(flying), mv.get(i).m == 0,
    val s = own(i - 1)
    all {
      now' = now + 1,
      mv' = mv.set(i, { m: now + 1, arrived: false, img: row.get(s), carry: yAt(s) }),
      row' = row.set(s, noVer),
      y' = if (yAt(s)) y.with("where", FLYING) else y,
      log' = log, vers' = vers, wN' = wN, x' = x, g' = g,
    }
  }
  action recv(i: int): bool = all {
    mv.get(i).m > 0, not(mv.get(i).arrived),
    mv' = mv.set(i, mv.get(i).with("arrived", true)),
    row' = row.set(own(i), mv.get(i).img),
    y' = if (y.where == FLYING) y.with("where", own(i)) else y,
    now' = now, log' = log, vers' = vers, wN' = wN, x' = x, g' = g,
  }

  // ---- 取引 X ----
  // MODE 0: T を決める (読みは後)。MODE 1: 持ち主の k を今の時刻で読む
  action xBegin = all {
    x.st == IDLE,
    if (MODE == 0) all {
      x' = { st: ACTIVE, T: now, seen: Set(), f: noFrame }, y' = y,
    } else all {
      holder != 0, not(yAt(holder) and y.c > 0),
      x' = { st: ACTIVE, T: now, seen: Set(row.get(holder).w), f: noFrame },
      y' = if (yAt(holder)) y.with("pushed", max(y.pushed, now)) else y,
    },
    now' = now, mv' = mv, row' = row, log' = log, vers' = vers, wN' = wN, g' = g,
  }
  // 持ち主 o が、受け取りの記録 rid (いまの期間の番号) から、尋ねるかどうかを決める。x.T は、読みでは読み取り時刻、確かめでは窓の下限
  def frameFor(o: int, rid: int): Frame =
    val asked = rid >= 1 and x.T < m(rid)
    { ph: if (asked) 1 else 2, o: o, rid: rid, asked: asked, rows: Set(), changed: false }
  action xAsk = all {
    x.st == ACTIVE, x.f.ph == 0, holder != 0, MODE == 1 or x.seen == Set(),
    x' = x.with("f", frameFor(holder, n)),
    now' = now, mv' = mv, row' = row, log' = log, vers' = vers, y' = y, wN' = wN, g' = g,
  }
  // 尋ねる列の答えが届く。尋ねた後のいつでもよい
  action xAnswer = all {
    x.f.ph == 1,
    x' = x.with("f", { ...x.f, ph: 2, rows: if (MODE == 0) rowsFor(x.f.rid, x.T) else Set(), changed: MODE == 1 and chainFor(x.f.rid, x.T) }),
    now' = now, mv' = mv, row' = row, log' = log, vers' = vers, y' = y, wN' = wN, g' = g,
  }
  // 同期区間に入る
  action xEnter = all {
    x.st == ACTIVE, x.f.ph == 2,
    val o = x.f.o
    val f = x.f
    if (holder != o) all {
      // 持ち主でなくなった。NotOwner で断り、Worker は、いまの持ち主へ送り直す
      x' = x.with("f", noFrame), g' = g.with("refusals", g.refusals + 1),
      now' = now, mv' = mv, row' = row, log' = log, vers' = vers, y' = y, wN' = wN,
    } else if (RECHECK and n != f.rid) all {
      // 受け取りの記録が、尋ねたときのものでない (範囲が戻ってきた)。いまの記録で尋ね直す
      x' = x.with("f", frameFor(o, n)), g' = g.with("reasks", g.reasks + 1),
      now' = now, mv' = mv, row' = row, log' = log, vers' = vers, y' = y, wN' = wN,
    } else if (MODE == 0) all {
      // 古い読み。intent は持ち主だけが扱う (c が決まっていなければ T より上へ push し、決まって T 以下なら適用を待つ)
      not(yAt(o) and y.c > 0 and y.c <= x.T),
      val all0 = f.rows.union(overlay(n, x.T))
      val v = if (f.asked) newest(all0).w else rolled(row.get(o), inPeriod(n), x.T)
      all {
        x' = { ...x, st: COMMITTED, seen: Set(v), f: noFrame },
        y' = if (yAt(o) and y.c == 0 and y.pts <= x.T) y.with("pushed", max(y.pushed, x.T)) else y,
        g' = { ...g, bad: g.bad or v != truth(x.T),
               unstable: g.unstable or (f.asked and n == f.rid and f.rows != rowsFor(f.rid, x.T)),
               hops: if (f.asked) max(g.hops, hopsFor(f.rid, x.T)) else g.hops,
               overlaid: g.overlaid or (f.asked and g.reasks > 0 and f.rows.exists(r => r.c >= 0 and r.w == v)) },
        now' = now, mv' = mv, row' = row, log' = log, vers' = vers, wN' = wN,
      }
    } else all {
      // 確定の検証。自分の記録を下限から見て、尋ねた答えと合わせる。重なる intent があれば競合
      val changed = chg(o, x.T, INF) or (f.asked and f.changed)
      val ok = not(changed) and not(yAt(o))
      val c = now + 1
      all {
        x' = { ...x, st: if (ok) COMMITTED else ABORTED, f: noFrame },
        now' = if (ok) c else now,
        log' = if (ok) log.setBy(o, es => es.union(Set({ c: c, at: c, w: XW, before: row.get(o).w }))) else log,
        row' = if (ok) row.set(o, { c: c, w: XW }) else row,
        vers' = if (ok) vers.union(Set({ c: c, w: XW })) else vers,
        g' = { ...g, lost: g.lost or (ok and vers.exists(v => v.c > x.T)),
               why: g.why or (not(ok) and (vers.exists(v => v.c > x.T) or yOpen)) },
        mv' = mv, y' = y, wN' = wN,
      }
    }
  }

  action xStep = any { xBegin, xAsk, xAnswer, xEnter }
  action step = any {
    xStep, wWrite, yPrepare, yPhase2,
    { nondet c = oneOf(1.to(8)) yDecide(c) },
    { nondet i = oneOf(MOVES) any { pull(i), recv(i) } },
  }

  // ---- 不変条件 ----
  val readConsistent = not(g.bad)
  val serializable = not(g.lost)
  val placementIndependent = x.st != ABORTED or g.why
  val answerStable = not(g.unstable)
  val boundedReasks = g.reasks <= MOVES_N
  val boundedRefusals = g.refusals <= MOVES_N
  val m23gSafe = and { readConsistent, serializable, placementIndependent, answerStable, boundedReasks, boundedRefusals }

  // ---- witness ----
  // 尋ねてから同期区間に入るまでに範囲が戻り、尋ね直して、X が終わった
  val witnessReasked = not(x.st == COMMITTED and g.reasks > 0)
  // 尋ね直した読みの答えが、ほかのシャードが受け持っていた間に、受け持ち始める前の c で適用された版だった
  val witnessOverlaidAfterReask = not(x.st == COMMITTED and g.overlaid)
  // 3 つの期間をさかのぼる読みがあった
  val witnessThreeHops = not(x.st == COMMITTED and g.hops == 3)
  // 尋ね直した確かめが、ほかのシャードが受け持っていた間の確定を見つけて、X が競合で失敗した
  val witnessConflictAfterReask = not(x.st == ABORTED and g.reasks > 0 and g.why)

  // ---- 活性 ----
  val vars = (now, mv, row, log, vers, y, wN, x, g)
  temporal fairness = and {
    weakFair(xStep, vars), weakFair(yPhase2, vars),
    weakFair(recv(1), vars), weakFair(recv(2), vars), weakFair(recv(3), vars),
  }
  temporal xEnds = fairness implies eventually(x.st == COMMITTED or x.st == ABORTED)
}

// ---- 規則 (緑) ----------------------------------------------------------------------------------------------------------

// 読むだけの X。範囲が P → C → P → C と動く。書き手 W 2 つと Y
module m23g_green_read {
  import m23g_core(RECHECK = true, HELD_WINDOW = true, BASE_ONLY = true, SHAPE = 0, MOVES_N = 3, MODE = 0, HAS_Y = true, WRITES_N = 2).*
  // 尋ねてから入るまでに、Y の intent が P へ戻って適用され、範囲が C へ戻ってくる。入口の確かめが尋ね直し、P の 2 度目の期間の
  // 残した版 (Y、c = 1) が答えになる
  run reaskTest =
    init.then(yPrepare)                                                  // pts 1
        .then(xBegin)                                                    // T = 1
        .then(pull(1)).then(recv(1))                                     // m1 = 2。intent は C へ
        .then(xAsk).then(xAnswer)                                        // C は P に尋ねる (記録 1)。答えは最初の行
        .expect(x.f.rid == 1 and x.f.rows == Set({ c: -1, w: 0 }))
        .then(pull(2)).then(recv(2))                                     // m2 = 3。範囲と intent は P へ戻る
        .then(yDecide(1)).then(yPhase2)                                  // Y は c = 1 で、P の 2 度目の期間に適用される
        .then(pull(3)).then(recv(3))                                     // m3 = 4。範囲は C へ
        .then(xEnter)                                                    // 記録が 1 から 3 に替わっている。尋ね直す
        .expect(x.f.rid == 3 and x.f.ph == 1 and g.reasks == 1)
        .then(xAnswer).then(xEnter)
        .expect(x.st == COMMITTED and x.seen == Set(YW) and m23gSafe and not(witnessOverlaidAfterReask) and g.hops == 3)
}
// 読んで書く X (確定の検証)
module m23g_green_validate {
  import m23g_core(RECHECK = true, HELD_WINDOW = true, BASE_ONLY = true, SHAPE = 0, MOVES_N = 3, MODE = 1, HAS_Y = true, WRITES_N = 2).*
  // 尋ねてから入るまでに、P が 2 度目の期間に W を確定する。尋ね直した確かめが W を見つける
  run reaskTest =
    init.then(xBegin)                                                    // T = 0。最初の行を読む
        .then(pull(1)).then(recv(1))                                     // m1 = 1
        .then(xAsk).then(xAnswer)                                        // C は P に (0, 1] を尋ねる。変更なし
        .then(pull(2)).then(recv(2)).then(wWrite)                        // 範囲は P へ戻り、W が c = 3 で確定する
        .then(pull(3)).then(recv(3))                                     // m3 = 4
        .then(xEnter).then(xAnswer).then(xEnter)
        .expect(x.st == ABORTED and m23gSafe and not(witnessConflictAfterReask))
}
// 範囲が P → C → D → C と動く形 (別のシャードを回って戻る)
module m23g_green_read_d {
  import m23g_core(RECHECK = true, HELD_WINDOW = true, BASE_ONLY = true, SHAPE = 2, MOVES_N = 3, MODE = 0, HAS_Y = true, WRITES_N = 2).*
}
module m23g_green_validate_d {
  import m23g_core(RECHECK = true, HELD_WINDOW = true, BASE_ONLY = true, SHAPE = 2, MOVES_N = 3, MODE = 1, HAS_Y = true, WRITES_N = 2).*
}
// 範囲が前の持ち主へ戻らなければ (P → C → D)、入口の確かめがなくても破れない。持ち主でなくなったシャードは、入口で NotOwner を返す
module m23g_forward_no_recheck {
  import m23g_core(RECHECK = false, HELD_WINDOW = true, BASE_ONLY = true, SHAPE = 1, MOVES_N = 2, MODE = 0, HAS_Y = true, WRITES_N = 2).*
}
module m23g_forward_no_recheck_validate {
  import m23g_core(RECHECK = false, HELD_WINDOW = true, BASE_ONLY = true, SHAPE = 1, MOVES_N = 2, MODE = 1, HAS_Y = true, WRITES_N = 2).*
}

// ---- 赤: 条件を 1 つずつ外す ----------------------------------------------------------------------------------------------

// 赤: 入口で受け取りの記録を確かめない (2 回目の実装)。古い読みが、ほかの期間に適用された T 以下の版を落とす
module m23g_red_no_recheck {
  import m23g_core(RECHECK = false, HELD_WINDOW = true, BASE_ONLY = true, SHAPE = 0, MOVES_N = 3, MODE = 0, HAS_Y = true, WRITES_N = 1).*
  run staleAnswerTest =
    init.then(yPrepare).then(xBegin)                                     // T = 1
        .then(pull(1)).then(recv(1))
        .then(xAsk).then(xAnswer)
        .then(pull(2)).then(recv(2)).then(yDecide(1)).then(yPhase2)
        .then(pull(3)).then(recv(3))
        .then(xEnter)                                                    // 尋ね直さず、前の答え (最初の行) に、自分の期間の版を重ねる
        .expect(x.seen == Set(0) and not(readConsistent))
}
// 赤: 同上、確定の検証。ほかの期間の確定を見落として、X が確定する
module m23g_red_no_recheck_validate {
  import m23g_core(RECHECK = false, HELD_WINDOW = true, BASE_ONLY = true, SHAPE = 0, MOVES_N = 3, MODE = 1, HAS_Y = false, WRITES_N = 1).*
  run lostUpdateTest =
    init.then(xBegin)
        .then(pull(1)).then(recv(1))
        .then(xAsk).then(xAnswer)
        .then(pull(2)).then(recv(2)).then(wWrite)
        .then(pull(3)).then(recv(3))
        .then(xEnter)
        .expect(x.st == COMMITTED and not(serializable))
}
// 赤: 同上、範囲が D を回って戻る形 (P → C → D → C)
module m23g_red_no_recheck_d {
  import m23g_core(RECHECK = false, HELD_WINDOW = true, BASE_ONLY = true, SHAPE = 2, MOVES_N = 3, MODE = 1, HAS_Y = false, WRITES_N = 1).*
}

// 赤: 前の持ち主が、受け持った期間で区切らず、自分の変更ログの全部で土台を戻す。後の期間の確定の before-image で、前の期間の行を戻す
module m23g_red_no_window {
  import m23g_core(RECHECK = true, HELD_WINDOW = false, BASE_ONLY = true, SHAPE = 0, MOVES_N = 3, MODE = 0, HAS_Y = false, WRITES_N = 2).*
  run laterBeforeImageTest =
    init.then(xBegin)                                                    // T = 0
        .then(pull(1)).then(recv(1)).then(wWrite)                        // m1 = 1。C が W1 を c = 2 で確定する
        .then(pull(2)).then(recv(2)).then(wWrite)                        // m2 = 3。P が W2 を c = 4 で確定する (before-image は W1)
        .then(pull(3)).then(recv(3))                                     // m3 = 5
        .then(xAsk).then(xAnswer).then(xEnter)                           // P は、最初の期間の行を、W2 の before-image (W1) で戻す
        .expect(x.seen == Set(11) and not(readConsistent))
}

// 赤: 前の持ち主が、T に持っていた部分にも、残した版を重ねる。受け持ち始める前の c の版が、土台にある新しい確定を隠す
module m23g_red_held_overlaid {
  import m23g_core(RECHECK = true, HELD_WINDOW = true, BASE_ONLY = false, SHAPE = 1, MOVES_N = 2, MODE = 0, HAS_Y = true, WRITES_N = 1).*
  run oldVersionWinsTest =
    init.then(yPrepare)                                                  // pts 1
        .then(pull(1)).then(recv(1))                                     // m1 = 2。intent は C へ
        .then(yDecide(1)).then(yPhase2)                                  // C が Y を c = 1 (< m1) で適用する (残した版)
        .then(wWrite)                                                    // C が W1 を c = 3 で確定する
        .then(xBegin)                                                    // T = 3
        .then(pull(2)).then(recv(2))                                     // m2 = 4
        .then(xAsk).then(xAnswer).then(xEnter)                           // D は C に尋ねる。C は T = 3 に持っていた。土台は W1
        .expect(x.seen == Set(YW) and not(readConsistent))               // 残した版 Y (c = 1) が、時刻のない土台に勝つ
}

// 活性
module m23g_live {
  import m23g_core(RECHECK = true, HELD_WINDOW = true, BASE_ONLY = true, SHAPE = 0, MOVES_N = 3, MODE = 0, HAS_Y = true, WRITES_N = 0).*
}
