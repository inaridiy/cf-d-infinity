// M23: 範囲の移動をまたぐ取引。read refresh と、子での確定 (未解決の問題 37)
//
// 2026-11-15 に書いた。実装より先に書いたモデルで、対応する実装はまだない。設計は docs/design-refresh-across-move.md にある。
//
// 約束 (docs/sql-language.md の「取引」、2026-11-15)。取引の途中で範囲が動いても、取引は続けられる。動いた行への文は、
// 新しい持ち主へ送る。動いた範囲を移動の時刻より前の読み取り時刻で読む文は、それまでの読みが今も成り立てば読み取り時刻を進めて
// 読み、成り立たなければ競合になる。`not owner` では失敗しない。
//
// 舞台。親 P (=1) と子 C (=2)。行 K1 は P に残り、行 K2 (のグループ) が P から C へ移る。移動は M5b の green の手順を、M21 の形に
// まとめたものである。
//   start   Meta が move-start を記録する (epoch 0 から 1)。親の fence、子の受け取りの始まり、範囲表の切り替えが 1 手で起きる
//           (M21 の FENCE_IS_EPOCH)。シャードが記録を遅れて適用する場合は、M21 が扱う
//   pull    親が K2 のグループの m を決め (時計 + 1)、行と intent を応答に載せる。親は以後、K2 の書き込みも phase 2 も受けない
//   recv    子が受け取る。到着の m を残し、時計を m まで進める。運ばれた intent は子に移る
//   finish  親が床 f を発行し (時計 + 1)、子は時計を f まで進めて、床として残す (finishMove と finishIncoming)
// 応答の喪失と再送、行のないグループ、piece は扱わない (M5b、M18、M19 が扱う)。
//
// シャードの記録 (log) は、そのシャードが確定 (適用) した書き込みだけを持つ。変更の確かめ (changedSince) は、これを見る。
// 子は、受け取った行を記録に残さない (実装の receive と同じ)。子の記録にあるのは、到着の後に子が適用した書き込みで、その中には、
// 親で prepare されて pull で運ばれ、子で m 以下の c で適用された intent もある (c は anchor が決める。M5b)。
// 子は、K2 を、到着の m と床の両方以上の T でだけ読みに答える。答えに使うのは、受け取った行 (親の最新の版) と子の記録である。
//
// 書き手。
//   W  autocommit の書き込み 1 回。K2 の持ち主 (start の前は P、到着の後は C) で、時計 + 1 で確定する。intent があれば待つ
//   Y  K2 に書く 2PC の取引。持ち主で prepare し (pts)、anchor が c を決め (pts 以上、push より大きい)、phase 2 は、moved の表で
//      決めた持ち主に届く (M5b の P2_MODE 2)。start の前に P で prepare すると、intent が pull に乗る
// 取引 X は、K1 と K2 を読む (全表の読み)。形は定数で選ぶ (全表をもう 1 回読む、K2 を書く、書き込みは悲観か楽観か)。
//   読みは、Worker の範囲表 (epoch) で宛先を決める。親は、渡した (pull した) K2 の読みを NotOwner で断り、断る応答が範囲表を運ぶ。
//   子は、T が到着の m か床より小さければ ReadTooOld で断り、Worker は read refresh で T をそこまで進める (M1b)。
//   OTHER なら、X は、ほかのシャードの ReadTooOld で、任意の to への refresh も始める (範囲表の古い Worker の refresh を含む)。
//   楽観の書き込みは、T の状態で K2 を読んで書く (UPDATE)。悲観の書き込みは、持ち主が発行する F の最新の状態を読み、T は変えない。
//   行ロックはモデルにない。ロックが消えても F からの検証が守る、というのが実装の前提で、M9 が確かめている。
//   確定は、K2 の持ち主が P なら P の 1 シャードの確定、C なら C で prepare してから P を anchor にする 2PC である。P は K1 を
//   読んだだけで、最後に prepare するので、refresh が要らない (実装の anchor の選び方と同じ)。
//
// 確かめ (read refresh と、確定の prepare の検証) の設計は 2 つある (DESIGN)。
//   1 (推奨) 子が埋める。Worker は、確かめを、いまの範囲表の持ち主へ送る。親は、渡したグループの Worker からの確かめを NotOwner で
//     断る。子は、自分の記録を from から確かめ、from が到着の m より前なら、(from, m] を親の記録で埋める (親に尋ねる)。
//   2 Worker が両方に尋ねる。Worker は、読んだシャード (親) と、いまの持ち主 (子) の両方へ送る。親は、要求の epoch が移動を
//     知っているときだけ、渡したグループを自分の記録で答える。子は、グループが届いてから、自分の記録で答える。確定では、Worker が
//     親を K2 の検証の参加者に入れる。
//   0 段 2 の後で、この設計を入れない実装。確かめは、読んだシャードへ送る。親は渡したグループを断り、子は T が到着の m か床より
//     小さければ断る。確定の prepare でも、子は T を到着の m と床と比べて断る。PIN_ROUTING は、いまの実装 (取引が、最初の範囲表を
//     確定まで使い、断られても取り直さない)。
// どちらの設計でも、確かめに答えたシャードは時計を to まで進め (M1b)、c の決まっていない intent を to より上へ push する。
// 選択肢が 2 つある。FENCE_REFUSES は、親が fence の後、まだ渡していない K2 も断る形 (いまの実装の親。M19 の前)。
// BOUNDED は、refresh の確かめが (from, to] の変更だけを見る案 (いまの changedSince は to より後も数える)。
//
// invariant
//   serializable          確定した X の読みは、確定の点 (読むだけなら T、書くなら c の直前) の値と一致する (M1 と同じ形)。
//                         同じ行を 2 回読んで違う値を見た X は、確定しない
//   readConsistent        シャードが答えた読みは、その時刻の真の値と一致する
//   placementIndependent  X が失敗するのは、X が読んだ行が、読んだ後に別の取引に書かれた (確定した) とき、または X が書く取引で、
//                         読んだ行に別の取引の intent があったときだけである。どちらも、移動がなくても失敗し得る (規則 4 の形)
//   boundedRefusals       X が移動を理由に断られる回数は、移動の数 (1) 以下である
//   parentFrozen          親の K2 の記録は、pull の後は変わらない (子が親の記録を尋ねる手を 1 手にしてよい理由)
//   readOnlyBelowStart    読むだけの X が失敗するのは、refresh の窓 (from, to] に、読んだ行の別の取引の確定があったときだけである
//                         (BOUNDED の案を比べるのに使う。m23Safe には含めない)
// temporal
//   refreshTerminates     始めた refresh は、いつか終わる (通るか、競合で終わる)
module m23_core {
  // ---- 設計 ----
  const DESIGN: int
  const PIN_ROUTING: bool
  // ---- 設計の条件。赤は 1 つずつ外す ----
  const OWNER_REFUSES: bool     // 1: 親は、渡したグループの、Worker からの確かめを断る
  const PEER: bool              // 1: 子は、refresh の確かめで、from が到着の m より前なら、(from, m] を親の記録で埋める
  const PEER_PREPARE: bool      // 1: 同じことを、確定の prepare の検証でも行う
  const PINGPONG: bool          // 1 の活性の赤: 子は、親に尋ねる代わりに、到着より前から始まる窓を「前の持ち主へ」と断る
  const ASK_BOTH: bool          // 2: Worker は、読んだシャードと、いまの持ち主の両方へ送る
  const EPOCH_CHECK: bool       // 2: 親は、要求の epoch が移動を知らなければ、渡したグループの確かめを断る
  const WAIT_ARRIVAL: bool      // 2: 子は、グループが届いてから答える
  const PARENT_VALIDATES: bool  // 2: 確定で、Worker は、親を K2 の検証の参加者に入れる
  const CHILD_FROM: int         // 子が自分の記録を確かめる下限。0: 要求の from。1: from と床の大きい方。2: from と到着の m の大きい方
  const BUMP: bool              // 確かめに答えたシャードは、時計を to まで進める
  const PUSH: bool              // 確かめは、c の決まっていない intent を to より上へ push する (false: intent があれば失敗する)
  // ---- 設計の選択肢 ----
  const BOUNDED: bool           // refresh の確かめは (from, to] の変更だけを見る (false: to より後も見る。いまの changedSince)。
                                // 通らなかった refresh は、移動による ReadTooOld のものなら取引を失敗させ、ほかのものなら、後の refresh を止めない
  const FENCE_REFUSES: bool     // 親は、fence (start) の後、まだ渡していない K2 の読みと確かめも断る (いまの実装の親。M19 の前)
  // ---- 場面 ----
  const SCAN2: bool             // X は全表をもう 1 回読む
  const WRITE: bool             // X は K2 を書く
  const PESSIMISTIC: bool       // X の書き込みは悲観 (DML の時点で、持ち主の F の最新を読む。T は変えない)
  const OTHER: bool             // X は、ほかのシャードの ReadTooOld で、任意の to への refresh を始める
  const HAS_W: bool
  const HAS_Y: bool
  const TICKS: int
  const T_MAX: int

  pure val P = 1
  pure val C = 2
  pure val SHARDS = Set(1, 2)
  pure val K1 = 1                 // P に残る行
  pure val K2 = 2                 // C へ移る行
  pure val KEYS = Set(1, 2)
  pure val X = 10
  pure val W = 11
  pure val Y = 12
  // X の状態
  pure val IDLE = 0
  pure val ACTIVE = 1
  pure val PREPARED = 2           // C で prepare した (K2 の intent が C にある)
  pure val COMMITTED = 3
  pure val ABORTED = 4
  // X の次の文
  pure val PC_SCAN1 = 0
  pure val PC_SCAN2 = 1
  pure val PC_WRITE = 2
  pure val PC_COMMIT = 3

  type Ver = { ver: int, writer: int }
  type Intent = { where: int, pts: int, c: int, pushed: int }      // where: 0 なし、1 P、2 C、3 適用済み
  type Move = { epoch: int, moved: int, flying: bool, carry: bool, arrived: int, floor: int }
  type Txn = {
    st: int, pc: int, done: Set[int], T: int, ep: int, fresh: bool,
    lo: int -> int,               // 行 -> 検証の下限 (-1 は読んでいない)。refresh が通ると to になる
    seen: int -> Set[int],        // 行 -> 読んだ値 (書き手の id)
    atP: bool, atC: bool,         // K2 を P で読んだか、C で読んだか (読んだ範囲を記録したシャード)
    rTo: int,                     // refresh の to (0 は refresh の途中でない)
    rRem: Set[(int, int)],        // 確かめが残っている (行, シャード)
    rFatal: bool,                 // 移動による ReadTooOld で始めた refresh (通らなければ、取引は動いた範囲を読めない)
    wrote: bool, wAt: int, ptsC: int, c: int, applied: bool
  }
  type Ghost = {
    whyChange: bool,              // X が失敗したとき、読んだ行に、読んだ後の別の取引の確定があった
    whyIntent: bool,              // X が失敗したとき、K2 に別の取引の intent があった
    whyBelow: bool,               // X の refresh が通らなかったとき、読んだ行に、読んだ後で to 以下の時刻の、別の取引の確定があった
    crossed: bool,                // 移動の時刻をまたいで T を進めた refresh が通った
    refusals: int,                // 移動を理由に断られた回数 (3 で止める)
    badRead: bool,                // シャードが、その時刻の真の値と違う値を答えた
    frozenBroken: bool,           // 親が、pull の後に K2 の書き込みを適用した
    wAt: int, wC: int             // W を確定したシャードと時刻
  }

  var hlc: int -> int
  var log: int -> (int -> Set[Ver])
  var mv: Move
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

  pure val idleTxn: Txn = {
    st: IDLE, pc: PC_SCAN1, done: Set(), T: 0, ep: 0, fresh: true,
    lo: KEYS.mapBy(_ => -1), seen: KEYS.mapBy(_ => Set()), atP: false, atC: false,
    rTo: 0, rRem: Set(), rFatal: false, wrote: false, wAt: 0, ptsC: 0, c: 0, applied: false
  }

  action init = all {
    hlc' = SHARDS.mapBy(_ => 0),
    log' = Map(P -> KEYS.mapBy(_ => init0), C -> KEYS.mapBy(_ => Set())),
    mv' = { epoch: 0, moved: 0, flying: false, carry: false, arrived: 0, floor: 0 },
    y' = { where: 0, pts: 0, c: 0, pushed: 0 },
    wDone' = not(HAS_W),
    ticks' = 0,
    x' = idleTxn,
    g' = { whyChange: false, whyIntent: false, whyBelow: false, crossed: false, refusals: 0, badRead: false, frozenBroken: false, wAt: 0, wC: 0 }
  }
  action keepWorld = all { hlc' = hlc, log' = log, mv' = mv, y' = y, wDone' = wDone, ticks' = ticks }

  // ---- 状態から引くもの ----------------------------------------------------------
  // 子が受け取った K2 の行。親の最新の版で、時刻はその版の時刻のままである (子は到着の m より小さい T に答えないので、読みには
  // 効かない)。親の記録は pull の後に変わらない (parentFrozen) ので、いまの親の記録から引ける。
  def img: Set[Ver] = if (mv.arrived > 0) Set(latest(log.get(P).get(K2))) else Set()
  // シャード d が、行 k の読みに答えるのに使う版
  def histAt(d: int, k: int): Set[Ver] = if (d == C) log.get(C).get(k).union(img) else log.get(P).get(k)
  def yOpen: bool = y.where == P or y.where == C
  def yAt(d: int): bool = y.where == d
  // 確定した書き込みの全部 (適用済みと、c が決まって未適用の Y)
  def allWrites(k: int): Set[Ver] =
    log.get(P).get(k).union(log.get(C).get(k)).union(if (k == K2 and yOpen and y.c > 0) Set({ ver: y.c, writer: Y }) else Set())
  // シャード d の記録に、from より後の、X 以外の書き込みがあるか (実装の changedSince)
  def changedAfter(d: int, k: int, from: int): bool = log.get(d).get(k).exists(v => v.ver > from and v.writer != X)
  def xIntentAtC: bool = x.st == PREPARED or (x.st == COMMITTED and x.ptsC > 0 and not(x.applied))
  // Worker の範囲表での宛先
  def route(k: int): int = if (k == K1 or x.ep == 0) P else C
  // 子が K2 の読みに答える、いちばん小さい T
  def startC: int = max(mv.arrived, mv.floor)
  // 親が K2 を渡した (Worker からの K2 の読みと確かめを断る)。M19 の親は pull の後から、いまの実装の親は fence の後から断る
  def handedOver: bool = if (FENCE_REFUSES) mv.epoch == 1 else mv.moved > 0
  // 子が自分の記録を確かめる下限
  def childFrom(lo: int): int = if (CHILD_FROM == 1) max(lo, mv.floor) else if (CHILD_FROM == 2) max(lo, mv.arrived) else lo
  // Y の intent に当たった読み。c が決まって t 以下なら、適用を待つ。c が決まっていなければ、t より上へ push する
  def yBlocks(d: int, t: int): bool = yAt(d) and y.c > 0 and y.c <= t
  def pushedTo(d: int, t: int): Intent = if (yAt(d) and y.c == 0 and y.pts <= t) y.with("pushed", max(y.pushed, t)) else y

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
  // T は P の時計から取る (P がない場合、つまり時計の遅れたシャードから取る T は、OTHER の refresh と、移動の後に始める X が表す)
  action xBegin = all {
    x.st == IDLE,
    x' = idleTxn.with("st", ACTIVE).with("T", hlc.get(P)).with("ep", mv.epoch),
    keepWorld, g' = g
  }

  // 文の途中か。w は楽観の書き込みの文 (K2 を T で読んで書く)
  def inStatement(k: int, w: bool): bool =
    x.st == ACTIVE and x.rTo == 0 and
    (if (w) (x.pc == PC_WRITE and k == K2 and not(PESSIMISTIC))
     else ((x.pc == PC_SCAN1 or x.pc == PC_SCAN2) and not(x.done.contains(k))))

  // 行 k を d で読んで値 v を得た後の X
  def afterRead(k: int, w: bool, d: int, v: int): Txn =
    val t1 = x.with("seen", x.seen.set(k, x.seen.get(k).union(Set(v))))
              .with("lo", if (x.lo.get(k) < 0) x.lo.set(k, x.T) else x.lo)
              .with("atP", x.atP or (k == K2 and d == P)).with("atC", x.atC or (k == K2 and d == C))
    if (w) t1.with("wrote", true).with("wAt", d).with("pc", PC_COMMIT)
    else if (x.done.union(Set(k)) == KEYS) t1.with("done", Set()).with("pc", nextPc(x.pc))
    else t1.with("done", x.done.union(Set(k)))

  // 親か子が、T で答える。親は、まだ渡していない K2 には、fence の後でも答える (M19。FENCE_REFUSES なら断る)。子は、到着の m と床の両方以上の T に答える
  action xAnswer(k: int, w: bool, d: int): bool = all {
    inStatement(k, w),
    route(k) == d,
    if (d == P) (k == K1 or not(handedOver)) else (mv.arrived > 0 and x.T >= startC),
    not(k == K2 and yBlocks(d, x.T)),
    val v = valueAt(histAt(d, k), x.T)
    all {
      x' = afterRead(k, w, d, v),
      hlc' = hlc.set(d, max(hlc.get(d), x.T)),
      y' = if (k == K2) pushedTo(d, x.T) else y,
      g' = g.with("badRead", g.badRead or v != valueAt(allWrites(k), x.T)),
      log' = log, mv' = mv, wDone' = wDone, ticks' = ticks
    }
  }

  // 親が、K2 の文を NotOwner で断る。読みは pull の後で、悲観の書き込みは fence (start) の後で断る。断る応答が範囲表を運び、
  // Worker は宛先を直す。いまの実装 (PIN_ROUTING) の取引は範囲表を取り直さないので、文が失敗する
  def k2Next: bool = x.st == ACTIVE and x.rTo == 0 and
    (((x.pc == PC_SCAN1 or x.pc == PC_SCAN2) and not(x.done.contains(K2))) or x.pc == PC_WRITE)
  action xNotOwner = all {
    x.ep == 0, k2Next,
    if (x.pc == PC_WRITE and PESSIMISTIC) mv.epoch == 1 else handedOver,
    x' = if (PIN_ROUTING) x.with("st", ABORTED) else x.with("ep", 1),
    g' = if (PIN_ROUTING) noted else refused,
    keepWorld
  }

  // refresh の計画。読んだ行ごとに、確かめを送るシャードを決める
  def recorded(k: int): Set[int] =
    if (k == K1) Set(P) else (if (x.atP) Set(P) else Set()).union(if (x.atC) Set(C) else Set())
  def dests(k: int): Set[int] =
    if (DESIGN == 1) Set(route(k))
    else if (DESIGN == 2) recorded(k).union(if (ASK_BOTH) Set(route(k)) else Set())
    else recorded(k)
  def readKeys: Set[int] = KEYS.filter(k => x.lo.get(k) >= 0)
  // まだ何も読んでいなければ、T をそのまま進める (M1b)
  def refreshPlan(upTo: int, fatal: bool): Txn =
    if (readKeys == Set()) x.with("T", upTo)
    else x.with("rTo", upTo).with("rFatal", fatal).with("rRem", readKeys.map(k => dests(k).map(d => (k, d))).flatten())

  // 子が、到着の m か床より小さい T の読みを ReadTooOld で断る。Worker は、T を startC まで進める refresh を始める。
  // 前の refresh が通らなかった取引は、T を進められないので、失敗する (理由は、通らなかったときに記録してある)
  action xTooOld(k: int, w: bool): bool = all {
    inStatement(k, w), k == K2, route(K2) == C, mv.arrived > 0, x.T < startC,
    x' = if (x.fresh) refreshPlan(startC, true) else x.with("st", ABORTED),
    keepWorld, g' = g
  }

  // ほかのシャードの ReadTooOld で、任意の to への refresh を始める (範囲表の古い Worker も始める)
  action xOther(upTo: int): bool = all {
    OTHER, x.st == ACTIVE, x.rTo == 0, x.fresh, x.pc != PC_COMMIT, upTo > x.T, upTo <= T_MAX,
    x' = refreshPlan(upTo, false),
    keepWorld, g' = g
  }

  // ---- refresh の確かめ ------------------------------------------------------------
  // 確かめで Y の intent に当たった。PUSH なら、c が決まっていなければ to より上へ push し、c が決まって to 以下なら適用を待つ
  // (待った後は記録に入るので、記録で見る)。PUSH でなければ失敗する (M1b と、いまの実装の refresh)。
  def yWaits(d: int, upTo: int): bool = PUSH and yAt(d) and y.c > 0 and y.c <= upTo
  // BOUNDED なら、to より後の変更は見ない (確かめの後で to 以下の時刻の確定が起きないことは、時計を to まで進めることと、
  // intent の push が守る)。確定の検証 (prepare) は、今と同じく上限を切らない
  def changedIn(d: int, k: int, from: int): bool =
    log.get(d).get(k).exists(v => v.ver > from and (not(BOUNDED) or v.ver <= x.rTo) and v.writer != X)
  def ownOk(d: int, k: int, from: int): bool = not(changedIn(d, k, from)) and (k != K2 or not(yAt(d)) or PUSH)
  def lastOne(k: int, d: int): bool = x.rRem.exclude(Set((k, d))) == Set()
  def confirmed(k: int, d: int): Txn =
    if (not(lastOne(k, d))) x.with("rRem", x.rRem.exclude(Set((k, d))))
    else x.with("T", x.rTo).with("lo", KEYS.mapBy(j => if (x.lo.get(j) >= 0) x.rTo else -1)).with("rTo", 0).with("rRem", Set())
  // 通った refresh が、K2 を読んだ時刻から移動の時刻をまたいだか (witness 用)
  def crossing(k: int, d: int): bool =
    lastOne(k, d) and x.lo.get(K2) >= 0 and mv.moved > 0 and x.lo.get(K2) < mv.moved and mv.moved <= x.rTo
  // 通らなかった refresh。BOUNDED でなければ、以後の refresh を止める (M1b。いまの wantsFresh)。BOUNDED なら、移動による
  // ReadTooOld の refresh は、窓 (from, to] に確定があったので、どう進めても通らず、取引は失敗する。ほかの refresh は、後の refresh を止めない
  def failed: Txn =
    if (not(BOUNDED)) x.with("fresh", false).with("rTo", 0).with("rRem", Set())
    else if (x.rFatal) x.with("st", ABORTED).with("rTo", 0).with("rRem", Set())
    else x.with("rTo", 0).with("rRem", Set())

  // 親が、渡したグループ (pull した K2) の、Worker からの確かめを断るか
  def parentRefuses: bool =
    if (DESIGN == 1) OWNER_REFUSES else if (DESIGN == 2) (EPOCH_CHECK and x.ep == 0) else true

  action confirmP(k: int): bool = all {
    x.st == ACTIVE, x.rTo > 0, x.rRem.contains((k, P)),
    if (k == K2 and handedOver and parentRefuses) all {
      // 断る。設計 1 と 2 では、断る応答が範囲表を運び、Worker は宛先を直す。設計 0 では、refresh が通らない
      x' = if (DESIGN == 0) failed
           else if (DESIGN == 1) x.with("ep", 1).with("rRem", x.rRem.exclude(Set((K2, P))).union(Set((K2, C))))
           else x.with("ep", 1).with("rRem", x.rRem.union(if (ASK_BOTH) Set((K2, C)) else Set())),
      g' = if (DESIGN == 0) noted else refused,
      keepWorld
    } else all {
      // 親が、自分の記録で答える (K1、まだ渡していない K2、設計 2 で epoch が移動を知っている K2)
      not(k == K2 and yWaits(P, x.rTo)),
      val ok = ownOk(P, k, x.lo.get(k))
      all {
        x' = if (ok) confirmed(k, P) else failed,
        g' = if (ok) g.with("crossed", g.crossed or crossing(k, P)) else noted,
        hlc' = if (BUMP) hlc.set(P, max(hlc.get(P), x.rTo)) else hlc,
        y' = if (ok and k == K2 and PUSH) pushedTo(P, x.rTo) else y,
        log' = log, mv' = mv, wDone' = wDone, ticks' = ticks
      }
    }
  }

  action confirmC = all {
    x.st == ACTIVE, x.rTo > 0, x.rRem.contains((K2, C)),
    val lo = x.lo.get(K2)
    if (DESIGN == 0 and mv.arrived > 0 and x.T < startC) all {
      // いまの実装: 子は、T が到着の m か床より小さい確かめを ReadTooOld で断る。refresh は通らない
      x' = failed, g' = noted, keepWorld
    } else if (DESIGN == 1 and PINGPONG and mv.arrived > 0 and lo < mv.arrived) all {
      // 活性の赤: 子は、到着より前から始まる窓を、前の持ち主へ回す
      x' = x.with("rRem", x.rRem.exclude(Set((K2, C))).union(Set((K2, P)))),
      g' = refused, keepWorld
    } else all {
      // 子が、自分の記録で答える。設計 1 では、from が到着の m より前なら、(from, m] を親の記録で埋める。
      // 親の K2 の記録は pull の後で変わらないので (parentFrozen)、親に尋ねる手は、子が答える手と同じ 1 手にしてある
      DESIGN != 2 or not(WAIT_ARRIVAL) or mv.arrived > 0,
      DESIGN == 2 or mv.arrived > 0,
      not(yWaits(C, x.rTo)),
      val peer = DESIGN == 1 and PEER and lo < mv.arrived
      val ok = ownOk(C, K2, childFrom(lo)) and (not(peer) or ownOk(P, K2, lo))
      all {
        x' = if (ok) confirmed(K2, C) else failed,
        g' = if (ok) g.with("crossed", g.crossed or crossing(K2, C)) else noted,
        hlc' = if (BUMP) hlc.set(C, max(hlc.get(C), x.rTo)) else hlc,
        y' = if (ok and PUSH) pushedTo(C, x.rTo) else y,
        log' = log, mv' = mv, wDone' = wDone, ticks' = ticks
      }
    }
  }

  // ---- 取引 X: 悲観の書き込み ---------------------------------------------------------
  // 持ち主が F を発行し、F の最新の状態を読んで書く (行ロックはモデルにない)。検証の下限は、K2 を前に読んでいればその下限のままである
  action xDml = all {
    x.st == ACTIVE, x.rTo == 0, x.pc == PC_WRITE, PESSIMISTIC,
    val d = route(K2)
    val F = hlc.get(d) + 1
    val v = valueAt(histAt(d, K2), F)
    all {
      if (d == P) mv.epoch == 0 else mv.arrived > 0,
      not(yBlocks(d, F)),
      x' = x.with("seen", x.seen.set(K2, x.seen.get(K2).union(Set(v))))
            .with("lo", x.lo.set(K2, if (x.lo.get(K2) < 0) F else min(x.lo.get(K2), F)))
            .with("wrote", true).with("wAt", d).with("pc", PC_COMMIT)
            .with("atP", x.atP or d == P).with("atC", x.atC or d == C),
      hlc' = hlc.set(d, F),
      y' = pushedTo(d, F),
      g' = g.with("badRead", g.badRead or v != valueAt(allWrites(K2), F)),
      log' = log, mv' = mv, wDone' = wDone, ticks' = ticks
    }
  }

  // ---- 取引 X: 確定 ---------------------------------------------------------------
  // 読むだけの X は、T のスナップショットで終わる (確定の検証はない)
  action xFinishRO = all {
    x.st == ACTIVE, x.rTo == 0, x.pc == PC_COMMIT, not(x.wrote),
    x' = x.with("st", COMMITTED).with("c", x.T),
    keepWorld, g' = g
  }
  // K2 の書き込みを送るシャード。設計 1 と 2 では、いまの範囲表の持ち主へ送り直す。いまの実装は、文を実行したシャードへ送る
  def k2Dest: int = if (DESIGN == 0) x.wAt else route(K2)
  // 1 シャードの確定 (K2 の持ち主が P)。P は、fence の後は K2 の書き込みを断る
  action xCommitLocal = all {
    x.st == ACTIVE, x.rTo == 0, x.pc == PC_COMMIT, x.wrote, k2Dest == P,
    if (mv.epoch == 1) all {
      x' = if (PIN_ROUTING or DESIGN == 0) x.with("st", ABORTED) else x.with("ep", 1),
      g' = if (PIN_ROUTING or DESIGN == 0) noted else refused,
      keepWorld
    } else all {
      val ok = KEYS.forall(k => x.lo.get(k) < 0 or not(changedAfter(P, k, x.lo.get(k)))) and not(yAt(P))
      val c = hlc.get(P) + 1
      all {
        x' = if (ok) x.with("st", COMMITTED).with("c", c).with("applied", true) else x.with("st", ABORTED),
        hlc' = if (ok) hlc.set(P, c) else hlc,
        log' = if (ok) log.set(P, log.get(P).set(K2, log.get(P).get(K2).union(Set({ ver: c, writer: X })))) else log,
        g' = if (ok) g else noted,
        mv' = mv, y' = y, wDone' = wDone, ticks' = ticks
      }
    }
  }
  // C での prepare。子は、グループが届いてから検証する (届いていなければ pull する)
  action xPrepareC = all {
    x.st == ACTIVE, x.rTo == 0, x.pc == PC_COMMIT, x.wrote, k2Dest == C,
    mv.arrived > 0,
    val lo = x.lo.get(K2)
    // いまの実装: 子は、T が到着の m か床より小さい prepare を断る
    val tooOld = DESIGN == 0 and x.T < startC
    // 設計 1: from が到着の m より前なら、(from, m] を親の記録で埋める
    val peer = DESIGN == 1 and PEER_PREPARE and lo < mv.arrived
    val ok = not(tooOld) and not(changedAfter(C, K2, childFrom(lo))) and not(yAt(C))
             and (not(peer) or (not(changedAfter(P, K2, lo)) and not(yAt(P))))
    val pts = hlc.get(C) + 1
    all {
      x' = if (ok) x.with("st", PREPARED).with("ptsC", pts) else x.with("st", ABORTED),
      hlc' = if (ok) hlc.set(C, pts) else hlc,
      g' = if (ok) g else noted,
      log' = log, mv' = mv, y' = y, wDone' = wDone, ticks' = ticks
    }
  }
  // P (anchor) の prepare。最後に prepare し、c を決める。K1 を検証する
  action xPrepareP = all {
    x.st == PREPARED,
    val lo1 = x.lo.get(K1)
    val lo2 = x.lo.get(K2)
    // 設計 2: Worker は、K2 を P で読んでいれば、P を K2 の検証の参加者に入れる (epoch は移動を知っている)
    val p2 = DESIGN == 2 and PARENT_VALIDATES and x.atP
    // いまの実装: 読んだ範囲を、読んだシャードへ送る。P は、渡したグループの範囲を断る
    val stale = DESIGN == 0 and x.atP and handedOver
    val ok = not(stale) and (lo1 < 0 or not(changedAfter(P, K1, lo1)))
             and (not(p2) or (not(changedAfter(P, K2, lo2)) and not(yAt(P))))
    val c = max(hlc.get(P), x.ptsC) + 1
    all {
      x' = if (ok) x.with("st", COMMITTED).with("c", c) else x.with("st", ABORTED),
      hlc' = if (ok) hlc.set(P, c) else hlc,
      g' = if (ok) g else noted,
      log' = log, mv' = mv, y' = y, wDone' = wDone, ticks' = ticks
    }
  }
  // phase 2: C で適用する
  action xApply = all {
    x.st == COMMITTED, x.ptsC > 0, not(x.applied),
    x' = x.with("applied", true),
    log' = log.set(C, log.get(C).set(K2, log.get(C).get(K2).union(Set({ ver: x.c, writer: X })))),
    hlc' = hlc.set(C, max(hlc.get(C), x.c)),
    mv' = mv, y' = y, wDone' = wDone, ticks' = ticks, g' = g
  }

  // ---- ほかの書き手 ----------------------------------------------------------------
  // W: K2 の持ち主で、autocommit の書き込みを 1 回確定する。intent があれば待つ
  action wWrite(d: int): bool = all {
    not(wDone),
    if (d == P) mv.epoch == 0 else mv.arrived > 0,
    not(yAt(d)), not(d == C and xIntentAtC),
    val c = hlc.get(d) + 1
    all {
      hlc' = hlc.set(d, c),
      log' = log.set(d, log.get(d).set(K2, log.get(d).get(K2).union(Set({ ver: c, writer: W })))),
      wDone' = true,
      g' = g.with("wAt", d).with("wC", c),
      mv' = mv, y' = y, ticks' = ticks, x' = x
    }
  }
  // Y: K2 の持ち主で prepare する
  action yPrepare(d: int): bool = all {
    HAS_Y, y.where == 0,
    if (d == P) mv.epoch == 0 else mv.arrived > 0,
    not(d == C and xIntentAtC),
    val pts = hlc.get(d) + 1
    all {
      hlc' = hlc.set(d, pts),
      y' = { where: d, pts: pts, c: 0, pushed: 0 },
      log' = log, mv' = mv, wDone' = wDone, ticks' = ticks, x' = x, g' = g
    }
  }
  // Y の anchor が c を決める (ほかの参加者の pts 次第で、pts 以上の任意の値。push があればそれより大きい)
  action yDecide(c: int): bool = all {
    yOpen, y.c == 0, c >= y.pts, c > y.pushed, c <= y.pts + 2,
    y' = y.with("c", c),
    hlc' = hlc, log' = log, mv' = mv, wDone' = wDone, ticks' = ticks, x' = x, g' = g
  }
  // Y の phase 2。moved の表で持ち主を決め、子が受け取っていなければ待つ
  action yPhase2 = all {
    yOpen, y.c > 0,
    val d = if (mv.moved > 0) C else P
    all {
      d == P or mv.arrived > 0,
      log' = log.set(d, log.get(d).set(K2, log.get(d).get(K2).union(Set({ ver: y.c, writer: Y })))),
      hlc' = hlc.set(d, max(hlc.get(d), y.c)),
      y' = y.with("where", 3),
      g' = g.with("frozenBroken", g.frozenBroken or (d == P and mv.moved > 0)),
      mv' = mv, wDone' = wDone, ticks' = ticks, x' = x
    }
  }

  // ---- 移動 ------------------------------------------------------------------------
  action start = all {
    mv.epoch == 0,
    mv' = mv.with("epoch", 1),
    hlc' = hlc, log' = log, y' = y, wDone' = wDone, ticks' = ticks, x' = x, g' = g
  }
  action pull = all {
    mv.epoch == 1, mv.moved == 0,
    val m = hlc.get(P) + 1
    all {
      hlc' = hlc.set(P, m),
      mv' = mv.with("moved", m).with("flying", true).with("carry", y.where == P),
      log' = log, y' = y, wDone' = wDone, ticks' = ticks, x' = x, g' = g
    }
  }
  action recv = all {
    mv.flying,
    mv' = mv.with("flying", false).with("arrived", mv.moved),
    hlc' = hlc.set(C, max(hlc.get(C), mv.moved)),
    y' = if (mv.carry and y.where == P) y.with("where", C) else y,
    log' = log, wDone' = wDone, ticks' = ticks, x' = x, g' = g
  }
  action finish = all {
    mv.arrived > 0, mv.floor == 0,
    val f = hlc.get(P) + 1
    all {
      hlc' = hlc.set(P, f).set(C, max(hlc.get(C), f)),
      mv' = mv.with("floor", f),
      log' = log, y' = y, wDone' = wDone, ticks' = ticks, x' = x, g' = g
    }
  }
  action tick(d: int): bool = all {
    ticks < TICKS,
    hlc' = hlc.set(d, hlc.get(d) + 1), ticks' = ticks + 1,
    log' = log, mv' = mv, y' = y, wDone' = wDone, x' = x, g' = g
  }

  action step = any {
    xBegin,
    xNotOwner,
    { nondet k = oneOf(KEYS) nondet w = oneOf(Set(true, false)) nondet d = oneOf(SHARDS) xAnswer(k, w, d) },
    { nondet k = oneOf(KEYS) nondet w = oneOf(Set(true, false)) xTooOld(k, w) },
    { nondet upTo = oneOf(1.to(T_MAX)) xOther(upTo) },
    { nondet k = oneOf(KEYS) confirmP(k) },
    confirmC,
    xDml, xFinishRO, xCommitLocal, xPrepareC, xPrepareP, xApply,
    { nondet d = oneOf(SHARDS) wWrite(d) },
    { nondet d = oneOf(SHARDS) yPrepare(d) },
    { nondet c = oneOf(1.to(T_MAX + 8)) yDecide(c) },
    yPhase2,
    start, pull, recv, finish,
    { nondet d = oneOf(SHARDS) tick(d) }
  }

  // ---- 不変条件 ---------------------------------------------------------------------
  // 確定の点の値。書く X は c の直前 (c より小さい時刻の書き込みの最新)、読むだけの X は T の値
  def expected(k: int): int =
    if (x.wrote) latest(allWrites(k).filter(v => v.writer != X and v.ver < x.c)).writer
    else valueAt(allWrites(k), x.T)
  val serializable = x.st != COMMITTED or KEYS.forall(k => x.lo.get(k) < 0 or x.seen.get(k) == Set(expected(k)))
  val readConsistent = not(g.badRead)
  val placementIndependent = x.st != ABORTED or g.whyChange or (WRITE and g.whyIntent)
  // 読むだけの X が失敗するのは、refresh の窓 (from, to] に、読んだ行の別の取引の確定があったときだけである。to は、子が答えられる
  // いちばん古い時刻 (移動による ReadTooOld の refresh) なので、範囲の床の規則の下では、この確定は避けられない
  val readOnlyBelowStart = WRITE or x.st != ABORTED or g.whyBelow
  val boundedRefusals = g.refusals <= 1
  val parentFrozen = not(g.frozenBroken)
  val m23Safe = serializable and readConsistent and placementIndependent and boundedRefusals and parentFrozen
  // 答えを誤らないこと (置き場所に依る失敗は問わない)。いまの実装のインスタンスで、断るだけで安全なことを確かめる
  val answersSafe = serializable and readConsistent

  // ---- witness ----------------------------------------------------------------------
  // 移動の時刻をまたいで T を進めた refresh が通り、X が確定した
  val witnessRefreshAcross = not(g.crossed and x.st == COMMITTED)
  // 移動の前に K2 を P で読んだ X が、K2 を書いて、移動の後に子で確定した
  val witnessCommitAcross = not(x.st == COMMITTED and x.applied and x.ptsC > 0 and x.atP)
  // 再現 (test/open/transaction-across-split.test.ts の 1 つ目) の形: 移動の前に P で全表を読み、移動の後に、refresh で T を進めて
  // 全表を読み直し (K2 は子で読む)、動いた行を子で書いて確定した。読んだ値はどれも変わっていない
  val witnessReproduction = not(x.st == COMMITTED and x.applied and x.ptsC > 0 and x.atP and x.atC and g.crossed
                                and KEYS.forall(k => x.seen.get(k).size() == 1))
  // 子が、到着の後で床より前に確定した W の書き込みで、X が競合になった (Y なし)
  val witnessConflictBelowFloor = not(x.st == ABORTED and g.whyChange and y.where == 0 and g.wAt == C
                                      and g.wC > mv.arrived and mv.floor > g.wC)
  // T が到着の m より小さいまま、X が子で確定した (悲観の取引は T を進めない)
  val witnessBelowArrival = not(x.st == COMMITTED and x.ptsC > 0 and x.T < mv.arrived)
  // 親が、範囲表の古い X の確かめを断り、X が範囲表を直して確定した
  val witnessRefusedThenCommitted = not(x.st == COMMITTED and g.refusals >= 1 and g.crossed)
  // X が競合で失敗した。読むだけの X (m23_green_ro) で使う。移動がなければ、読むだけの X は失敗しない (持ち主の判断に挙げた)
  val witnessAborted = not(x.st == ABORTED)

  // ---- 活性 -------------------------------------------------------------------------
  // 始めた refresh は、いつか終わる。シャードは、出ている確かめに答えるか断る (弱い公平性)。子が答えるのに要る pull と到着、
  // 確かめが待つ Y の phase 2 は、いつか起きる (弱い公平性)。
  val vars = (hlc, log, mv, y, wDone, ticks, x, g)
  temporal fairness = and {
    weakFair(confirmP(K1), vars), weakFair(confirmP(K2), vars), weakFair(confirmC, vars),
    weakFair(pull, vars), weakFair(recv, vars), weakFair(yPhase2, vars)
  }
  temporal refreshTerminates = fairness implies always(x.rTo > 0 implies eventually(x.rTo == 0))
}

// ---- 設計 1 (推奨): 子が埋める ----------------------------------------------------------------------------------------

// 全表を 2 回読み、K2 を楽観で書く (再現の形)。W と Y がある。範囲表の古い Worker の refresh (OTHER) もある
module m23_green {
  import m23_core(DESIGN = 1, PIN_ROUTING = false, OWNER_REFUSES = true, PEER = true, PEER_PREPARE = true, PINGPONG = false,
                  ASK_BOTH = true, EPOCH_CHECK = true, WAIT_ARRIVAL = true, PARENT_VALIDATES = true, CHILD_FROM = 0, BUMP = true, PUSH = true, BOUNDED = false, FENCE_REFUSES = false,
                  SCAN2 = true, WRITE = true, PESSIMISTIC = false, OTHER = true, HAS_W = true, HAS_Y = true, TICKS = 1, T_MAX = 5).*
  // 再現の 1 つ目: 移動の前に全表を読み、移動の後に読み直して、動いた行を書いて確定する
  run reproductionTest =
    init.then(xBegin)                                     // T = 0
        .then(xAnswer(K1, false, P)).then(xAnswer(K2, false, P))
        .then(start).then(pull).then(recv).then(finish)   // m = 1。床 2。子の時計 2
        .expect(mv.moved == 1 and mv.arrived == 1 and mv.floor == 2)
        .then(xAnswer(K1, false, P))
        .then(xNotOwner)                                   // 親が K2 を断り、範囲表を渡す
        .expect(x.ep == 1)
        .then(xTooOld(K2, false))                          // 子: T = 0 < 床 2
        .expect(x.rTo == 2 and x.rRem == Set((K1, P), (K2, C)))
        .then(confirmP(K1))
        .then(confirmC)                                    // 子は、自分の記録と、親の (0, 1] の記録で答える
        .expect(x.T == 2 and x.rTo == 0 and g.crossed)
        .then(xAnswer(K2, false, C))                       // 同じ行を読む
        .then(xAnswer(K2, true, C))                        // UPDATE
        .then(xPrepareC).then(xPrepareP).then(xApply)
        .expect(x.st == COMMITTED and m23Safe and not(witnessReproduction))
  // 再現の 2 つ目: 移動の後、別の接続が動いた行を書く。読み直しは競合になり、not owner にはならない
  run conflictTest =
    init.then(xBegin)
        .then(xAnswer(K1, false, P)).then(xAnswer(K2, false, P))
        .then(start).then(pull).then(recv).then(finish)
        .then(wWrite(C))                                   // c = 3
        .then(xAnswer(K1, false, P)).then(xNotOwner).then(xTooOld(K2, false))
        .then(confirmP(K1)).then(confirmC)
        .expect(not(x.fresh) and x.T == 0)
        .then(xTooOld(K2, false))
        .expect(x.st == ABORTED and g.whyChange and m23Safe)
}

// 読むだけの取引 (全表を 2 回読む)。書かない取引は、読んだ行の intent では失敗してはならない (移動がなければ失敗しない)
module m23_green_ro {
  import m23_core(DESIGN = 1, PIN_ROUTING = false, OWNER_REFUSES = true, PEER = true, PEER_PREPARE = true, PINGPONG = false,
                  ASK_BOTH = true, EPOCH_CHECK = true, WAIT_ARRIVAL = true, PARENT_VALIDATES = true, CHILD_FROM = 0, BUMP = true, PUSH = true, BOUNDED = false, FENCE_REFUSES = false,
                  SCAN2 = true, WRITE = false, PESSIMISTIC = false, OTHER = true, HAS_W = true, HAS_Y = true, TICKS = 1, T_MAX = 5).*
}

// 悲観の取引。全表を読み、動いた行を DML で書く。T は最初の読みのまま、到着の m より小さくても、子で確定する
module m23_green_pess {
  import m23_core(DESIGN = 1, PIN_ROUTING = false, OWNER_REFUSES = true, PEER = true, PEER_PREPARE = true, PINGPONG = false,
                  ASK_BOTH = true, EPOCH_CHECK = true, WAIT_ARRIVAL = true, PARENT_VALIDATES = true, CHILD_FROM = 0, BUMP = true, PUSH = true, BOUNDED = false, FENCE_REFUSES = false,
                  SCAN2 = false, WRITE = true, PESSIMISTIC = true, OTHER = true, HAS_W = true, HAS_Y = true, TICKS = 1, T_MAX = 5).*
  run belowArrivalTest =
    init.then(xBegin)
        .then(xAnswer(K1, false, P)).then(xAnswer(K2, false, P))      // T = 0
        .then(start).then(pull).then(recv).then(finish)               // m = 1、床 2
        .then(xNotOwner)                                               // 悲観の DML は、fence の後の親に断られる
        .then(xDml)                                                    // 子の F = 3 の最新を読む。T は 0 のまま
        .expect(x.T == 0 and x.lo.get(K2) == 0 and x.wAt == C)
        .then(xPrepareC)                                               // 子は、(0, 1] を親の記録で埋めて検証する
        .then(xPrepareP).then(xApply)
        .expect(x.st == COMMITTED and m23Safe and not(witnessBelowArrival))
}

// 赤: 親が、渡したグループの確かめに、自分の記録だけで答える。範囲表の古い Worker は、子に尋ねない
module m23_red_parent_alone {
  import m23_core(DESIGN = 1, PIN_ROUTING = false, OWNER_REFUSES = false, PEER = true, PEER_PREPARE = true, PINGPONG = false,
                  ASK_BOTH = true, EPOCH_CHECK = true, WAIT_ARRIVAL = true, PARENT_VALIDATES = true, CHILD_FROM = 0, BUMP = true, PUSH = true, BOUNDED = false, FENCE_REFUSES = false,
                  SCAN2 = true, WRITE = true, PESSIMISTIC = false, OTHER = true, HAS_W = true, HAS_Y = true, TICKS = 1, T_MAX = 5).*
  run counterexampleTest =
    init.then(xBegin)
        .then(xAnswer(K1, false, P)).then(xAnswer(K2, false, P))      // T = 0
        .then(start).then(pull).then(recv)                            // m = 1
        .then(wWrite(C))                                               // 子が K2 を c = 2 で確定する
        .then(xOther(3))                                               // 範囲表の古い X が、T を 3 へ進める
        .expect(x.ep == 0 and x.rRem == Set((K1, P), (K2, P)))
        .then(confirmP(K1)).then(confirmP(K2))                         // 親は、自分の記録に変更がないので通す
        .expect(x.T == 3)
        .then(xAnswer(K1, false, P)).then(xNotOwner).then(xAnswer(K2, false, C))   // 子で読み直すと、W の値
        .then(xAnswer(K2, true, C)).then(xPrepareC).then(xPrepareP)
        .expect(x.st == COMMITTED and x.seen.get(K2) == Set(0, W) and not(serializable))
}

// 赤: 子が、自分の記録を、床から確かめる。到着の後で床より前に、子が確定した書き込みを見落とす
module m23_red_child_from_floor {
  import m23_core(DESIGN = 1, PIN_ROUTING = false, OWNER_REFUSES = true, PEER = true, PEER_PREPARE = true, PINGPONG = false,
                  ASK_BOTH = true, EPOCH_CHECK = true, WAIT_ARRIVAL = true, PARENT_VALIDATES = true, CHILD_FROM = 1, BUMP = true, PUSH = true, BOUNDED = false, FENCE_REFUSES = false,
                  SCAN2 = true, WRITE = true, PESSIMISTIC = false, OTHER = true, HAS_W = true, HAS_Y = true, TICKS = 1, T_MAX = 5).*
  run counterexampleTest =
    init.then(xBegin)
        .then(xAnswer(K1, false, P)).then(xAnswer(K2, false, P))      // T = 0
        .then(start).then(pull).then(recv)                            // m = 1
        .then(wWrite(C))                                               // c = 2 (到着の後)
        .then(tick(P)).then(finish)                                    // 床 3 (W の後)
        .expect(mv.floor == 3 and g.wC == 2)
        .then(xAnswer(K1, false, P)).then(xNotOwner).then(xTooOld(K2, false))
        .then(confirmP(K1)).then(confirmC)                             // 子は (3, ∞) だけを見る
        .expect(x.T == 3)
        .then(xAnswer(K2, false, C))
        .then(xAnswer(K2, true, C)).then(xPrepareC).then(xPrepareP)
        .expect(x.st == COMMITTED and not(serializable))
}

// 赤: 子が、自分の記録を、到着の m から確かめる。運ばれた intent が、子で m 以下の c で適用された書き込みを見落とす
module m23_red_child_from_arrival {
  import m23_core(DESIGN = 1, PIN_ROUTING = false, OWNER_REFUSES = true, PEER = true, PEER_PREPARE = true, PINGPONG = false,
                  ASK_BOTH = true, EPOCH_CHECK = true, WAIT_ARRIVAL = true, PARENT_VALIDATES = true, CHILD_FROM = 2, BUMP = true, PUSH = true, BOUNDED = false, FENCE_REFUSES = false,
                  SCAN2 = true, WRITE = true, PESSIMISTIC = false, OTHER = true, HAS_W = true, HAS_Y = true, TICKS = 1, T_MAX = 5).*
  run counterexampleTest =
    init.then(xBegin)
        .then(xAnswer(K1, false, P)).then(xAnswer(K2, false, P))      // T = 0
        .then(yPrepare(P))                                             // Y の intent (pts 1) を P に置く
        .then(start).then(pull).then(recv)                            // m = 2。intent は子へ
        .then(yDecide(1)).then(yPhase2)                                // Y は c = 1 < m で、子で適用される
        .expect(log.get(C).get(K2) == Set({ ver: 1, writer: Y }))
        .then(xAnswer(K1, false, P)).then(xNotOwner).then(xTooOld(K2, false))
        .then(confirmP(K1)).then(confirmC)                             // 子は (2, ∞) を見る。親の (0, 2] には Y がない
        .expect(x.T == 2)
        .then(xAnswer(K2, false, C))
        .then(xAnswer(K2, true, C)).then(xPrepareC).then(xPrepareP)
        .expect(x.st == COMMITTED and x.seen.get(K2) == Set(0, Y) and not(serializable))
}

// 赤: 子が、到着より前から始まる窓を、親の記録で埋めない (refresh でも prepare でも)
module m23_red_no_peer {
  import m23_core(DESIGN = 1, PIN_ROUTING = false, OWNER_REFUSES = true, PEER = false, PEER_PREPARE = false, PINGPONG = false,
                  ASK_BOTH = true, EPOCH_CHECK = true, WAIT_ARRIVAL = true, PARENT_VALIDATES = true, CHILD_FROM = 0, BUMP = true, PUSH = true, BOUNDED = false, FENCE_REFUSES = false,
                  SCAN2 = true, WRITE = true, PESSIMISTIC = false, OTHER = true, HAS_W = true, HAS_Y = true, TICKS = 1, T_MAX = 5).*
  run counterexampleTest =
    init.then(xBegin)
        .then(xAnswer(K1, false, P)).then(xAnswer(K2, false, P))      // T = 0
        .then(wWrite(P))                                               // 親が K2 を c = 1 で確定する (fence の前)
        .then(start).then(pull).then(recv).then(finish)               // m = 2、床 3
        .then(xAnswer(K1, false, P)).then(xNotOwner).then(xTooOld(K2, false))
        .then(confirmP(K1)).then(confirmC)                             // 子の記録は空なので通す
        .expect(x.T == 3)
        .then(xAnswer(K2, false, C))
        .expect(x.seen.get(K2) == Set(0, W))
        .then(xAnswer(K2, true, C)).then(xPrepareC).then(xPrepareP)
        .expect(x.st == COMMITTED and not(serializable))
}

// 赤: 確定の prepare で、子が、床より小さい T の検証を、自分の記録だけで通す (refresh も、親の記録の確かめもしない)
module m23_red_prepare_alone {
  import m23_core(DESIGN = 1, PIN_ROUTING = false, OWNER_REFUSES = true, PEER = true, PEER_PREPARE = false, PINGPONG = false,
                  ASK_BOTH = true, EPOCH_CHECK = true, WAIT_ARRIVAL = true, PARENT_VALIDATES = true, CHILD_FROM = 0, BUMP = true, PUSH = true, BOUNDED = false, FENCE_REFUSES = false,
                  SCAN2 = true, WRITE = true, PESSIMISTIC = false, OTHER = true, HAS_W = true, HAS_Y = true, TICKS = 1, T_MAX = 5).*
  // 移動の前に、P で読んで K2 を書く (書き込みは Worker に溜まる)。別の接続が K2 を書く。移動の後に確定する
  run counterexampleTest =
    init.then(xBegin)
        .then(xAnswer(K1, false, P)).then(xAnswer(K2, false, P))      // T = 0
        .then(xAnswer(K1, false, P)).then(xAnswer(K2, false, P))
        .then(xAnswer(K2, true, P))                                    // UPDATE (値 0 から)
        .then(wWrite(P))                                               // c = 1
        .then(start).then(pull).then(recv).then(finish)
        .then(xCommitLocal)                                            // 親は fence の後なので断る。範囲表を直す
        .expect(x.ep == 1 and x.st == ACTIVE)
        .then(xPrepareC)                                               // 子は (0, ∞) を自分の記録だけで見る
        .then(xPrepareP)
        .expect(x.st == COMMITTED and not(serializable))               // 失われた更新
}

// 赤: 確かめに答えたシャードが、時計を to まで進めない (M1b の m1b_red_ra の、子の側)
module m23_red_no_bump {
  import m23_core(DESIGN = 1, PIN_ROUTING = false, OWNER_REFUSES = true, PEER = true, PEER_PREPARE = true, PINGPONG = false,
                  ASK_BOTH = true, EPOCH_CHECK = true, WAIT_ARRIVAL = true, PARENT_VALIDATES = true, CHILD_FROM = 0, BUMP = false, PUSH = true, BOUNDED = false, FENCE_REFUSES = false,
                  SCAN2 = true, WRITE = true, PESSIMISTIC = false, OTHER = true, HAS_W = true, HAS_Y = true, TICKS = 1, T_MAX = 5).*
  run counterexampleTest =
    init.then(xBegin)
        .then(xAnswer(K1, false, P)).then(xAnswer(K2, false, P))      // T = 0
        .then(start).then(pull).then(recv)                            // m = 1、子の時計 1
        .then(xOther(4))
        .then(confirmP(K1)).then(confirmP(K2))                         // 親は断り、範囲表を渡す
        .then(confirmC)                                                // 子は答えるが、時計を 4 まで進めない
        .expect(x.T == 4 and hlc.get(C) == 1)
        .then(wWrite(C))                                               // c = 2 <= 4
        .then(xAnswer(K1, false, P)).then(xAnswer(K2, false, C))
        .then(xAnswer(K2, true, C)).then(xPrepareC).then(xPrepareP)
        .expect(x.st == COMMITTED and x.seen.get(K2) == Set(0, W) and not(serializable))
}

// 赤: 確かめが、c の決まっていない intent を push せず、失敗する (M1b の refresh、いまの実装の refresh)。
// 移動がなければ失敗しない、読むだけの取引が失敗する
module m23_red_no_push {
  import m23_core(DESIGN = 1, PIN_ROUTING = false, OWNER_REFUSES = true, PEER = true, PEER_PREPARE = true, PINGPONG = false,
                  ASK_BOTH = true, EPOCH_CHECK = true, WAIT_ARRIVAL = true, PARENT_VALIDATES = true, CHILD_FROM = 0, BUMP = true, PUSH = false, BOUNDED = false, FENCE_REFUSES = false,
                  SCAN2 = true, WRITE = false, PESSIMISTIC = false, OTHER = true, HAS_W = true, HAS_Y = true, TICKS = 1, T_MAX = 5).*
  run counterexampleTest =
    init.then(xBegin)
        .then(xAnswer(K1, false, P)).then(xAnswer(K2, false, P))      // T = 0
        .then(yPrepare(P))                                             // Y の intent (pts 1)。c はまだ決まっていない
        .then(start).then(pull).then(recv).then(finish)
        .then(xAnswer(K1, false, P)).then(xNotOwner).then(xTooOld(K2, false))
        .then(confirmP(K1)).then(confirmC)                             // 子は intent に当たって失敗する
        .then(xTooOld(K2, false))
        .expect(x.st == ABORTED and not(g.whyChange) and not(placementIndependent))
}

// いまの実装 (取引は最初の範囲表を確定まで使う。親は fence の後、範囲の要求を全部断る)。動いた行に触る文が not owner で失敗する
module m23_impl_pinned {
  import m23_core(DESIGN = 0, PIN_ROUTING = true, OWNER_REFUSES = true, PEER = false, PEER_PREPARE = false, PINGPONG = false,
                  ASK_BOTH = false, EPOCH_CHECK = true, WAIT_ARRIVAL = true, PARENT_VALIDATES = false, CHILD_FROM = 1, BUMP = true, PUSH = false, BOUNDED = false, FENCE_REFUSES = true,
                  SCAN2 = true, WRITE = true, PESSIMISTIC = false, OTHER = true, HAS_W = true, HAS_Y = true, TICKS = 1, T_MAX = 5).*
  run counterexampleTest =
    init.then(xBegin)
        .then(xAnswer(K1, false, P)).then(xAnswer(K2, false, P))
        .then(start).then(pull).then(recv).then(finish)
        .then(xAnswer(K1, false, P)).then(xNotOwner)
        .expect(x.st == ABORTED and not(placementIndependent))
}

// 範囲表の取り直しだけを入れ、この設計を入れない実装。確かめは読んだシャードへ行き、親は not owner、子は床で断る (親は fence の後に断る)
module m23_impl {
  import m23_core(DESIGN = 0, PIN_ROUTING = false, OWNER_REFUSES = true, PEER = false, PEER_PREPARE = false, PINGPONG = false,
                  ASK_BOTH = false, EPOCH_CHECK = true, WAIT_ARRIVAL = true, PARENT_VALIDATES = false, CHILD_FROM = 1, BUMP = true, PUSH = false, BOUNDED = false, FENCE_REFUSES = true,
                  SCAN2 = true, WRITE = true, PESSIMISTIC = false, OTHER = true, HAS_W = true, HAS_Y = true, TICKS = 1, T_MAX = 5).*
  run counterexampleTest =
    init.then(xBegin)
        .then(xAnswer(K1, false, P)).then(xAnswer(K2, false, P))
        .then(start).then(pull).then(recv).then(finish)
        .then(xAnswer(K1, false, P)).then(xNotOwner).then(xTooOld(K2, false))
        .expect(x.rRem == Set((K1, P), (K2, P)))
        .then(confirmP(K1)).then(confirmP(K2))                         // 親は、渡したグループの確かめを断る
        .then(xTooOld(K2, false))
        .expect(x.st == ABORTED and not(placementIndependent))
}

// 定数を広げた green (HEAVY=1)。時計の tick 2 回、T の上限 6
module m23_green_wide {
  import m23_core(DESIGN = 1, PIN_ROUTING = false, OWNER_REFUSES = true, PEER = true, PEER_PREPARE = true, PINGPONG = false,
                  ASK_BOTH = true, EPOCH_CHECK = true, WAIT_ARRIVAL = true, PARENT_VALIDATES = true, CHILD_FROM = 0, BUMP = true, PUSH = true, BOUNDED = false, FENCE_REFUSES = false,
                  SCAN2 = true, WRITE = true, PESSIMISTIC = false, OTHER = true, HAS_W = true, HAS_Y = true, TICKS = 2, T_MAX = 6).*
}

// 親が、いまの実装のとおり、fence の後は範囲の要求を全部断る (M19 の親より前)。この設計を、段 2 の直後に入れる場合の親である
module m23_green_fenced {
  import m23_core(DESIGN = 1, PIN_ROUTING = false, OWNER_REFUSES = true, PEER = true, PEER_PREPARE = true, PINGPONG = false,
                  ASK_BOTH = true, EPOCH_CHECK = true, WAIT_ARRIVAL = true, PARENT_VALIDATES = true, CHILD_FROM = 0, BUMP = true, PUSH = true, BOUNDED = false, FENCE_REFUSES = true,
                  SCAN2 = true, WRITE = true, PESSIMISTIC = false, OTHER = true, HAS_W = true, HAS_Y = true, TICKS = 1, T_MAX = 5).*
  // fence の後、まだ pull していない K2 の読みを、親が断る。子が pull してから答える
  run fencedTest =
    init.then(xBegin)
        .then(xAnswer(K1, false, P)).then(xAnswer(K2, false, P))      // T = 0
        .then(start)
        .then(xAnswer(K1, false, P)).then(xNotOwner)                   // pull の前でも断る
        .expect(x.ep == 1 and mv.moved == 0)
        .then(pull).then(recv)                                         // 子が pull する。m = 1
        .then(xTooOld(K2, false)).then(confirmP(K1)).then(confirmC)
        .expect(x.T == 1 and g.crossed)
        .then(xAnswer(K2, false, C)).then(xAnswer(K2, true, C))
        .then(xPrepareC).then(xPrepareP).then(xApply)
        .expect(x.st == COMMITTED and m23Safe)
}

// 推奨の組み合わせ: 設計 1、いまの親 (FENCE_REFUSES)、確かめの上限 (BOUNDED)。楽観と悲観の取引、活性
module m23_green_rec {
  import m23_core(DESIGN = 1, PIN_ROUTING = false, OWNER_REFUSES = true, PEER = true, PEER_PREPARE = true, PINGPONG = false,
                  ASK_BOTH = true, EPOCH_CHECK = true, WAIT_ARRIVAL = true, PARENT_VALIDATES = true, CHILD_FROM = 0, BUMP = true, PUSH = true, BOUNDED = true, FENCE_REFUSES = true,
                  SCAN2 = true, WRITE = true, PESSIMISTIC = false, OTHER = true, HAS_W = true, HAS_Y = true, TICKS = 1, T_MAX = 5).*
}
module m23_green_rec_pess {
  import m23_core(DESIGN = 1, PIN_ROUTING = false, OWNER_REFUSES = true, PEER = true, PEER_PREPARE = true, PINGPONG = false,
                  ASK_BOTH = true, EPOCH_CHECK = true, WAIT_ARRIVAL = true, PARENT_VALIDATES = true, CHILD_FROM = 0, BUMP = true, PUSH = true, BOUNDED = true, FENCE_REFUSES = true,
                  SCAN2 = false, WRITE = true, PESSIMISTIC = true, OTHER = true, HAS_W = true, HAS_Y = true, TICKS = 1, T_MAX = 5).*
}
module m23_live_rec {
  import m23_core(DESIGN = 1, PIN_ROUTING = false, OWNER_REFUSES = true, PEER = true, PEER_PREPARE = true, PINGPONG = false,
                  ASK_BOTH = true, EPOCH_CHECK = true, WAIT_ARRIVAL = true, PARENT_VALIDATES = true, CHILD_FROM = 0, BUMP = true, PUSH = true, BOUNDED = true, FENCE_REFUSES = true,
                  SCAN2 = true, WRITE = false, PESSIMISTIC = false, OTHER = true, HAS_W = false, HAS_Y = true, TICKS = 0, T_MAX = 3).*
}

// 確かめの上限を to で切る案 (BOUNDED)。書く取引と、読むだけの取引
module m23_green_bounded {
  import m23_core(DESIGN = 1, PIN_ROUTING = false, OWNER_REFUSES = true, PEER = true, PEER_PREPARE = true, PINGPONG = false,
                  ASK_BOTH = true, EPOCH_CHECK = true, WAIT_ARRIVAL = true, PARENT_VALIDATES = true, CHILD_FROM = 0, BUMP = true, PUSH = true, BOUNDED = true, FENCE_REFUSES = false,
                  SCAN2 = true, WRITE = true, PESSIMISTIC = false, OTHER = true, HAS_W = true, HAS_Y = true, TICKS = 1, T_MAX = 5).*
}
module m23_green_ro_bounded {
  import m23_core(DESIGN = 1, PIN_ROUTING = false, OWNER_REFUSES = true, PEER = true, PEER_PREPARE = true, PINGPONG = false,
                  ASK_BOTH = true, EPOCH_CHECK = true, WAIT_ARRIVAL = true, PARENT_VALIDATES = true, CHILD_FROM = 0, BUMP = true, PUSH = true, BOUNDED = true, FENCE_REFUSES = false,
                  SCAN2 = true, WRITE = false, PESSIMISTIC = false, OTHER = true, HAS_W = true, HAS_Y = true, TICKS = 1, T_MAX = 5).*
  // 移動の後、子が床より後に動いた行を確定しても、読むだけの X は、床まで T を進めて確定する (上限のない確かめでは失敗する)
  run laterWriteTest =
    init.then(xBegin)
        .then(xAnswer(K1, false, P)).then(xAnswer(K2, false, P))
        .then(start).then(pull).then(recv).then(finish)               // 床 2
        .then(wWrite(C))                                               // c = 3 > 床
        .then(xAnswer(K1, false, P)).then(xNotOwner).then(xTooOld(K2, false))
        .then(confirmP(K1)).then(confirmC)                             // (0, 2] に変更はない
        .expect(x.T == 2)
        .then(xAnswer(K2, false, C)).then(xFinishRO)
        .expect(x.st == COMMITTED and m23Safe and readOnlyBelowStart)
}

// 活性 (refreshTerminates)。設計 1。読むだけの取引、Y あり、W なし、tick なし、T の上限 3
module m23_live {
  import m23_core(DESIGN = 1, PIN_ROUTING = false, OWNER_REFUSES = true, PEER = true, PEER_PREPARE = true, PINGPONG = false,
                  ASK_BOTH = true, EPOCH_CHECK = true, WAIT_ARRIVAL = true, PARENT_VALIDATES = true, CHILD_FROM = 0, BUMP = true, PUSH = true, BOUNDED = false, FENCE_REFUSES = false,
                  SCAN2 = true, WRITE = false, PESSIMISTIC = false, OTHER = true, HAS_W = false, HAS_Y = true, TICKS = 0, T_MAX = 3).*
}
// 同じ活性を、fence の後に全部断る親で
module m23_live_fenced {
  import m23_core(DESIGN = 1, PIN_ROUTING = false, OWNER_REFUSES = true, PEER = true, PEER_PREPARE = true, PINGPONG = false,
                  ASK_BOTH = true, EPOCH_CHECK = true, WAIT_ARRIVAL = true, PARENT_VALIDATES = true, CHILD_FROM = 0, BUMP = true, PUSH = true, BOUNDED = false, FENCE_REFUSES = true,
                  SCAN2 = true, WRITE = false, PESSIMISTIC = false, OTHER = true, HAS_W = false, HAS_Y = true, TICKS = 0, T_MAX = 3).*
}
// 同じ活性を設計 2 で
module m23_alt_live {
  import m23_core(DESIGN = 2, PIN_ROUTING = false, OWNER_REFUSES = true, PEER = false, PEER_PREPARE = false, PINGPONG = false,
                  ASK_BOTH = true, EPOCH_CHECK = true, WAIT_ARRIVAL = true, PARENT_VALIDATES = true, CHILD_FROM = 0, BUMP = true, PUSH = true, BOUNDED = false, FENCE_REFUSES = false,
                  SCAN2 = true, WRITE = false, PESSIMISTIC = false, OTHER = true, HAS_W = false, HAS_Y = true, TICKS = 0, T_MAX = 3).*
}

// 活性の赤: 子は、親に尋ねる代わりに、到着より前から始まる窓を「前の持ち主へ」と断り、親は「渡した」と断る
module m23_live_red_pingpong {
  import m23_core(DESIGN = 1, PIN_ROUTING = false, OWNER_REFUSES = true, PEER = false, PEER_PREPARE = true, PINGPONG = true,
                  ASK_BOTH = true, EPOCH_CHECK = true, WAIT_ARRIVAL = true, PARENT_VALIDATES = true, CHILD_FROM = 0, BUMP = true, PUSH = true, BOUNDED = false, FENCE_REFUSES = false,
                  SCAN2 = true, WRITE = false, PESSIMISTIC = false, OTHER = true, HAS_W = false, HAS_Y = true, TICKS = 0, T_MAX = 3).*
  run counterexampleTest =
    init.then(xBegin)
        .then(xAnswer(K1, false, P)).then(xAnswer(K2, false, P))
        .then(start).then(pull).then(recv).then(finish)
        .then(xAnswer(K1, false, P)).then(xNotOwner).then(xTooOld(K2, false))
        .then(confirmP(K1)).then(confirmC)                             // 子: 前の持ち主へ
        .expect(x.rRem == Set((K2, P)))
        .then(confirmP(K2))                                            // 親: 渡した
        .expect(x.rRem == Set((K2, C)) and not(boundedRefusals))
}

// ---- 設計 2: Worker が親と子の両方に尋ね、親は epoch で確かめる ------------------------------------------------------------

module m23_alt_green {
  import m23_core(DESIGN = 2, PIN_ROUTING = false, OWNER_REFUSES = true, PEER = false, PEER_PREPARE = false, PINGPONG = false,
                  ASK_BOTH = true, EPOCH_CHECK = true, WAIT_ARRIVAL = true, PARENT_VALIDATES = true, CHILD_FROM = 0, BUMP = true, PUSH = true, BOUNDED = false, FENCE_REFUSES = false,
                  SCAN2 = true, WRITE = true, PESSIMISTIC = false, OTHER = true, HAS_W = true, HAS_Y = true, TICKS = 1, T_MAX = 5).*
  run reproductionTest =
    init.then(xBegin)
        .then(xAnswer(K1, false, P)).then(xAnswer(K2, false, P))
        .then(start).then(pull).then(recv).then(finish)
        .then(xAnswer(K1, false, P)).then(xNotOwner).then(xTooOld(K2, false))
        .expect(x.rRem == Set((K1, P), (K2, P), (K2, C)))             // 親 (読んだシャード) と子 (いまの持ち主) の両方
        .then(confirmP(K1)).then(confirmP(K2)).then(confirmC)
        .expect(x.T == 2 and g.crossed)
        .then(xAnswer(K2, false, C)).then(xAnswer(K2, true, C))
        .then(xPrepareC).then(xPrepareP).then(xApply)                  // 確定でも、親が K2 の (0, ∞) を検証する
        .expect(x.st == COMMITTED and m23Safe)
}

// 設計 2 の、読むだけの取引と、悲観の取引
module m23_alt_green_ro {
  import m23_core(DESIGN = 2, PIN_ROUTING = false, OWNER_REFUSES = true, PEER = false, PEER_PREPARE = false, PINGPONG = false,
                  ASK_BOTH = true, EPOCH_CHECK = true, WAIT_ARRIVAL = true, PARENT_VALIDATES = true, CHILD_FROM = 0, BUMP = true, PUSH = true, BOUNDED = false, FENCE_REFUSES = false,
                  SCAN2 = true, WRITE = false, PESSIMISTIC = false, OTHER = true, HAS_W = true, HAS_Y = true, TICKS = 1, T_MAX = 5).*
}
module m23_alt_green_pess {
  import m23_core(DESIGN = 2, PIN_ROUTING = false, OWNER_REFUSES = true, PEER = false, PEER_PREPARE = false, PINGPONG = false,
                  ASK_BOTH = true, EPOCH_CHECK = true, WAIT_ARRIVAL = true, PARENT_VALIDATES = true, CHILD_FROM = 0, BUMP = true, PUSH = true, BOUNDED = false, FENCE_REFUSES = false,
                  SCAN2 = false, WRITE = true, PESSIMISTIC = true, OTHER = true, HAS_W = true, HAS_Y = true, TICKS = 1, T_MAX = 5).*
}

// 赤: Worker が、動いた範囲の確かめを、読んだシャード (親) だけへ送る
module m23_alt_red_parent_alone {
  import m23_core(DESIGN = 2, PIN_ROUTING = false, OWNER_REFUSES = true, PEER = false, PEER_PREPARE = false, PINGPONG = false,
                  ASK_BOTH = false, EPOCH_CHECK = true, WAIT_ARRIVAL = true, PARENT_VALIDATES = true, CHILD_FROM = 0, BUMP = true, PUSH = true, BOUNDED = false, FENCE_REFUSES = false,
                  SCAN2 = true, WRITE = true, PESSIMISTIC = false, OTHER = true, HAS_W = true, HAS_Y = true, TICKS = 1, T_MAX = 5).*
  run counterexampleTest =
    init.then(xBegin)
        .then(xAnswer(K1, false, P)).then(xAnswer(K2, false, P))
        .then(start).then(pull).then(recv)
        .then(wWrite(C))                                               // c = 2
        .then(finish)                                                  // 床 2
        .then(xAnswer(K1, false, P)).then(xNotOwner).then(xTooOld(K2, false))
        .expect(x.rRem == Set((K1, P), (K2, P)))
        .then(confirmP(K1)).then(confirmP(K2))                         // epoch は移動を知っているので、親が答える
        .expect(x.T == 2)
        .then(xAnswer(K2, false, C)).then(xAnswer(K2, true, C)).then(xPrepareC).then(xPrepareP)
        .expect(x.st == COMMITTED and not(serializable))
}

// 赤: 親が、要求の epoch を見ずに、渡したグループの確かめに答える。範囲表の古い Worker は、子に尋ねない
module m23_alt_red_no_epoch {
  import m23_core(DESIGN = 2, PIN_ROUTING = false, OWNER_REFUSES = true, PEER = false, PEER_PREPARE = false, PINGPONG = false,
                  ASK_BOTH = true, EPOCH_CHECK = false, WAIT_ARRIVAL = true, PARENT_VALIDATES = true, CHILD_FROM = 0, BUMP = true, PUSH = true, BOUNDED = false, FENCE_REFUSES = false,
                  SCAN2 = true, WRITE = true, PESSIMISTIC = false, OTHER = true, HAS_W = true, HAS_Y = true, TICKS = 1, T_MAX = 5).*
  run counterexampleTest =
    init.then(xBegin)
        .then(xAnswer(K1, false, P)).then(xAnswer(K2, false, P))
        .then(start).then(pull).then(recv)
        .then(wWrite(C))                                               // c = 2
        .then(xOther(3))                                               // 範囲表の古い X (epoch 0)
        .expect(x.ep == 0 and x.rRem == Set((K1, P), (K2, P)))
        .then(confirmP(K1)).then(confirmP(K2))
        .expect(x.T == 3)
        .then(xAnswer(K1, false, P)).then(xNotOwner).then(xAnswer(K2, false, C))
        .then(xAnswer(K2, true, C)).then(xPrepareC).then(xPrepareP)
        .expect(x.st == COMMITTED and not(serializable))
}

// 赤: 子が、自分の記録を床から確かめる (設計 1 の m23_red_child_from_floor と同じ条件)
module m23_alt_red_child_from_floor {
  import m23_core(DESIGN = 2, PIN_ROUTING = false, OWNER_REFUSES = true, PEER = false, PEER_PREPARE = false, PINGPONG = false,
                  ASK_BOTH = true, EPOCH_CHECK = true, WAIT_ARRIVAL = true, PARENT_VALIDATES = true, CHILD_FROM = 1, BUMP = true, PUSH = true, BOUNDED = false, FENCE_REFUSES = false,
                  SCAN2 = true, WRITE = true, PESSIMISTIC = false, OTHER = true, HAS_W = true, HAS_Y = true, TICKS = 1, T_MAX = 5).*
}

// 赤: 子が、グループが届く前に答える。親で prepare された intent が pull の応答に乗って飛んでいる間に、子は「記録なし」と答え、
// 届いた後に、親は「intent なし」と答える。どちらも intent を push しない
module m23_alt_red_unarrived {
  import m23_core(DESIGN = 2, PIN_ROUTING = false, OWNER_REFUSES = true, PEER = false, PEER_PREPARE = false, PINGPONG = false,
                  ASK_BOTH = true, EPOCH_CHECK = true, WAIT_ARRIVAL = false, PARENT_VALIDATES = true, CHILD_FROM = 0, BUMP = true, PUSH = true, BOUNDED = false, FENCE_REFUSES = false,
                  SCAN2 = true, WRITE = true, PESSIMISTIC = false, OTHER = true, HAS_W = true, HAS_Y = true, TICKS = 1, T_MAX = 5).*
  run counterexampleTest =
    init.then(xBegin)
        .then(xAnswer(K1, false, P)).then(xAnswer(K2, false, P))      // T = 0
        .then(yPrepare(P))                                             // pts 1
        .then(start).then(pull)                                        // m = 2。応答 (行と intent) が飛んでいる
        .then(xAnswer(K1, false, P)).then(xNotOwner)
        .then(xOther(3))
        .expect(x.rRem == Set((K1, P), (K2, P), (K2, C)))
        .then(confirmC)                                                // 届いていない。記録も intent もない
        .then(recv)                                                    // intent は子へ
        .then(confirmP(K1)).then(confirmP(K2))                         // 親にはもう intent がない
        .expect(x.T == 3 and y.pushed == 0)
        .then(yDecide(2)).then(yPhase2)                                // c = 2 <= 3
        .then(xAnswer(K2, false, C))
        .expect(x.seen.get(K2) == Set(0, Y))
        .then(xAnswer(K2, true, C)).then(xPrepareC).then(xPrepareP)
        .expect(x.st == COMMITTED and not(serializable))
}

// 赤: 確定で、Worker が親を K2 の検証の参加者に入れない。子は、床より小さい T の検証を自分の記録だけで通す
module m23_alt_red_prepare_alone {
  import m23_core(DESIGN = 2, PIN_ROUTING = false, OWNER_REFUSES = true, PEER = false, PEER_PREPARE = false, PINGPONG = false,
                  ASK_BOTH = true, EPOCH_CHECK = true, WAIT_ARRIVAL = true, PARENT_VALIDATES = false, CHILD_FROM = 0, BUMP = true, PUSH = true, BOUNDED = false, FENCE_REFUSES = false,
                  SCAN2 = true, WRITE = true, PESSIMISTIC = false, OTHER = true, HAS_W = true, HAS_Y = true, TICKS = 1, T_MAX = 5).*
}
