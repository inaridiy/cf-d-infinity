// M19: 移動の途中のテナントの読みを通す (Worker が claim を piece で分け直す)
//
// 背景。M18 は、1 つの shard key の行を 2 つのシャードに分けて持てることを示した。テナントの読み (WHERE tenant = ?) では、
// Worker は shard key しか知らない。シャードは、手放した piece か、届ききっていない piece に重なる claim を断る。
// 大きなテナントが移る間 (1 GB で約 4 分)、範囲表のとおりの claim はどちらのシャードにも断られ、主キーを名指ししない文が
// migrating: で失敗する。持ち主は、これを認めないと決めた (2026-11-14、docs/design-subslots.md の判断 3)。
// M18 が示したのは「claim をどう分けても安全」までで、Worker が分け方を知る手順と、やり直しが終わることはモデルになかった。
//
// 設計。断る応答が、そのシャードの piece の表を運ぶ。
//   親 P の表: 手放した piece (m を決めた piece) と、その m
//   子 C の表: 届いた piece と、その m
// Worker は、表のとおりに claim を分け直して、同じ読み (同じ時刻 T) を続ける。
//   P に断られた: claim のうち P が手放した piece を、C の claim へ移す。その piece は「手放したと P が言った piece」として覚える (sure)
//   C に断られた: claim のうち C に届いていない piece で、sure でないものを、P の claim へ移す
//   表の m が T より大きい: T では、その piece をどちらも答えられない (P は手放し、C は T < m を断る)。
//                           T を表の m の最大まで上げ、それまでの答えを捨てて、全部の piece を同じ T で聞き直す
// シャードの規則は M18 と同じである。P は claim の全部をいま持っているとき、C は claim の全部が届いていて T がどの m よりも
// 小さくないときだけ答え、claim の中の行だけを返す。Worker の表は古くてよい。古ければ、また断られて表を受け取るだけである。
// C は、sure の piece が届いていなければ、断らずに待つ (実装では、その piece だけを pull する。P が切った後なので、待ちは 1 通分)。
// sure でない piece が届いていなければ、待たずに断る (範囲表のとおりの claim で待つと、テナントの全体を pull することになる)。
//
// 終わること。P が断るたびに、Worker の知らなかった cut が 1 つ以上ある。C が断るたびに、sure でない piece が P へ移るか、
// T が上がる。piece は有限で、cut は取り消されないので、1 つの読みが断られる回数には上限がある (boundedRetries)。
// 断られも答えられもしない claim は、切られた piece の到着か X の phase 2 を待っていて、その手はいつでも打てる (readNotStuck)。
// この 2 つは安全性の形で確かめる。活性そのもの (readTerminates) は、公平性を仮定して、小さいインスタンス (m19_live) で確かめる。
// 新しい piece を切る手には公平性を置かないので、移動が途中で止まっても読みは揃う。
//
// モデル。M18 と同じ舞台である。親 P (=1)、子 C (=2)、テナント 1 つ。piece 1 は subslot の下の範囲にあって P に残り、
// piece 2 以降は上の範囲にあって、1 つずつ C へ移る。piece は主キーの順に並んだ区間で、番号がその順である。
// 移動 (fence、範囲表の切り替え、pull、応答の喪失と再送、m の持ち運び)、blind write、取引 X は M18 から写した。
// M18 との違いは読みだけである。Worker は 1 つの読みについて、P と C に出している claim、覚えた sure、受け取った答えを持つ。
// 最初の claim は、範囲表の版 0 (全部を P)、版 1 (piece 1 を P、残りを C)、または任意の分け方 (ANY_START。古い表の控え) である。
//
// invariants
//   readConsistent:   揃った答えは、T 時点の真の行の集合と一致する。どの piece も、ちょうど 1 つのシャードが答える
//   answeredOnlyHeld: シャードは、T の時点で全部を持っていない claim に答えない
//   noWriteBelowRead: 答えた読みの時刻以下の時刻で、同じ piece への書き込みが確定しない
//   boundedRetries:   1 つの読みが断られる回数は RETRY_MAX 以下である
//   readNotStuck:     出している claim は、答えられるか、断られるか、いつでも打てる手 (pull の到着、X の phase 2) を待っている
//   singleOwner / noLostWrite / intentNotLost: M18 と同じ
// temporal
//   readTerminates:   Worker があきらめなければ、始めた読みはいつか揃う (公平性の仮定は、定義のところに書いた)
module m19_core {
  const NPIECE: int               // piece の数。1 は残り、2 以降は移る
  const WLO: int                  // blind write は piece WLO..NPIECE に 1 件ずつ。id は piece の番号
  const X1: int                   // 取引 X が書く piece (2 つ)。0 なら X なし
  const X2: int
  const MAP_CURRENT: bool         // P は、claim をいまの表で確かめる。false なら、自分の表から作られた claim を確かめずに答える
  const SAME_T: bool              // T を上げたら、それまでの答えを捨てる。false なら、古い T の答えを残して合わせる
  const SPLIT_EXACT: bool         // 分け直した claim は、断られた claim をちょうど覆う。false なら、境目の piece が落ちる
  const KEEP_MAP: bool            // Worker は、P の表 (sure) を読みの間覚えている。false なら忘れる
  const C_REFUSES: bool           // C は、sure でない piece が届いていなければ、待たずに断って表を返す。
                                  // false なら、claim の全部が届くまで待つ (M18 までの子。範囲表のとおりの claim しかない場合)
  const CARRY_CLOCK: bool         // piece が時刻 m を運び、子の時計を m まで進める
  const TRACK_READS: bool         // 答えた読みの時刻を覚える (noWriteBelowRead のための ghost)
  const ANY_START: bool           // 最初の claim の分け方は任意。false なら範囲表の版 0 か版 1
  const NREAD: int                // テナントの読みを始める回数の上限
  const GIVE_UP: bool             // Worker は、進行中の読みをあきらめて捨てることがある。活性を確かめるインスタンスでは false
  const CLOCK_MAX: int
  const T_MAX: int
  const RETRY_MAX: int

  pure val P = 1
  pure val C = 2
  pure val DOMS = Set(P, C)
  pure val PIECES = 1.to(NPIECE)
  pure val STAY = Set(1)
  pure val MOVE = 2.to(NPIECE)
  pure val WRITES = WLO.to(NPIECE)
  pure val X = 9
  pure val XP = Set(X1, X2).exclude(Set(0))          // X が書く piece
  pure def max(a: int, b: int): int = if (a > b) a else b
  pure def maxOf(s: Set[int]): int = s.fold(0, (a, b) => max(a, b))

  type Ver = { ver: int, writer: int }
  type Intent = { where: int, pts: int }                               // where: 0 無し, 1 P, 2 C, 3 適用済み
  type Pull = { p: int, m: int, data: Set[Ver], intents: Set[int] }    // p == 0 なら送信中の pull 無し
  type Part = { d: int, p: int, rows: Set[int] }                       // シャード d が piece p について返した行
  // Worker の 1 つの読み。st: 0 無し, 1 進行中, 2 揃った
  //   askP / askC: P と C に出している claim (まだ答えのない piece)
  //   sure:        P の表で、手放したと分かった piece
  //   mapped:      P の claim は、P の表から作った (この読みで P に 1 度は断られた)
  //   n:           断られた回数
  //   w:           到達の確認のための印 (下の doneCodes)
  type Rd = { st: int, t: int, askP: Set[int], askC: Set[int], sure: Set[int], mapped: bool, parts: Set[Part], n: int, w: Set[int] }
  type Bad = { t: int, p: int, n: int }                                // n: piece p を答えたシャードの数

  var hlc: int -> int
  var hist: int -> (int -> Set[Ver])      // シャード -> piece -> 手元にある行。親は、手放した piece の行を控えとして持ち続ける
  var moved: int -> int                   // P: piece -> m (0 = 未移動)
  var arrived: int -> int                 // C: piece -> m (0 = 未到着)
  var phase: int                          // 0 分割の前, 1 範囲表は切り替わったが fence の前, 2 fence の後
  var pending: Set[int]
  var truth: int -> Set[Ver]              // ghost: piece -> 確定した行
  var pullMsg: Pull
  var xi: int -> Intent                   // piece -> X の intent
  var xc: int                             // X の確定の時刻 (0 = 未決定)
  var xpushed: int
  var rd: Rd
  var reads: int                          // 始めた読みの数
  var badRead: bool                       // ghost: 揃った答えが、読みの時刻 T の真の行と違う
  var fractured: bool                     // ghost: 揃った答えが、どの時刻の真の行とも違う
  var lastBad: Bad
  var unheld: bool                        // ghost: シャードが、T の時点で持っていない piece を答えた
  var served: int -> int                  // ghost: piece -> 答えた読みの時刻の最大
  var lateWrite: bool                     // ghost: 答えた読みの時刻以下で、書き込みが確定した

  pure val noPull: Pull = { p: 0, m: 0, data: Set(), intents: Set() }
  pure val noRd: Rd = { st: 0, t: 0, askP: Set(), askC: Set(), sure: Set(), mapped: false, parts: Set(), n: 0, w: Set() }
  pure val noBad: Bad = { t: 0, p: 0, n: 0 }
  pure val noIntent: Intent = { where: 0, pts: 0 }
  pure val initVers: Set[Ver] = Set({ ver: 0, writer: 0 })

  pure def rowsAt(vs: Set[Ver], t: int): Set[int] = vs.filter(v => v.ver <= t).map(v => v.writer)
  pure def partsOf(parts: Set[Part], p: int): Set[Part] = parts.filter(a => a.p == p)
  pure def answeredBy(parts: Set[Part], d: int): Set[int] = parts.filter(a => a.d == d).map(a => a.p)

  action init = all {
    hlc' = DOMS.mapBy(_ => 0),
    hist' = Map(P -> PIECES.mapBy(_ => initVers), C -> PIECES.mapBy(_ => Set())),
    moved' = PIECES.mapBy(_ => 0), arrived' = PIECES.mapBy(_ => 0),
    phase' = 0,
    pending' = WRITES, truth' = PIECES.mapBy(_ => initVers),
    pullMsg' = noPull,
    xi' = PIECES.mapBy(_ => noIntent), xc' = 0, xpushed' = 0,
    rd' = noRd, reads' = 0, badRead' = false, fractured' = false, lastBad' = noBad, unheld' = false,
    served' = PIECES.mapBy(_ => 0), lateWrite' = false
  }

  action keepMove = all { moved' = moved, arrived' = arrived, phase' = phase, pullMsg' = pullMsg }
  action keepData = all { hist' = hist, truth' = truth, pending' = pending }
  action keepX = all { xi' = xi, xc' = xc, xpushed' = xpushed }
  action keepRead = all { rd' = rd, reads' = reads, badRead' = badRead, fractured' = fractured, lastBad' = lastBad, unheld' = unheld }
  action keepGhost = all { served' = served, lateWrite' = lateWrite }

  // ---- 所有 -------------------------------------------------------------------
  def pOwns(p: int): bool = moved.get(p) == 0
  def cOwns(p: int): bool = arrived.get(p) > 0
  def holds(d: int, p: int): bool = if (d == P) pOwns(p) else cOwns(p)
  // C を知り得るか。Meta が範囲表を切り替えた後か、親が fence した後 (NotOwner の応答が宛先を教える)
  def knowsSplit: bool = phase > 0
  def fenced: bool = phase == 2

  // ---- 時計 -------------------------------------------------------------------
  action tick(d: int): bool = all {
    hlc.get(d) < CLOCK_MAX,
    hlc' = hlc.set(d, hlc.get(d) + 1),
    keepMove, keepData, keepX, keepRead, keepGhost
  }

  // ---- 所有権の切替 -----------------------------------------------------------
  // 0 -> 1: Meta が範囲表を切り替える。0 -> 2、1 -> 2: 親が上の範囲への新規受理を止める (M18 の fence と switchRoute。
  // fence の後は、範囲表が切り替わっていてもいなくても、このモデルの動きは同じなので、1 つの状態にまとめた)
  action advance(ph: int): bool = all {
    ph > phase, ph <= 2,
    phase' = ph,
    moved' = moved, arrived' = arrived, pullMsg' = pullMsg,
    hlc' = hlc, keepData, keepX, keepRead, keepGhost
  }

  // ---- 書き込み (blind) -------------------------------------------------------
  // Worker は主キーを知っているので、piece で宛先を決める。シャードは piece の持ち主であることを確かめる (M18 の WRITE_BY_PIECE)
  action write(d: int, id: int): bool = all {
    pending.contains(id),
    d == P or (knowsSplit and MOVE.contains(id)),
    if (d == P) (pOwns(id) and not(fenced and MOVE.contains(id))) else cOwns(id),
    val c = hlc.get(d) + 1
    val v = { ver: c, writer: id }
    all {
      hlc' = hlc.set(d, c),
      hist' = hist.set(d, hist.get(d).set(id, hist.get(d).get(id).union(Set(v)))),
      truth' = truth.set(id, truth.get(id).union(Set(v))),
      pending' = pending.exclude(Set(id)),
      lateWrite' = (lateWrite or c <= served.get(id)),
      served' = served,
      keepMove, keepX, keepRead
    }
  }

  // ---- pull -------------------------------------------------------------------
  // 子が親に piece を要求し、親が応答する (1 アクション)。親は moved[p] = m を永続化してから応答する。再送は同じ m で答える
  action pull(p: int): bool = all {
    MOVE.contains(p), knowsSplit,
    arrived.get(p) == 0, pullMsg.p == 0,
    val first = moved.get(p) == 0
    val m = if (first) hlc.get(P) + 1 else moved.get(p)
    val carried = XP.filter(q => xi.get(q).where == P and q == p)
    all {
      moved' = moved.set(p, m),
      hlc' = if (first) hlc.set(P, m) else hlc,
      pullMsg' = { p: p, m: m, data: hist.get(P).get(p), intents: carried },
      arrived' = arrived, phase' = phase,
      keepData, keepX, keepRead, keepGhost
    }
  }

  // 子が応答を受け取り、piece を持つ。時計を m まで進める。載っていた intent は子へ移る
  action recvPull = all {
    pullMsg.p != 0,
    val p = pullMsg.p
    val m = pullMsg.m
    all {
      arrived' = arrived.set(p, m),
      hlc' = if (CARRY_CLOCK) hlc.set(C, max(hlc.get(C), m)) else hlc,
      hist' = hist.set(C, hist.get(C).set(p, pullMsg.data)),
      xi' = PIECES.mapBy(q => if (pullMsg.intents.contains(q) and xi.get(q).where == P) xi.get(q).with("where", C) else xi.get(q)),
      pullMsg' = noPull,
      moved' = moved, phase' = phase,
      truth' = truth, pending' = pending, xc' = xc, xpushed' = xpushed,
      keepRead, keepGhost
    }
  }

  // 応答が失われる (親または子の再起動)。子は後で pull をやり直す
  action losePull = all {
    pullMsg.p != 0,
    pullMsg' = noPull,
    moved' = moved, arrived' = arrived, phase' = phase,
    hlc' = hlc, keepData, keepX, keepRead, keepGhost
  }

  // ---- テナントの中のクロスシャード取引 X ----------------------------------------
  action prepareX(d: int, p: int): bool = all {
    XP.contains(p), xi.get(p).where == 0,
    holds(d, p),
    d == P or knowsSplit,
    val pts = hlc.get(d) + 1
    all {
      hlc' = hlc.set(d, pts),
      xi' = xi.set(p, { where: d, pts: pts }),
      xc' = xc, xpushed' = xpushed,
      keepMove, keepData, keepRead, keepGhost
    }
  }
  // anchor が c を決める。全部の prepare_ts 以上で、push された時刻より大きい。この時点で X は確定している。
  // c は、許されるいちばん小さい時刻か、その次である (dc は 0 か 1)
  def maxPts: int = XP.fold(0, (a, p) => max(a, xi.get(p).pts))
  action decideX(dc: int): bool = all {
    XP != Set(), xc == 0,
    XP.forall(p => xi.get(p).where == P or xi.get(p).where == C),
    val c = max(maxPts, xpushed + 1) + dc
    all {
      xc' = c,
      truth' = PIECES.mapBy(p => if (XP.contains(p)) truth.get(p).union(Set({ ver: c, writer: X })) else truth.get(p)),
      lateWrite' = (lateWrite or XP.exists(p => c <= served.get(p))),
      served' = served,
      xi' = xi, xpushed' = xpushed, hist' = hist, pending' = pending,
      hlc' = hlc, keepMove, keepRead
    }
  }
  // phase 2 は piece ごとに、moved 表で決めた持ち主に届く。親が m を決めた後は子。子が未到着なら適用せず待つ
  def phase2Enabled(p: int): bool = and {
    XP.contains(p), xc > 0,
    xi.get(p).where == P or xi.get(p).where == C,
    holds(if (moved.get(p) > 0) C else P, p)
  }
  action phase2X(p: int): bool = all {
    phase2Enabled(p),
    val o = if (moved.get(p) > 0) C else P
    all {
      hist' = hist.set(o, hist.get(o).set(p, hist.get(o).get(p).union(Set({ ver: xc, writer: X })))),
      hlc' = hlc.set(o, max(hlc.get(o), xc)),
      xi' = xi.set(p, xi.get(p).with("where", 3)),
      xc' = xc, xpushed' = xpushed, truth' = truth, pending' = pending,
      keepMove, keepRead, keepGhost
    }
  }

  // ---- 読み -------------------------------------------------------------------
  // intent がある piece を読むとき。pts <= T かつ c 未決定なら push (c > T を強制)、c 決定済みで c <= T かつ未適用なら待つ
  def xBlocks(d: int, p: int, t: int): bool =
    XP.contains(p) and xi.get(p).where == d and xi.get(p).pts <= t and xc > 0 and xc <= t
  def xPushes(d: int, p: int, t: int): bool =
    XP.contains(p) and xi.get(p).where == d and xi.get(p).pts <= t and xc == 0

  // Worker がテナントの読みを始める。P の claim を k、C の claim を残りの piece にする。
  // 版 0 は k = 全部、版 1 は k = {1}。ANY_START なら k は何でもよい (前の読みで覚えた表が古くなっている場合を含む)
  action startRead(t: int, k: Set[int]): bool = all {
    rd.st == 0, reads < NREAD,
    k == PIECES or (knowsSplit and (ANY_START or k == STAY)),
    rd' = { st: 1, t: t, askP: k, askC: PIECES.exclude(k), sure: Set(), mapped: false, parts: Set(), n: 0, w: Set() },
    reads' = reads + 1,
    badRead' = badRead, fractured' = fractured, lastBad' = lastBad, unheld' = unheld,
    hlc' = hlc, keepMove, keepData, keepX, keepGhost
  }

  def claimOf(d: int): Set[int] = if (d == P) rd.askP else rd.askC
  // T の時点で、シャード d が piece の集合 k の全部を持っているか (モデルの事実。規則ではない)
  def heldAt(d: int, k: Set[int], t: int): bool =
    if (d == P) k.forall(p => moved.get(p) == 0) else k.forall(p => arrived.get(p) > 0 and t >= arrived.get(p))
  // シャードの規則。P は claim の全部をいま持っているとき、C は全部が届いていて T がどの m よりも小さくないとき、答える。
  // MAP_CURRENT = false の P は、自分の表から作られた claim (分け直した後の claim) を、いまの表と照らさずに答える
  def mayAnswer(d: int): bool =
    if (d == P) (rd.askP.forall(p => pOwns(p)) or (not(MAP_CURRENT) and rd.mapped))
    else rd.askC.forall(p => cOwns(p) and rd.t >= arrived.get(p))

  // 合わせた答えの確認。どの piece も、ちょうど 1 つのシャードが答え、その行が T 時点の真の行と一致する
  def pieceBad(parts: Set[Part], p: int, t: int): bool =
    partsOf(parts, p).size() != 1 or partsOf(parts, p).exists(a => a.rows != rowsAt(truth.get(p), t))
  def anyBad(parts: Set[Part], t: int): bool = PIECES.exists(p => pieceBad(parts, p, t))
  def badOf(parts: Set[Part], t: int): Bad =
    val p = PIECES.fold(0, (a, q) => if (a == 0 and pieceBad(parts, q, t)) q else a)
    { t: t, p: p, n: partsOf(parts, p).size() }

  // 揃ったときの印
  //   1: 分け直した後で、P が上の範囲のまだ手放していない piece を、C が届いた piece を答えた (移動の途中に揃った)
  //   3: 1 に加えて、揃った時点で、切られて飛んでいる piece がある
  //   5: 分け直した後で、P の答えと C の答えの両方が X の行を含む
  // 進行中に付く印
  //   2: P に 2 度断られた (読みの間に piece が移った)
  //   4: T を上げて聞き直した
  def doneCodes(r: Rd): Set[int] =
    val mid = r.n > 0 and r.parts.exists(a => a.d == P and MOVE.contains(a.p)) and r.parts.exists(a => a.d == C)
    val flying = PIECES.exists(p => moved.get(p) > 0 and arrived.get(p) == 0)
    val sawX = r.parts.exists(a => a.d == P and a.rows.contains(X)) and r.parts.exists(a => a.d == C and a.rows.contains(X))
    Set(if (mid) 1 else 0, if (mid and flying) 3 else 0, if (r.n > 0 and sawX) 5 else 0).exclude(Set(0))
  // 出している claim がなくなったら、Worker は答えを合わせる
  pure def isDone(r: Rd): bool = r.askP == Set() and r.askC == Set()
  def closed(r: Rd): Rd = if (isDone(r)) { ...noRd, st: 2, w: r.w.union(doneCodes(r)) } else r
  // T を上げて聞き直す。それまでの答えを捨て、答えたシャードに同じ piece を聞き直す。sure は残す
  pure def restart(r: Rd, t2: int): Rd =
    if (SAME_T) { ...r, t: t2, parts: Set(), w: r.w.union(Set(4)),
                  askP: r.askP.union(answeredBy(r.parts, P)), askC: r.askC.union(answeredBy(r.parts, C)) }
    else { ...r, t: t2, w: r.w.union(Set(4)) }

  action readEffects(r: Rd): bool = all {
    rd' = closed(r), reads' = reads,
    badRead' = (badRead or (isDone(r) and anyBad(r.parts, r.t))),
    fractured' = (fractured or (isDone(r) and 0.to(T_MAX + 8).forall(t => anyBad(r.parts, t)))),
    lastBad' = if (not(badRead) and isDone(r) and anyBad(r.parts, r.t)) badOf(r.parts, r.t) else lastBad
  }

  // シャード d が、出ている claim に答える。claim の中の piece の行だけを返す (M18 の ANSWER_BY_CLAIM)
  action answer(d: int): bool = all {
    rd.st == 1, claimOf(d) != Set(),
    mayAnswer(d),
    claimOf(d).forall(p => not(xBlocks(d, p, rd.t))),
    val k = claimOf(d)
    val t = rd.t
    val parts = rd.parts.union(k.map(p => { d: d, p: p, rows: rowsAt(hist.get(d).get(p), t) }))
    all {
      readEffects(if (d == P) { ...rd, askP: Set(), parts: parts } else { ...rd, askC: Set(), parts: parts }),
      unheld' = (unheld or not(heldAt(d, k, t))),
      hlc' = hlc.set(d, max(hlc.get(d), t)),
      xpushed' = if (k.exists(p => xPushes(d, p, t))) max(xpushed, t) else xpushed,
      served' = if (TRACK_READS) PIECES.mapBy(p => if (k.contains(p)) max(served.get(p), t) else served.get(p)) else served,
      xi' = xi, xc' = xc, lateWrite' = lateWrite,
      keepMove, keepData
    }
  }

  // P が断り、表を返す (手放した piece と m)。Worker は、claim のうち手放された piece を C の claim へ移す。
  // その m が T より大きければ、T を上げて聞き直す
  def cutNow: Set[int] = PIECES.filter(p => moved.get(p) > 0)
  def afterRefuseP: Rd =
    val cutIn = rd.askP.intersect(cutNow)
    val toC = if (SPLIT_EXACT) cutIn else cutIn.exclude(Set(maxOf(cutIn)))   // 境目 (区間の終わり) を含めない
    val t2 = maxOf(cutIn.map(p => moved.get(p)))
    val r = { ...rd, askP: rd.askP.exclude(cutIn), askC: rd.askC.union(toC),
              sure: if (KEEP_MAP) rd.sure.union(cutNow) else Set(), mapped: true, n: rd.n + 1,
              w: if (rd.mapped) rd.w.union(Set(2)) else rd.w }
    if (t2 > rd.t) restart(r, t2) else r

  // C が断り、表を返す (届いた piece と m)。断るのは、届いた piece の m が T より大きいときと、sure でない piece が届いていない
  // ときである。sure の piece だけが届いていないなら、断らずに待つ。
  // Worker は、届いていない sure でない piece を P の claim へ移す。届いた piece の m が T より大きければ、T を上げて聞き直す
  def unsureMissing: Set[int] =
    if (C_REFUSES) rd.askC.filter(p => arrived.get(p) == 0 and not(rd.sure.contains(p))) else Set()
  def canRefuseC: bool = rd.askC.exists(p => arrived.get(p) > rd.t) or unsureMissing != Set()
  def afterRefuseC: Rd =
    val toP = unsureMissing
    val t2 = maxOf(rd.askC.map(p => arrived.get(p)))
    val r = { ...rd, askC: rd.askC.exclude(toP), askP: rd.askP.union(toP), n: rd.n + 1 }
    if (t2 > rd.t) restart(r, t2) else r

  action refuse(d: int): bool = all {
    rd.st == 1, claimOf(d) != Set(),
    not(mayAnswer(d)),
    d == P or canRefuseC,
    readEffects(if (d == P) afterRefuseP else afterRefuseC),
    unheld' = unheld,
    hlc' = hlc, keepMove, keepData, keepX, keepGhost
  }

  // Worker が読みを捨てる (あきらめた、または答えを受け取り終えた)
  action forgetRead = all {
    rd.st == 2 or (rd.st == 1 and GIVE_UP),
    rd' = noRd, reads' = reads, badRead' = badRead, fractured' = fractured, lastBad' = lastBad, unheld' = unheld,
    hlc' = hlc, keepMove, keepData, keepX, keepGhost
  }

  // 調べる状態を減らすための 2 つの省略。
  // 揃った読み (st = 2) からは、捨てる手だけを打つ。揃ったまま置いておくのは、捨ててから同じ手を打つのと同じである。
  // 読みを NREAD 回始めて、進行中の読みがなくなったら、その先は調べない。読みに関する不変条件はもう破れようがなく、
  // 残り (singleOwner など) は M18 が調べている。読みの時刻を覚えるインスタンス (TRACK_READS) では、答えた読みより後の
  // 書き込みを見るために、先へ進む
  def readsOver: bool = rd.st == 0 and reads == NREAD and not(TRACK_READS)
  action step = if (rd.st == 2) forgetRead else if (readsOver) all { false, forgetRead } else any {
    { nondet d = oneOf(DOMS) tick(d) },
    { nondet ph = oneOf(Set(1, 2)) advance(ph) },
    { nondet d = oneOf(DOMS) nondet id = oneOf(PIECES) write(d, id) },
    { nondet p = oneOf(PIECES) pull(p) },
    recvPull,
    losePull,
    { nondet d = oneOf(DOMS) nondet p = oneOf(PIECES) prepareX(d, p) },
    { nondet dc = oneOf(Set(0, 1)) decideX(dc) },
    { nondet p = oneOf(PIECES) phase2X(p) },
    { nondet t = oneOf(0.to(T_MAX)) nondet k = oneOf(PIECES.powerset()) startRead(t, k) },
    { nondet d = oneOf(DOMS) answer(d) },
    { nondet d = oneOf(DOMS) refuse(d) },
    forgetRead
  }

  // ---- 不変条件 -------------------------------------------------------------
  val singleOwner = PIECES.forall(p =>
    (hist.get(C).get(p) == Set() or cOwns(p)) and
    (moved.get(p) == 0 or hist.get(P).get(p).forall(v => v.ver < moved.get(p))))
  val readConsistent = not(badRead)
  val readAtSomeT = not(fractured)
  val answeredOnlyHeld = not(unheld)
  def keeper(p: int): int = if (cOwns(p)) C else P
  def unapplied(p: int): Set[Ver] =
    if (XP.contains(p) and xc > 0 and (xi.get(p).where == P or xi.get(p).where == C)) Set({ ver: xc, writer: X }) else Set()
  val noLostWrite = PIECES.forall(p => hist.get(keeper(p)).get(p).union(unapplied(p)) == truth.get(p))
  val intentNotLost = XP.forall(p =>
    (xi.get(p).where != P or not(cOwns(p))) and (xi.get(p).where != C or cOwns(p)))
  val noWriteBelowRead = not(lateWrite)
  // 1 つの読みが断られる回数の上限。断る手に、この数での歯止めは付けていない
  val boundedRetries = rd.n <= RETRY_MAX
  // 進行中の読みは行き止まりにいない。出している claim ごとに、次のどれかが成り立つ。
  //   答えられる (X の適用を待っているなら、その phase 2 がいま打てる)
  //   断られる (表が返り、claim が分け直される)
  //   C が、sure の piece の到着を待っている。その piece は P が切っていて、pull か受け取りがいま打てる
  val readNotStuck = rd.st != 1 or and {
    not(isDone(rd)),
    rd.askP == Set() or not(rd.askP.forall(p => pOwns(p)))
      or rd.askP.forall(p => not(xBlocks(P, p, rd.t)) or phase2Enabled(p)),
    rd.askC == Set() or canRefuseC
      or rd.askC.forall(p => if (cOwns(p)) (not(xBlocks(C, p, rd.t)) or phase2Enabled(p))
                             else (rd.sure.contains(p) and moved.get(p) > 0 and MOVE.contains(p) and knowsSplit))
  }
  val resplitSafe = and {
    singleOwner, readConsistent, readAtSomeT, answeredOnlyHeld, noLostWrite, intentNotLost, noWriteBelowRead,
    boundedRetries, readNotStuck
  }

  // ---- 活性 -------------------------------------------------------------------
  // 始めた読みは、Worker があきらめなければ、いつか揃う。移動がそれ以上進まなくても (新しい piece が切られなくても) 揃う。
  // 仮定する公平性は次のとおりで、新しい piece を切る手 (最初の pull) には公平性を置かない。
  //   シャードは、出ている claim に、答えられるなら答え、断るなら断る (弱い公平性)
  //   切った piece の pull は、届くまでやり直される (repull の弱い公平性)。応答は失われ続けない (recvPull の強い公平性)
  //   X の phase 2 は、いつか届く (弱い公平性)
  action repull = { nondet p = oneOf(PIECES) all { moved.get(p) > 0, pull(p) } }
  action phase2Any = { nondet p = oneOf(PIECES) phase2X(p) }
  val vars = (hlc, hist, moved, arrived, phase, pending, truth, pullMsg, xi, xc, xpushed, rd, reads,
              badRead, fractured, lastBad, unheld, served, lateWrite)
  temporal fairness = and {
    weakFair(answer(P), vars), weakFair(answer(C), vars), weakFair(refuse(P), vars), weakFair(refuse(C), vars),
    weakFair(repull, vars), strongFair(recvPull, vars), weakFair(phase2Any, vars)
  }
  temporal readTerminates = fairness implies always(rd.st == 1 implies eventually(rd.st == 2))

  // witness
  // 移動の途中のテナントの読みが、分け直した後で、両方のシャードの答えで揃う
  val witnessResplitWhileMoving = not(rd.st == 2 and rd.w.contains(1))
  // 読みの間に piece が移り、P に 2 度断られてから揃う
  val witnessResplitTwice = not(rd.st == 2 and rd.w.contains(2))
  // 揃った時点で、切られて飛んでいる piece がある (P は、その piece を切る前に T で答えた)
  val witnessDoneWhilePieceFlying = not(rd.st == 2 and rd.w.contains(3))
  // T を上げて聞き直してから揃う
  val witnessRestartedThenDone = not(rd.st == 2 and rd.w.contains(4))
  // 分け直した読みが、P の答えと C の答えの両方に X の行を見る
  val witnessXSeenOnBoth = not(rd.st == 2 and rd.w.contains(5))
  // 断られる回数が上限に届く (上限がきついことの確認)
  val witnessRetryMaxReached = not(rd.n == RETRY_MAX)
}

// 修正版 (green)。piece 1 は親に残り、piece 2 と piece 3 が別々に子へ移る。取引 X は piece 1 と piece 2 に書き、
// blind write は piece 3 に 1 件。最初の claim は範囲表の版 0 か版 1
module m19_green {
  import m19_core(NPIECE = 3, WLO = 3, X1 = 1, X2 = 2,
                  MAP_CURRENT = true, SAME_T = true, SPLIT_EXACT = true, KEEP_MAP = true, C_REFUSES = true,
                  CARRY_CLOCK = true, TRACK_READS = false, ANY_START = false, NREAD = 1, GIVE_UP = true, CLOCK_MAX = 0, T_MAX = 3, RETRY_MAX = 3).*
  run resplitTest =
    init.then(write(P, 3))                        // P が piece 3 に 1 で書く
        .then(prepareX(P, 2))                     // X の intent を piece 2 に置く (P、pts 2)
        .then(prepareX(P, 1))                     // piece 1 にも置く (P、pts 3)
        .then(advance(2))                         // fence
        .then(pull(2)).then(recvPull)             // piece 2 が C へ移る (m = 4)。X の intent も運ぶ
        .then(decideX(0))                         // c = 3
        .then(phase2X(2)).then(phase2X(1))        // piece 2 の分は C で、piece 1 の分は P で適用
        .then(startRead(4, PIECES))               // 版 0 の Worker。P に全部を T = 4 で聞く
        .expect(not(mayAnswer(P)))
        .then(refuse(P))                          // P は断り、表 {2: m = 4} を返す。4 <= 4 なので T はそのまま
        .expect(rd.askP == Set(1, 3) and rd.askC == Set(2) and rd.sure == Set(2) and rd.n == 1 and rd.t == 4)
        .then(answer(P))                          // P が piece 1 と、fence したがまだ切っていない piece 3 を答える
        .expect(rd.parts == Set({ d: P, p: 1, rows: Set(0, X) }, { d: P, p: 3, rows: Set(0, 3) }))
        .then(answer(C))                          // C が piece 2 を答えて揃う
        .expect(rd.st == 2 and rd.w == Set(1, 5) and not(badRead) and resplitSafe)
  // 読みの間に piece 3 が移る
  run movedDuringReadTest =
    init.then(prepareX(P, 2)).then(prepareX(P, 1))
        .then(advance(2))
        .then(pull(2)).then(recvPull)             // m = 3
        .then(decideX(0))                         // c = 2
        .then(phase2X(2)).then(phase2X(1))
        .then(startRead(3, PIECES)).then(refuse(P))   // T = 3。表 {2: 3}
        .then(pull(3))                            // m = 4 (P の時計は 3)。応答は飛んでいる
        .then(refuse(P))                          // 2 度目。表 {2: 3, 3: 4}。4 > 3 なので、T を 4 に上げて聞き直す
        .expect(rd.t == 4 and rd.askP == Set(1) and rd.askC == Set(2, 3) and rd.n == 2 and rd.parts == Set())
        .then(answer(P))
        .expect(not(mayAnswer(C)) and not(canRefuseC))   // piece 3 は sure で、まだ届いていない。C は断らずに待つ
        .then(recvPull)
        .then(answer(C))
        .expect(rd.st == 2 and rd.w == Set(2, 4, 5) and not(badRead) and resplitSafe)
  // P が piece 3 を T で答えた後で piece 3 が切られ、飛んでいる間に C の答えで揃う
  run flyingTest =
    init.then(advance(2))
        .then(pull(2)).then(recvPull)             // m = 1
        .then(startRead(2, PIECES)).then(refuse(P))
        .then(answer(P))                          // P が piece 1 と piece 3 を T = 2 で答える。P の時計は 2
        .then(pull(3))                            // m = 3 > T
        .then(answer(C))
        .expect(rd.st == 2 and rd.w == Set(1, 3) and not(badRead) and resplitSafe)
}

// 答えた読みの時刻を覚えて、noWriteBelowRead も確かめる。状態が増えるので、blind write は piece 3 の 1 件だけにしてある
module m19_green_clock {
  import m19_core(NPIECE = 3, WLO = 3, X1 = 1, X2 = 2,
                  MAP_CURRENT = true, SAME_T = true, SPLIT_EXACT = true, KEEP_MAP = true, C_REFUSES = true,
                  CARRY_CLOCK = true, TRACK_READS = true, ANY_START = false, NREAD = 1, GIVE_UP = true, CLOCK_MAX = 0, T_MAX = 2, RETRY_MAX = 3).*
  run clockCarriedTest =
    init.then(advance(2))
        .then(pull(2)).then(recvPull)             // piece 2 が C へ移る (m = 1)
        .then(startRead(2, PIECES)).then(refuse(P))
        .then(answer(P))                          // P が piece 1 と、まだ切っていない piece 3 を T = 2 で答える。P の時計は 2
        .then(pull(3)).then(recvPull)             // piece 3 が移る (m = 3)。C の時計は 3 になる
        .then(write(C, 3))                        // C の書き込みは 4。T より後である
        .expect(hlc.get(C) == 4 and not(lateWrite))
        .then(answer(C))
        .expect(rd.st == 2 and not(badRead) and resplitSafe)
}

// 最初の claim の分け方を任意にする (Worker が前の読みで覚えた表が古くなっている場合を含む)。取引 X はない
module m19_green_any {
  import m19_core(NPIECE = 3, WLO = 2, X1 = 0, X2 = 0,
                  MAP_CURRENT = true, SAME_T = true, SPLIT_EXACT = true, KEEP_MAP = true, C_REFUSES = true,
                  CARRY_CLOCK = true, TRACK_READS = false, ANY_START = true, NREAD = 1, GIVE_UP = true, CLOCK_MAX = 1, T_MAX = 2, RETRY_MAX = 3).*
  // 全部を C に聞くところから始める。C は piece 1 を持たず、P は piece 2 を手放している
  run wrongStartTest =
    init.then(advance(2))
        .then(pull(2)).then(recvPull)             // piece 2 が C へ移る (m = 1)
        .then(startRead(1, Set()))                // P には何も聞かず、C に全部を聞く
        .then(refuse(C))                          // C の表 {2: 1}。届いていない piece 1 と piece 3 を P へ
        .expect(rd.askP == Set(1, 3) and rd.askC == Set(2) and rd.n == 1)
        .then(answer(C)).then(answer(P))
        .expect(rd.st == 2 and rd.w == Set(1) and not(badRead) and resplitSafe)
}

// 最初の claim の分け方は任意で、取引 X が、移る piece 2 つ (piece 2 と piece 3) に書く。blind write はない
module m19_green_any_x {
  import m19_core(NPIECE = 3, WLO = 4, X1 = 2, X2 = 3,
                  MAP_CURRENT = true, SAME_T = true, SPLIT_EXACT = true, KEEP_MAP = true, C_REFUSES = true,
                  CARRY_CLOCK = true, TRACK_READS = false, ANY_START = true, NREAD = 1, GIVE_UP = true, CLOCK_MAX = 0, T_MAX = 2, RETRY_MAX = 3).*
}

// 活性 (readTerminates) を確かめるインスタンス。Worker は読みをあきらめない。取引 X はあり、blind write はない
module m19_live {
  import m19_core(NPIECE = 3, WLO = 4, X1 = 1, X2 = 2,
                  MAP_CURRENT = true, SAME_T = true, SPLIT_EXACT = true, KEEP_MAP = true, C_REFUSES = true,
                  CARRY_CLOCK = true, TRACK_READS = false, ANY_START = false, NREAD = 1, GIVE_UP = false, CLOCK_MAX = 0, T_MAX = 1, RETRY_MAX = 3).*
}
// 同じインスタンスで、C が、claim の全部が届くまで断らずに待つ (M18 までの規則)。範囲表の版 1 の claim は、移動が進まないと
// 揃わない。移動が止まると、読みは終わらない
module m19_live_red_child_waits {
  import m19_core(NPIECE = 3, WLO = 4, X1 = 0, X2 = 0,
                  MAP_CURRENT = true, SAME_T = true, SPLIT_EXACT = true, KEEP_MAP = true, C_REFUSES = false,
                  CARRY_CLOCK = true, TRACK_READS = false, ANY_START = false, NREAD = 1, GIVE_UP = false, CLOCK_MAX = 0, T_MAX = 1, RETRY_MAX = 3).*
  run counterexampleTest =
    init.then(advance(2))
        .then(pull(2)).then(recvPull)             // piece 2 だけが C に届いている。piece 3 は P にあり、切られていない
        .then(startRead(1, STAY))                 // 版 1 の Worker。P に {1}、C に {2, 3} を聞く
        .then(answer(P))
        .expect(not(mayAnswer(C)) and not(canRefuseC))   // C は答えも断りもしない。piece 3 が移ってくるのを待つ
        .expect(not(readNotStuck))
}

// TLC には大きすぎる定数 (移る piece 3 つ、取引 X は移る piece 2 つに書く、読みの時刻を覚える、最初の claim は任意、読み 2 回)。
// ランダム探索 (quint run) で使い、check.sh には含めない
module m19_green_wide {
  import m19_core(NPIECE = 4, WLO = 2, X1 = 2, X2 = 3,
                  MAP_CURRENT = true, SAME_T = true, SPLIT_EXACT = true, KEEP_MAP = true, C_REFUSES = true,
                  CARRY_CLOCK = true, TRACK_READS = true, ANY_START = true, NREAD = 2, GIVE_UP = true, CLOCK_MAX = 2, T_MAX = 6, RETRY_MAX = 4).*
}

// P が、分け直した後の claim (自分の表から作られた claim) を、いまの表で確かめずに答える。
// claim が作られた後、T 以下の時刻 m で切られた piece を、P が控えの行で答える。m の後に C で確定した行が抜ける
module m19_red_stale_map {
  import m19_core(NPIECE = 3, WLO = 3, X1 = 0, X2 = 0,
                  MAP_CURRENT = false, SAME_T = true, SPLIT_EXACT = true, KEEP_MAP = true, C_REFUSES = true,
                  CARRY_CLOCK = true, TRACK_READS = false, ANY_START = false, NREAD = 1, GIVE_UP = true, CLOCK_MAX = 0, T_MAX = 3, RETRY_MAX = 3).*
  run counterexampleTest =
    init.then(advance(2))
        .then(pull(2)).then(recvPull)             // piece 2 が C へ移る (m = 1)
        .then(startRead(3, PIECES))               // T = 3
        .then(refuse(P))                          // 表 {2: 1}。P の claim は {1, 3} になる
        .then(pull(3)).then(recvPull)             // その後で piece 3 が移る (m = 2 <= T)
        .then(write(C, 3))                        // C が piece 3 に 3 で書く (m < 3 <= T)
        .then(answer(P))                          // P は、claim が自分の表から作られたものなので、いまの表を見ずに答える
        .expect(unheld)
        .then(answer(C))
        .expect(badRead and lastBad == { t: 3, p: 3, n: 1 } and moved.get(3) == 2)   // piece 3 は P の控え {0} で、書き込みが抜ける
}

// T を上げたときに、古い T の答えを捨てない。違う時刻の答えを合わせる
module m19_red_mixed_t {
  import m19_core(NPIECE = 3, WLO = 1, X1 = 0, X2 = 0,
                  MAP_CURRENT = true, SAME_T = false, SPLIT_EXACT = true, KEEP_MAP = true, C_REFUSES = true,
                  CARRY_CLOCK = true, TRACK_READS = false, ANY_START = false, NREAD = 1, GIVE_UP = true, CLOCK_MAX = 0, T_MAX = 3, RETRY_MAX = 3).*
  run counterexampleTest =
    init.then(advance(1))                         // 範囲表が切り替わる。fence はまだ
        .then(startRead(1, STAY))                 // 版 1 の Worker。P に {1}、C に {2, 3} を T = 1 で聞く
        .then(answer(P))                          // P が piece 1 を T = 1 で答える ({0})
        .then(write(P, 1))                        // P が piece 1 に 2 で書く
        .then(write(P, 2))                        // P が piece 2 に 3 で書く
        .then(pull(2)).then(recvPull)             // piece 2 が C へ移る (m = 4)
        .then(refuse(C))                          // C は断る (piece 3 がない)。表 {2: 4}。4 > 1 なので T を 4 に上げる
        .expect(rd.t == 4 and rd.askP == Set(3) and rd.askC == Set(2) and rd.parts == Set({ d: P, p: 1, rows: Set(0) }))
        .then(answer(P)).then(answer(C))          // piece 3 と piece 2 は T = 4 の答え。piece 1 は T = 1 の答えのまま
        .expect(badRead and fractured and lastBad == { t: 4, p: 1, n: 1 })   // どの時刻の状態とも一致しない
}

// 分け直した claim が、断られた claim を覆わない。P の表の区間 (after, upTo] の終わりを、C の claim に入れない
module m19_red_gap {
  import m19_core(NPIECE = 3, WLO = 3, X1 = 0, X2 = 0,
                  MAP_CURRENT = true, SAME_T = true, SPLIT_EXACT = false, KEEP_MAP = true, C_REFUSES = true,
                  CARRY_CLOCK = true, TRACK_READS = false, ANY_START = false, NREAD = 1, GIVE_UP = true, CLOCK_MAX = 0, T_MAX = 3, RETRY_MAX = 3).*
  run counterexampleTest =
    init.then(advance(2))
        .then(pull(2)).then(recvPull)             // piece 2 が C へ移る (m = 1)
        .then(startRead(1, PIECES))
        .then(refuse(P))                          // 表 {2: 1}。Worker は、区間の終わりの piece 2 を C の claim に入れない
        .expect(rd.askP == Set(1, 3) and rd.askC == Set())
        .then(answer(P))                          // 出している claim がなくなり、P の答えだけで揃ったことになる
        .expect(badRead and lastBad == { t: 1, p: 2, n: 0 } and not(unheld))   // piece 2 は、どのシャードも答えていない
}

// Worker が、P の表 (手放したと分かった piece) を覚えない。切られて飛んでいる piece を、C は「届いていない」と断り、
// P は「手放した」と断る。応答が届くまで、断られ続ける
module m19_red_forget_map {
  import m19_core(NPIECE = 3, WLO = 3, X1 = 0, X2 = 0,
                  MAP_CURRENT = true, SAME_T = true, SPLIT_EXACT = true, KEEP_MAP = false, C_REFUSES = true,
                  CARRY_CLOCK = true, TRACK_READS = false, ANY_START = false, NREAD = 1, GIVE_UP = true, CLOCK_MAX = 0, T_MAX = 3, RETRY_MAX = 3).*
  run counterexampleTest =
    init.then(advance(2))
        .then(pull(2))                            // P は piece 2 を切った (m = 1)。応答は飛んでいる
        .then(startRead(1, PIECES))
        .then(refuse(P))                          // 表 {2: 1}。piece 2 は C の claim へ
        .then(refuse(C))                          // C は piece 2 を持っていない。Worker は piece 2 を P の claim へ戻す
        .then(refuse(P)).then(refuse(C))
        .expect(rd.n == 4 and not(boundedRetries) and readConsistent)
}

// piece が時刻を運ばない。P が、まだ切っていない piece を、分け直した読みの T で答える。その piece が移った後、
// C が T 以下の時刻で書き込みを受理する
module m19_red_piece_without_clock {
  import m19_core(NPIECE = 3, WLO = 3, X1 = 0, X2 = 0,
                  MAP_CURRENT = true, SAME_T = true, SPLIT_EXACT = true, KEEP_MAP = true, C_REFUSES = true,
                  CARRY_CLOCK = false, TRACK_READS = true, ANY_START = false, NREAD = 1, GIVE_UP = true, CLOCK_MAX = 0, T_MAX = 2, RETRY_MAX = 3).*
  run counterexampleTest =
    init.then(advance(2))
        .then(pull(2)).then(recvPull)             // piece 2 が C へ移る (m = 1)。C の時計は 0 のまま
        .then(startRead(2, PIECES)).then(refuse(P))
        .then(answer(P))                          // P が piece 1 と、まだ切っていない piece 3 を T = 2 で答える
        .then(pull(3)).then(recvPull)             // piece 3 が移る (m = 3)。C の時計は 0 のまま
        .then(write(C, 3))                        // C が piece 3 に 1 で書く。1 <= 2
        .expect(lateWrite and not(noWriteBelowRead))
}
