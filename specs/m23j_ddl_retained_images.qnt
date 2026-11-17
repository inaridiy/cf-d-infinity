// -*- mode: Bluespec; -*-
// M23j: 残した行イメージと表定義の変更。表ごとの epoch の下で、古い読みが表定義の変更をまたぐ (未解決の問題 37 と 53 の境目)
//
// 2026-11-17 に書いた。実装より先に書いたモデルである。設計は docs/design-refresh-across-move.md の「3 回目の実装の規則」にある。
//
// 背景。古い読み (M23c) のために、シャードは、行イメージを 2 か所に残す。渡した行 (前の持ち主が、手放した区間の行を残す) と、
// 残した版 (持ち主が、受け持ち始める前の c で適用した確定の after-image を残す。M23d) である。どちらも、表定義の変更の前の形の
// イメージであり得る。変更ログの行イメージも前の形だが、これは表定義の変更の床 (ddlFloor) が守る。床より前の T の読みは、前の形の
// before-image を新しい形の表に戻すことになるので、断る (M24 の m24_floor)。
// 2 回目の実装は、床を緩めた。変更ログに確定のないシャードは、表定義の変更の commit を適用しても床を上げない。分割で生まれた子が、
// 生まれたときに表定義の記録を全部適用して床を上げ、生まれる前の T の読みを、どれも断ったからである。緩めた後は、残したイメージに、
// 床を通らずに届く読みがある。
//
// 表定義の版の規則は、M24 (m24_table_epochs.qnt) のものである。ここでは、次の形で置いた。
//   表は読みの epoch を持ち、その表の読みが返すものを変える DDL の commit でだけ進む (prepare では進まない)。
//   要求は、計画が頼る表の epoch を運ぶ。シャードは、要求のほうが新しければ commit を適用してから答え、古ければ断る。
//   取引が断られるのは、頼る表を変える DDL が、計画の後に commit されたときだけである (置き場所では決まらない)。
// 取引の読み取り時刻 T は、計画の epoch と別に決まる。T は、取引の最初の読みを受けたシャードの時計なので、DDL の後の計画の取引が、
// 別のシャードが commit を適用した時刻より小さい T を持つことは、時計のずれだけで起きる。モデルの T は、今の時計以下の任意の値である。
//
// 規則。
//   RESHAPE      シャードは、表定義の変更の commit を、本体の表と同じ書き込みで、渡した行と残した版にも当てる (RENAME TO は名前を
//                付け替え、DROP TABLE は行を消し、ADD COLUMN は既定の値を足す)
//   CHAIN_EPOCH  持ち主から前の持ち主への尋ねも、計画が頼る表の epoch を運ぶ。前の持ち主は、Worker の要求と同じく、自分が
//                古ければ commit を適用してから答え、要求が古ければ断る
//   FLOOR        表定義の変更の commit を適用したシャードが、その表の床を置く値
//                  1  変更ログに、その表の確定がなければ置かない。あれば、適用した時刻 (2 回目の実装の規則)
//                  3  変更ログにある、その表の確定の時刻の最大 (なければ置かない)。前の形の before-image を戻す読みだけを断る
//                  0  赤: いつも、適用した時刻 (1 回目の実装より前)。変更ログに確定のないシャードも、適用した時刻より前の T を断る
//                  2  赤: 置かない
//
// 舞台。表 A の行が 1 つ。シャード P が持ち、C へ動くことがある (pull と recv)。時計は 1 つ。DDL は 1 つで、KIND で選ぶ。
//   1 RENAME TO (A を A' にする)。行は変わらない。DDL の後の計画は A' を読む
//   2 DROP TABLE A の後に、同じ名前で CREATE TABLE A (取引の中の作り直し)。DDL の後の計画が読むのは新しい A で、前の A の行は
//     1 つも見えてはならない
//   3 ADD COLUMN。行の値は変わらず、行イメージの形だけが変わる
// DDL は、Meta が prepare を記録し、各シャードが (intent を決着させてから) 適用して書き込みを止め、Meta が commit を記録し、各シャードが
// commit を、それぞれの時刻に適用する。移動と DDL の遷移は重ならない (M21)。子は、行を受け取るときに、親の表定義に追いつく。
// 書き手 W は autocommit で、持ち主の行を、シャードのいまの表定義で書く。Y は、DDL の前に P で prepare する 2 相の取引で、intent は
// pull に乗り、持ち主が受け持ち始める前の c で適用することがある (残した版になる)。
// 取引 X は読むだけで、計画の epoch (DDL の前か後) と T を決め、行を 1 回読む。
//
// invariant
//   readAtT          答えた読みは、X の計画の表の、時刻 T の値である
//   noRestoreAcross  表定義の変更の前の形の before-image を、後の形の計画の読みに戻さない (逆も)
//   imagesMatch      読みに使った残したイメージの形は、X の計画の形である (ADD COLUMN。値は変わらないので、答えでは見えない)
//   floorNeeded      床が読みを断るのは、その読みが、計画と違う形の before-image を戻すことになるときだけである
module m23j_core {
  const KIND: int
  const RESHAPE: bool
  const CHAIN_EPOCH: bool
  const FLOOR: int
  const HAS_Y: bool
  const WRITES_N: int
  const GCS: int

  pure val P = 1
  pure val C = 2
  pure val SHARDS = Set(1, 2)
  pure val NONE = -1
  pure val FLYING = 8
  pure val APPLIED = 9
  pure val RENAME = 1
  pure val RECREATE = 2
  pure val ADDCOL = 3
  pure val YW = 20
  // X の状態
  pure val IDLE = 0
  pure val ACTIVE = 1
  pure val DONE = 2
  pure val FAILED = 3
  // X が断られた理由
  pure val WHY_SCHEMA = 1       // 計画が古い (頼る表を変える DDL が、計画の後に commit された)
  pure val WHY_OLD = 2          // T が logLowWater より古い (資源の限り)
  pure val WHY_FLOOR = 3        // T が表定義の変更の床より古い

  // tag: 0 は表定義の変更の前の形 (RENAME では前の名前、作り直しでは前の表)、1 は後の形。w = NONE は行なし
  type Img = { tag: int, w: int }
  type Entry = { c: int, w: int, before: int, tag: int }
  type Ver = { c: int, w: int, tag: int }
  type Intent = { where: int, pts: int, c: int, pushed: int }
  type Txn = { st: int, pe: int, T: int, seen: int }
  type Ghost = {
    bad: bool, restored: bool, mismatch: bool, floorUnneeded: bool, why: int,
    handedReshaped: bool,       // P が、渡した行に表定義の変更を当てた
    keptReshaped: bool,         // C が、残した版に表定義の変更を当てた
    usedHanded: bool,           // 読みの答えが、表定義の変更を当てた渡した行だった
    usedKept: bool,             // 読みの答えが、表定義の変更を当てた残した版だった
    formerBelow: bool,          // 前の持ち主が、自分が commit を適用した時刻より小さい T の、DDL の後の計画の古い読みに答えた
    childBelow: bool,           // 行を受け取った子が、自分が commit を適用した時刻より小さい T の読みに、本体の表で答えた
  }

  var now: int
  var d: int                      // DDL の進み。0 まだ、1 prepare を記録した、2 commit を記録した
  var ep: int -> int              // シャード -> 適用したところ (0、1 prepare、2 commit)
  var appliedAt: int -> int       // ghost: シャード -> commit を適用した時刻
  var floor: int -> int           // シャード -> 表 A の床
  var low: int -> int             // シャード -> logLowWater
  var gcs: int
  var log: int -> Set[Entry]
  var row: int -> Img             // シャード -> 本体の表の行
  var mvd: int                    // 0 移動の前、1 手放した (飛んでいる)、2 届いた
  var m: int
  var handed: Img                 // P が残した、渡した行
  var kept: Set[Ver]              // C が残した版 (受け持ち始める前の c で適用した確定)
  var y: Intent
  var wN: int
  var vers: Set[Ver]              // ghost: 確定した版
  var x: Txn
  var g: Ghost

  pure def max(a: int, b: int): int = if (a > b) a else b
  pure val noRow: Img = { tag: 0, w: NONE }

  action init = all {
    now' = 0, d' = 0, ep' = SHARDS.mapBy(_ => 0), appliedAt' = SHARDS.mapBy(_ => 0),
    floor' = SHARDS.mapBy(_ => 0), low' = SHARDS.mapBy(_ => 0), gcs' = 0,
    log' = SHARDS.mapBy(_ => Set()),
    row' = Map(P -> { tag: 0, w: 0 }, C -> noRow),
    mvd' = 0, m' = 0, handed' = noRow, kept' = Set(),
    y' = { where: 0, pts: 0, c: 0, pushed: 0 }, wN' = 0,
    vers' = Set({ c: 0, w: 0, tag: 0 }),
    x' = { st: IDLE, pe: 0, T: 0, seen: NONE },
    g' = { bad: false, restored: false, mismatch: false, floorUnneeded: false, why: 0, handedReshaped: false, keptReshaped: false,
           usedHanded: false, usedKept: false, formerBelow: false, childBelow: false },
  }
  action keepDdl = all { d' = d, ep' = ep, appliedAt' = appliedAt, floor' = floor }
  action keepGc = all { low' = low, gcs' = gcs }
  action keepMove = all { mvd' = mvd, m' = m, handed' = handed }

  def holder: int = if (mvd == 0) P else if (mvd == 1) 0 else C
  def yAt(s: int): bool = y.where == s
  def yOpen: bool = y.where == P or y.where == C or y.where == FLYING

  // ---- 書き手 ----
  // W は、持ち主の行を、シャードのいまの表定義で書く。prepare を適用して commit を適用していないシャードは、書き込みを断る
  action wWrite = all {
    wN < WRITES_N, holder != 0, ep.get(holder) != 1, not(yAt(holder)),
    val h = holder
    val c = now + 1
    val tag = if (ep.get(h) == 2) 1 else 0
    val w = 11 + wN
    all {
      now' = c, wN' = wN + 1,
      log' = log.setBy(h, es => es.union(Set({ c: c, w: w, before: row.get(h).w, tag: tag }))),
      row' = row.set(h, { tag: tag, w: w }),
      vers' = vers.union(Set({ c: c, w: w, tag: tag })),
      kept' = kept, y' = y, x' = x, g' = g, keepDdl, keepGc, keepMove,
    }
  }
  // Y は、DDL の前に、P で prepare する
  action yPrepare = all {
    HAS_Y, y.where == 0, d == 0, mvd == 0,
    now' = now + 1, y' = { where: P, pts: now + 1, c: 0, pushed: 0 },
    log' = log, row' = row, kept' = kept, wN' = wN, vers' = vers, x' = x, g' = g, keepDdl, keepGc, keepMove,
  }
  action yDecide(c: int): bool = all {
    yOpen, y.c == 0, c >= y.pts, c > y.pushed, c <= now,
    y' = y.with("c", c), vers' = vers.union(Set({ c: c, w: YW, tag: 0 })),
    now' = now, log' = log, row' = row, kept' = kept, wN' = wN, x' = x, g' = g, keepDdl, keepGc, keepMove,
  }
  // phase 2 は、そのときの持ち主に届く。intent のある間、そのシャードは prepare を適用しないので、適用するのは前の形である。
  // C が、受け持ち始める前の c で適用した版は、残す (M23d)
  action yPhase2 = all {
    y.where == P or y.where == C, y.c > 0,
    val s = y.where
    all {
      log' = log.setBy(s, es => es.union(Set({ c: y.c, w: YW, before: row.get(s).w, tag: 0 }))),
      row' = row.set(s, { tag: row.get(s).tag, w: YW }),
      kept' = if (s == C and y.c < m) kept.union(Set({ c: y.c, w: YW, tag: 0 })) else kept,
      y' = y.with("where", APPLIED),
      now' = now, wN' = wN, vers' = vers, x' = x, g' = g, keepDdl, keepGc, keepMove,
    }
  }

  // ---- 表定義の変更 ----
  action prepareOp = all {
    d == 0, mvd != 1,
    d' = 1,
    now' = now, ep' = ep, appliedAt' = appliedAt, floor' = floor, log' = log, row' = row, kept' = kept, y' = y, wN' = wN, vers' = vers,
    x' = x, g' = g, keepGc, keepMove,
  }
  action applyPrepare(s: int): bool = all {
    d >= 1, ep.get(s) == 0, not(yAt(s)),
    ep' = ep.set(s, 1),
    now' = now, d' = d, appliedAt' = appliedAt, floor' = floor, log' = log, row' = row, kept' = kept, y' = y, wN' = wN, vers' = vers,
    x' = x, g' = g, keepGc, keepMove,
  }
  action commitOp = all {
    d == 1, SHARDS.forall(s => ep.get(s) >= 1),
    d' = 2,
    now' = now, ep' = ep, appliedAt' = appliedAt, floor' = floor, log' = log, row' = row, kept' = kept, y' = y, wN' = wN, vers' = vers,
    x' = x, g' = g, keepGc, keepMove,
  }
  // イメージに、表定義の変更を当てる
  pure def reshaped(i: Img): Img = if (i.w == NONE or i.tag == 1) i else if (KIND == RECREATE) { tag: 1, w: NONE } else { tag: 1, w: i.w }
  // commit を適用したシャード s が、時刻 f に置く床
  def floorAfter(s: int, f: int): int =
    val logged = log.get(s)
    if (FLOOR == 0) f
    else if (FLOOR == 1) (if (logged == Set()) floor.get(s) else f)
    else if (FLOOR == 3) logged.fold(floor.get(s), (a, e) => max(a, e.c))
    else floor.get(s)
  // シャード s が commit を適用する。本体の表と同じ書き込みで、RESHAPE なら、残したイメージにも当てる
  action applyCommit(s: int): bool = all {
    d == 2, ep.get(s) == 1,
    val f = now + 1
    val had = handed.w != NONE and handed.tag == 0
    all {
      now' = f, ep' = ep.set(s, 2), appliedAt' = appliedAt.set(s, f), floor' = floor.set(s, floorAfter(s, f)),
      row' = row.set(s, if (row.get(s).w == NONE) { tag: 1, w: NONE } else reshaped(row.get(s))),
      handed' = if (s == P and RESHAPE) reshaped(handed) else handed,
      kept' = if (s == C and RESHAPE) (if (KIND == RECREATE) Set() else kept.map(v => { ...v, tag: 1 })) else kept,
      g' = { ...g, handedReshaped: g.handedReshaped or (s == P and RESHAPE and had),
             keptReshaped: g.keptReshaped or (s == C and RESHAPE and kept != Set()) },
      d' = d, log' = log, mvd' = mvd, m' = m, y' = y, wN' = wN, vers' = vers, x' = x, keepGc,
    }
  }

  // ---- 移動 (DDL の遷移と重ならない。DDL の commit の後は、親が commit を適用してから渡す) ----
  action pull = all {
    mvd == 0, d == 0 or (d == 2 and ep.get(P) == 2),
    mvd' = 1, m' = now + 1, now' = now + 1,
    handed' = row.get(P), row' = row.set(P, { tag: row.get(P).tag, w: NONE }),
    y' = if (yAt(P)) y.with("where", FLYING) else y,
    log' = log, kept' = kept, wN' = wN, vers' = vers, x' = x, g' = g, keepDdl, keepGc,
  }
  // 子が受け取る。親が commit を適用していて、子がまだなら、子は追いつく (生まれた子が、表定義の記録を適用する)
  action recv = all {
    mvd == 1,
    val catchUp = ep.get(P) == 2 and ep.get(C) < 2
    val f = now + 1
    all {
      mvd' = 2, m' = m, handed' = handed,
      row' = row.set(C, handed),
      y' = if (y.where == FLYING) y.with("where", C) else y,
      now' = if (catchUp) f else now,
      ep' = if (catchUp) ep.set(C, 2) else ep,
      appliedAt' = if (catchUp) appliedAt.set(C, f) else appliedAt,
      floor' = if (catchUp) floor.set(C, floorAfter(C, f)) else floor,
      d' = d, log' = log, kept' = kept, wN' = wN, vers' = vers, x' = x, g' = g, keepGc,
    }
  }

  // ---- 変更ログの切り詰め ----
  action gc(s: int, v: int): bool = all {
    gcs < GCS, v > low.get(s), v <= now,
    low' = low.set(s, v), gcs' = gcs + 1,
    log' = log.setBy(s, es => es.filter(e => e.c > v)),
    now' = now, row' = row, kept' = kept, y' = y, wN' = wN, vers' = vers, x' = x, g' = g, keepDdl, keepMove,
  }

  // ---- 取引 X (読むだけ) ----
  // 計画の epoch (0: DDL の commit の前の計画。1: 後の計画) と、読み取り時刻 (今の時計以下の、任意の値) を決める
  action xBegin(pe: int, t: int): bool = all {
    x.st == IDLE, pe == 0 or d == 2, t <= now,
    x' = { st: ACTIVE, pe: pe, T: t, seen: NONE },
    now' = now, log' = log, row' = row, kept' = kept, y' = y, wN' = wN, vers' = vers, g' = g, keepDdl, keepGc, keepMove,
  }
  // X の計画が読む表の、時刻 T の値。作り直しでは、計画の表 (前の A か、新しい A) の版だけが見える
  def truth(pe: int, t: int): int =
    vers.filter(v => v.c <= t and (KIND != RECREATE or v.tag == pe))
        .fold({ c: -1, w: NONE, tag: 0 }, (a, v) => if (v.c > a.c) v else a).w
  // イメージを、X の計画の名前で引く。RENAME では、名前の違うイメージは見つからない
  pure def found(i: Img, pe: int): bool = i.w != NONE and (KIND != RENAME or i.tag == pe)
  action xRead = all {
    x.st == ACTIVE, holder != 0,
    val h = holder
    val ask = mvd == 2 and x.T < m
    // 読みを戻すシャード。古い読みでは、前の持ち主である
    val src = if (ask) P else h
    all {
      // 要求のほうが新しければ、シャードは commit を適用してから答える (持ち主も、CHAIN_EPOCH なら前の持ち主も)
      x.pe == 0 or ep.get(h) == 2,
      not(ask and CHAIN_EPOCH and x.pe == 1 and ep.get(P) < 2),
      not(yAt(h) and y.c > 0 and y.c <= x.T),
      val stale = x.pe == 0 and (ep.get(h) == 2 or (ask and CHAIN_EPOCH and ep.get(P) == 2))
      val old = x.T < low.get(h) or (ask and x.T < low.get(P))
      val after = log.get(src).filter(e => e.c > x.T)
      // 床を見るのは、行を T まで戻すシャードである。前の持ち主は、尋ねられたらいつも見る。本体の表の読みは、T より後の確定が
      // あるとき (戻すものがあるとき) だけ見る。古い読みの持ち主は、その区間の行を戻さない (残した版を重ねるだけ) ので、見ない
      val hit = if (ask) x.T < floor.get(P) else (after != Set() and x.T < floor.get(h))
      val first = after.fold({ c: 1000, w: NONE, before: NONE, tag: 0 }, (a, e) => if (e.c < a.c) e else a)
      val base = if (ask) handed else row.get(h)
      val rolled = if (after == Set()) base else { tag: first.tag, w: first.before }
      // 古い読みでは、持ち主が、残した版の T 以下のものを重ねる。X の計画の名前で見つかるものだけが答えになる
      val over = if (ask) kept.filter(v => v.c <= x.T and found({ tag: v.tag, w: v.w }, x.pe)) else Set()
      val top = over.fold({ c: -1, w: NONE, tag: 0 }, (a, v) => if (v.c > a.c) v else a)
      val img = if (over != Set()) { tag: top.tag, w: top.w } else rolled
      val v = if (found(img, x.pe)) img.w else NONE
      val why = if (stale) WHY_SCHEMA else if (old) WHY_OLD else if (hit) WHY_FLOOR else 0
      all {
        x' = if (why != 0) x.with("st", FAILED) else { ...x, st: DONE, seen: v },
        y' = if (why == 0 and yAt(h) and y.c == 0 and y.pts <= x.T) y.with("pushed", max(y.pushed, x.T)) else y,
        g' = if (why != 0) { ...g, why: why, floorUnneeded: g.floorUnneeded or (why == WHY_FLOOR and not(after.exists(e => e.tag != x.pe))) }
             else { ...g, bad: g.bad or v != truth(x.pe, x.T),
                    restored: g.restored or (over == Set() and after != Set() and first.tag != x.pe),
                    mismatch: g.mismatch or (KIND == ADDCOL and img.w != NONE and img.tag != x.pe),
                    usedHanded: g.usedHanded or (ask and over == Set() and after == Set() and g.handedReshaped and v != NONE),
                    usedKept: g.usedKept or (over != Set() and g.keptReshaped),
                    formerBelow: g.formerBelow or (x.pe == 1 and ask and x.T < appliedAt.get(P)),
                    childBelow: g.childBelow or (x.pe == 1 and not(ask) and h == C and x.T < appliedAt.get(C)) },
        now' = now, log' = log, row' = row, kept' = kept, wN' = wN, vers' = vers, keepDdl, keepGc, keepMove,
      }
    }
  }

  action step = any {
    wWrite, yPrepare, yPhase2, prepareOp, commitOp, pull, recv, xRead,
    { nondet c = oneOf(1.to(8)) yDecide(c) },
    { nondet s = oneOf(SHARDS) any { applyPrepare(s), applyCommit(s) } },
    { nondet s = oneOf(SHARDS) nondet v = oneOf(1.to(8)) gc(s, v) },
    { nondet pe = oneOf(Set(0, 1)) nondet t = oneOf(0.to(8)) xBegin(pe, t) },
  }

  // ---- 不変条件 ----
  val readAtT = not(g.bad)
  val noRestoreAcross = not(g.restored)
  val imagesMatch = not(g.mismatch)
  val floorNeeded = not(g.floorUnneeded)
  // 計画が古いという理由で断られるのは、DDL の commit の前の計画が、commit の後に読んだときだけである
  val staleOnlyAfterCommit = g.why != WHY_SCHEMA or (x.pe == 0 and d == 2)
  val m23jSafe = and { readAtT, noRestoreAcross, imagesMatch, staleOnlyAfterCommit }
  val m23jExact = m23jSafe and floorNeeded

  // ---- witness ----
  // DDL の後の計画の古い読みが、表定義の変更を当てた渡した行で答えられる
  val witnessHandedAcrossDdl = not(x.st == DONE and g.usedHanded)
  // 同上、残した版で
  val witnessKeptAcrossDdl = not(x.st == DONE and g.usedKept)
  // 前の持ち主が、自分が commit を適用した時刻より小さい T の古い読みに答える (床を置かなかったシャード)
  val witnessFormerBelowApply = not(x.st == DONE and g.formerBelow)
  // 行を受け取った子が、自分が commit を適用した時刻より小さい T の読みに、本体の表で答える
  val witnessChildBelowApply = not(x.st == DONE and g.childBelow)
  // DDL の commit の前の計画の読みを、commit を適用した前の持ち主が断る
  val witnessStaleAtFormerOwner = not(x.st == FAILED and g.why == WHY_SCHEMA and mvd == 2 and ep.get(C) < 2)
  // 前の形の before-image を戻すことになる読みを、床が断る
  val witnessFloorRefuses = not(x.st == FAILED and g.why == WHY_FLOOR and not(g.floorUnneeded))
}

// ---- 規則 (緑) ----------------------------------------------------------------------------------------------------------

// RENAME TO。床は、変更ログに確定がなければ置かない (2 回目の実装の規則)。書き手 W 2 つ、変更ログの切り詰め 1 回
module m23j_green_rename {
  import m23j_core(KIND = 1, RESHAPE = true, CHAIN_EPOCH = true, FLOOR = 1, HAS_Y = false, WRITES_N = 2, GCS = 1).*
  // 範囲が C へ動いた後で RENAME TO が commit される。P は変更ログに確定がないので床を置かず、渡した行の名前を付け替える。
  // DDL の後の計画の、移動の前の T の読みに、P は、付け替えた渡した行で答える
  run handedTest =
    init.then(pull).then(recv)                                           // m = 1
        .then(prepareOp).then(applyPrepare(P)).then(applyPrepare(C)).then(commitOp)
        .then(applyCommit(P)).then(applyCommit(C))
        .expect(floor.get(P) == 0 and handed == { tag: 1, w: 0 })
        .then(xBegin(1, 0)).then(xRead)
        .expect(x.st == DONE and x.seen == 0 and m23jSafe and not(witnessHandedAcrossDdl) and not(witnessFormerBelowApply))
  // この規則に残る、要らない断り。変更ログに確定のあるシャードは、適用した時刻に床を置く。前の形の最後の確定から適用までの間の T の
  // 読みは、戻す before-image が後の形のものだけでも、断られる (答えは誤らない。floorNeeded だけが破れる)
  run unneededTest =
    init.then(wWrite)                                                    // c = 1 (前の形)
        .then(prepareOp).then(applyPrepare(P)).then(applyPrepare(C)).then(commitOp).then(applyCommit(P))   // 床 2
        .then(wWrite)                                                    // c = 3 (後の形)
        .then(xBegin(1, 1)).then(xRead)                                  // T = 1
        .expect(x.st == FAILED and g.why == WHY_FLOOR and not(floorNeeded) and m23jSafe)
}
// 同上、書き手 Y (残した版) と W 2 つ、変更ログの切り詰め 1 回
module m23j_green_rename_y {
  import m23j_core(KIND = 1, RESHAPE = true, CHAIN_EPOCH = true, FLOOR = 1, HAS_Y = true, WRITES_N = 2, GCS = 1).*
}
// DROP TABLE の後に、同じ名前で CREATE TABLE。書き手 Y と W 2 つ、変更ログの切り詰め 1 回
module m23j_green_recreate {
  import m23j_core(KIND = 2, RESHAPE = true, CHAIN_EPOCH = true, FLOOR = 1, HAS_Y = true, WRITES_N = 2, GCS = 1).*
}
// ADD COLUMN。同じ書き手
module m23j_green_addcol {
  import m23j_core(KIND = 3, RESHAPE = true, CHAIN_EPOCH = true, FLOOR = 1, HAS_Y = true, WRITES_N = 2, GCS = 1).*
}
// 床を、変更ログにある確定の時刻の最大にする形。床が断るのは、前の形の before-image を戻す読みだけになる
module m23j_exact_rename {
  import m23j_core(KIND = 1, RESHAPE = true, CHAIN_EPOCH = true, FLOOR = 3, HAS_Y = false, WRITES_N = 2, GCS = 1).*
  // m23j_green_rename の unneededTest と同じ順序。床は、前の形の最後の確定の時刻 1 で、T = 1 の読みは断られない
  run exactTest =
    init.then(wWrite)                                                    // c = 1 (前の形)
        .then(prepareOp).then(applyPrepare(P)).then(applyPrepare(C)).then(commitOp).then(applyCommit(P))
        .expect(floor.get(P) == 1)
        .then(wWrite)                                                    // c = 3 (後の形)
        .then(xBegin(1, 1)).then(xRead)                                  // W の before-image (後の形) で戻す
        .expect(x.st == DONE and x.seen == 11 and m23jExact)
}
module m23j_exact_recreate {
  import m23j_core(KIND = 2, RESHAPE = true, CHAIN_EPOCH = true, FLOOR = 3, HAS_Y = true, WRITES_N = 2, GCS = 1).*
}

// ---- 赤: 条件を 1 つずつ外す ----------------------------------------------------------------------------------------------

// 赤: 残したイメージに、表定義の変更を当てない。RENAME TO の後の名前の古い読みが、前の名前のままの渡した行を見つけない
module m23j_red_no_reshape_rename {
  import m23j_core(KIND = 1, RESHAPE = false, CHAIN_EPOCH = true, FLOOR = 1, HAS_Y = false, WRITES_N = 2, GCS = 1).*
  run lostRowTest =
    init.then(pull).then(recv)
        .then(prepareOp).then(applyPrepare(P)).then(applyPrepare(C)).then(commitOp)
        .then(applyCommit(P)).then(applyCommit(C))
        .then(xBegin(1, 0)).then(xRead)
        .expect(x.st == DONE and x.seen == NONE and not(readAtT))
}
// 赤: 同上、作り直し。消した表の渡した行が残り、新しい表の古い読みに出てくる
module m23j_red_no_reshape_recreate {
  import m23j_core(KIND = 2, RESHAPE = false, CHAIN_EPOCH = true, FLOOR = 1, HAS_Y = false, WRITES_N = 2, GCS = 1).*
  run ghostRowTest =
    init.then(pull).then(recv)
        .then(prepareOp).then(applyPrepare(P)).then(applyPrepare(C)).then(commitOp)
        .then(applyCommit(P)).then(applyCommit(C))
        .then(xBegin(1, 0)).then(xRead)
        .expect(x.st == DONE and x.seen == 0 and not(readAtT))
}
// 赤: 同上、残した版 (RENAME TO)。持ち主が重ねる版が、前の名前のままで見つからない
module m23j_red_no_reshape_kept {
  import m23j_core(KIND = 1, RESHAPE = false, CHAIN_EPOCH = true, FLOOR = 3, HAS_Y = true, WRITES_N = 0, GCS = 0).*
}
// ADD COLUMN では、当てなくても答えは変わらない (短いイメージの残りの列は、既定の値になる)。違うのは、イメージの形だけである
module m23j_addcol_no_reshape {
  import m23j_core(KIND = 3, RESHAPE = false, CHAIN_EPOCH = true, FLOOR = 1, HAS_Y = true, WRITES_N = 1, GCS = 0).*
  run shapeOnlyTest =
    init.then(pull).then(recv)
        .then(prepareOp).then(applyPrepare(P)).then(applyPrepare(C)).then(commitOp)
        .then(applyCommit(P)).then(applyCommit(C))
        .then(xBegin(1, 0)).then(xRead)
        .expect(x.st == DONE and x.seen == 0 and readAtT and not(imagesMatch))
}

// 赤: 前の持ち主への尋ねが、表の epoch を運ばない。commit を適用していない前の持ち主が、前の名前の行しか持たない
module m23j_red_no_chain_epoch {
  import m23j_core(KIND = 1, RESHAPE = true, CHAIN_EPOCH = false, FLOOR = 1, HAS_Y = false, WRITES_N = 2, GCS = 1).*
  run behindTest =
    init.then(pull).then(recv)
        .then(prepareOp).then(applyPrepare(P)).then(applyPrepare(C)).then(commitOp)
        .then(applyCommit(C))                                            // C は適用した。P はまだ
        .then(xBegin(1, 0)).then(xRead)
        .expect(x.st == DONE and x.seen == NONE and not(readAtT))
  // 逆の向き。commit の前の計画の読みを、commit を適用していない C が受け、適用した P が、付け替えた行で答える
  run aheadTest =
    init.then(pull).then(recv)
        .then(prepareOp).then(applyPrepare(P)).then(applyPrepare(C)).then(commitOp)
        .then(applyCommit(P))
        .then(xBegin(0, 0)).then(xRead)
        .expect(x.st == DONE and x.seen == NONE and not(readAtT))
}

// 赤: 床を置かない。前の形の before-image を、後の形の計画の読みに戻す (M24 の m24_floor_red_no_floor と同じ欠陥)
module m23j_red_no_floor {
  import m23j_core(KIND = 1, RESHAPE = true, CHAIN_EPOCH = true, FLOOR = 2, HAS_Y = false, WRITES_N = 2, GCS = 1).*
  run restoreTest =
    init.then(wWrite)                                                    // c = 1
        .then(prepareOp).then(applyPrepare(P)).then(applyPrepare(C)).then(commitOp).then(applyCommit(P))
        .then(xBegin(1, 0)).then(xRead)
        .expect(x.st == DONE and not(noRestoreAcross) and not(readAtT))
}

// 床を、いつも適用した時刻に置く (1 回目の実装より前)。答えは誤らないが、変更ログに確定のないシャードも、適用した時刻より前の T を断る
module m23j_always_rename {
  import m23j_core(KIND = 1, RESHAPE = true, CHAIN_EPOCH = true, FLOOR = 0, HAS_Y = false, WRITES_N = 2, GCS = 1).*
  // m23j_green_rename の handedTest と同じ順序。P は何も確定していないが、commit を適用した時刻 2 に床を置き、T = 0 の古い読みを断る
  run emptyLogTest =
    init.then(pull).then(recv)
        .then(prepareOp).then(applyPrepare(P)).then(applyPrepare(C)).then(commitOp)
        .then(applyCommit(P)).then(applyCommit(C))
        .expect(floor.get(P) == 2)
        .then(xBegin(1, 0)).then(xRead)
        .expect(x.st == FAILED and g.why == WHY_FLOOR and not(floorNeeded) and m23jSafe)
}
