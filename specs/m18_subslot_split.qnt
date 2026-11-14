// M18: 1 つの shard key の行を、複数のシャードに分けて持つ (subslot による分割)
//
// 背景。2026-11-14 に SHARD KEY 句をなくし、shard key は主キーの最初の列に決まった。同じ shard key の行 (グループ) は
// 1 通の応答で運ぶので (pull、GROUP_MAX_BYTES = 16 MB)、16 MB を超えるグループは移せず、分割が終わらない。
// 1 つのテナントは、1 つのシャードより大きくなれない。
//
// 設計。配置を 2 段にする。slot = hash(主キーの最初の列) mod 4096 は今までどおりで、テナントの行は既定で 1 か所に集まる。
// subslot = hash(主キーの全体) mod 65536 を足し、範囲表は (slot の範囲, subslot の範囲) をシャードに対応させる。
// 移動の単位は piece = (グループ, subslot の範囲) で、1 通の応答に収まる大きさにする。1 つの slot を subslot の範囲で分けると、
// 1 つのテナントの行が複数のシャードに分かれる。それでも、文は 1 つの SQLite が全部の行を持つときと同じ答えを返す。
//
// モデル。親 P (=1)、子 C (=2)、テナント 1 つ。piece 1 は subslot の下の範囲にあり、P に残る。piece 2 以降は上の範囲にあり、
// C へ移る (NPIECE = 3 なら、上の範囲が 2 通の応答に分かれて移る。16 MB を超えるテナントの形)。
// 移動は M5b の green と同じである。fence、Meta の経路の切り替え、piece ごとの pull (応答の喪失と冪等な再送)、
// 親は m を決めた piece を答えず、子は T < m の読みを断り、piece は時刻 m を運んで子の時計を進める。
//
// 経路。範囲表の版は 2 つある。版 0 は slot の全体が P。版 1 は (slot, 下の範囲) が P、(slot, 上の範囲) が C。
// Worker のキャッシュは変数にしない。要求ごとに、これまでに知り得た版のどれかを選ぶ (古い版を持つ Worker が何台いてもよい)。
//
// 行。piece は行の集合を持つ。行は、書いた者の id と確定の時刻の組である。最初から 1 行ずつある (id 0、時刻 0)。
// 読みの答えは、時刻が T 以下の行の id の集合である。
//
// 書き込み。blind write の id は、書く piece の番号である。Worker は主キーを知っているので、piece で宛先を決める。
// 取引 X (id 9) はテナントの中のクロスシャード取引で、piece 1 と piece 2 に intent を置く。anchor が c を決めた時点で、
// X は確定している (truth に入る)。phase 2 は piece ごとに、moved 表で決めた持ち主に届く。
//
// 読み。主キーの読み (readPiece) は M5b の読みと同じで、piece の持ち主が答える。
// テナントの読み (WHERE tenant = ?) では、Worker は shard key しか知らない。自分の版の範囲表で、その slot を持つシャードの全部に、
// 時刻 T と、そのシャードが持つはずの subslot の範囲 (claim) を送る。
//   版 0: P だけに送る。claim は全部の piece。1 手で終わる (readTenantWhole)。
//   版 1: P に claim = {1}、C に claim = {2, ..} を送る。答えは別々の時点に返る (readTenantPart を 2 回)。
// シャードの規則 (green): claim の全部を時刻 T で持っているときだけ答え、claim の中の行だけを返す。そうでなければ断る。
// Worker は、全部のシャードの答えが揃ったら合わせる。断られた読みは捨てる (forgetRead。やり直しは新しい読みである)。
// ANY_CLAIM なら、Worker は piece を P と C に好きに分けて claim にする (範囲表のとおりでなくてよい)。
// シャードの規則が Worker の分け方に頼らないことと、移動の途中でも、分け方が合えば読みが揃うことを確かめる。
//
// invariants
//   singleOwner:      受理した書き込みは、piece の持ち主だけにある (子は届いた piece の行だけを持ち、親が手放した piece の控えに、
//                     手放した時刻以後の行がない)
//   readConsistent:   答えた読みは、T 時点の真の行の集合と一致する。テナントの読みは、どの piece も、ちょうど 1 つのシャードが答える
//   noLostWrite:      piece の持ち主の行は、確定した書き込みの全部である (決着して未適用の intent を除く)
//   intentNotLost:    intent は、その piece の持ち主にある
//   noWriteBelowRead: 答えた読みの時刻以下の時刻で、同じ piece への書き込みが確定しない
module m18_core {
  const NPIECE: int               // piece の数。1 は残り、2 以降は移る
  const NWRITE: int               // blind write の数。id は、書く piece の番号である
  const WITH_X: bool              // 取引 X を入れる
  const REFUSE_STALE: bool        // 親は、claim に手放した piece があれば断る。false なら、まだ持っている piece だけを答える
  const CHILD_WAITS_CLAIM: bool   // 子は、claim の全部が届くまで答えない。false なら、届いた piece だけを答える
  const ANSWER_BY_CLAIM: bool     // 答える行を claim で絞る。false なら、そのテナントの行で、手元にあるものを全部返す
  const WRITE_BY_PIECE: bool      // 書き込みの宛先と持ち主の確認を piece で決める。false なら slot だけで決める
  const CARRY_CLOCK: bool         // piece が時刻 m を運び、子の時計を m まで進める
  const INTENTS_BY_PIECE: bool    // pull は、その piece の intent だけを運ぶ。false なら、shard key の intent を全部運ぶ
  const TRACK_READS: bool         // 答えた読みの時刻を覚える (noWriteBelowRead のための ghost)
  const ANY_CLAIM: bool           // Worker が、piece を P と C に好きに分けて claim にする。false なら範囲表の版 1 のとおり
  const CLOCK_MAX: int
  const T_MAX: int

  pure val P = 1
  pure val C = 2
  pure val DOMS = Set(P, C)
  pure val PIECES = 1.to(NPIECE)
  pure val STAY = Set(1)
  pure val MOVE = 2.to(NPIECE)
  pure val WRITES = 1.to(NWRITE)
  pure val X = 9
  pure val XP = if (WITH_X) Set(1, 2) else Set()     // X が書く piece
  pure def max(a: int, b: int): int = if (a > b) a else b
  // 版 1 の範囲表で、シャード d が持つ piece
  pure def claim1(d: int): Set[int] = if (d == P) STAY else MOVE

  type Ver = { ver: int, writer: int }
  type Intent = { where: int, pts: int }                               // where: 0 無し, 1 P, 2 C, 3 適用済み
  type Pull = { p: int, m: int, data: Set[Ver], intents: Set[int] }    // p == 0 なら送信中の pull 無し
  type Part = { d: int, p: int, rows: Set[int] }                       // シャード d が piece p について返した行
  type Rd = { st: int, t: int, k: Set[int], parts: Set[Part] }         // k: P の claim (C の claim は残りの piece)
                                                                       // st: 0 無し, 1 P が答えた, 2 C が答えた, 3 揃った,
                                                                       //     4 揃い、分割の後に両側で書かれた行を見た,
                                                                       //     5 移動の途中に揃った
  type Bad = { t: int, p: int, n: int }                                // n: piece p を答えたシャードの数

  var hlc: int -> int
  var hist: int -> (int -> Set[Ver])      // シャード -> piece -> 手元にある行。親は、手放した piece の行を控えとして持ち続ける
  var moved: int -> int                   // P: piece -> m (0 = 未移動)
  var arrived: int -> int                 // C: piece -> m (0 = 未到着)
  var fenced: bool                        // P が上の範囲への新規受理を止めた
  var route: int                          // Meta の範囲表の版
  var pending: Set[int]
  var truth: int -> Set[Ver]              // ghost: piece -> 確定した行
  var pullMsg: Pull
  var xi: int -> Intent                   // piece -> X の intent
  var xc: int                             // X の確定の時刻 (0 = 未決定)
  var xpushed: int
  var rd: Rd                              // 2 つのシャードに送ったテナントの読み (同時に 1 つ)
  var badRead: bool
  var lastBad: Bad
  var served: int -> int                  // ghost: piece -> 答えた読みの時刻の最大
  var lateWrite: bool                     // ghost: 答えた読みの時刻以下で、書き込みが確定した

  pure val noPull: Pull = { p: 0, m: 0, data: Set(), intents: Set() }
  pure val noRd: Rd = { st: 0, t: 0, k: Set(), parts: Set() }
  pure val noBad: Bad = { t: 0, p: 0, n: 0 }
  pure val noIntent: Intent = { where: 0, pts: 0 }
  pure val initVers: Set[Ver] = Set({ ver: 0, writer: 0 })

  pure def rowsAt(vs: Set[Ver], t: int): Set[int] = vs.filter(v => v.ver <= t).map(v => v.writer)
  pure def partsOf(parts: Set[Part], p: int): Set[Part] = parts.filter(a => a.p == p)

  action init = all {
    hlc' = DOMS.mapBy(_ => 0),
    hist' = Map(P -> PIECES.mapBy(_ => initVers), C -> PIECES.mapBy(_ => Set())),
    moved' = PIECES.mapBy(_ => 0), arrived' = PIECES.mapBy(_ => 0),
    fenced' = false, route' = 0,
    pending' = WRITES, truth' = PIECES.mapBy(_ => initVers),
    pullMsg' = noPull,
    xi' = PIECES.mapBy(_ => noIntent), xc' = 0, xpushed' = 0,
    rd' = noRd, badRead' = false, lastBad' = noBad,
    served' = PIECES.mapBy(_ => 0), lateWrite' = false
  }

  action keepMove = all { moved' = moved, arrived' = arrived, fenced' = fenced, route' = route, pullMsg' = pullMsg }
  action keepData = all { hist' = hist, truth' = truth, pending' = pending }
  action keepX = all { xi' = xi, xc' = xc, xpushed' = xpushed }
  action keepRead = all { rd' = rd, badRead' = badRead, lastBad' = lastBad }
  action keepGhost = all { served' = served, lateWrite' = lateWrite }

  // ---- 所有 -------------------------------------------------------------------
  def pOwns(p: int): bool = moved.get(p) == 0
  def cOwns(p: int): bool = arrived.get(p) > 0
  def holds(d: int, p: int): bool = if (d == P) pOwns(p) else cOwns(p)
  // 時刻 t の読みに答えられるか。親は m を決めた piece を答えない (NotOwner)。子は T < m を断る (ReadTooOld)
  def ownsAt(d: int, p: int, t: int): bool = if (d == P) pOwns(p) else (cOwns(p) and t >= arrived.get(p))
  // 版 1 を知り得るか。Meta が切り替えた後か、親が fence した後 (NotOwner の応答が宛先を教える)
  def knowsSplit: bool = route == 1 or fenced

  // ---- 時計 -------------------------------------------------------------------
  action tick(d: int): bool = all {
    hlc.get(d) < CLOCK_MAX,
    hlc' = hlc.set(d, hlc.get(d) + 1),
    keepMove, keepData, keepX, keepRead, keepGhost
  }

  // ---- 所有権の切替 -----------------------------------------------------------
  // 親が (slot, 上の範囲) への新規受理を止める
  action fence = all {
    not(fenced), fenced' = true,
    moved' = moved, arrived' = arrived, route' = route, pullMsg' = pullMsg,
    hlc' = hlc, keepData, keepX, keepRead, keepGhost
  }
  // Meta が範囲表を版 1 にする。slot は 2 つのシャードのものになる
  action switchRoute = all {
    route == 0, route' = 1,
    moved' = moved, arrived' = arrived, fenced' = fenced, pullMsg' = pullMsg,
    hlc' = hlc, keepData, keepX, keepRead, keepGhost
  }

  // ---- 書き込み (blind) -------------------------------------------------------
  // Worker の宛先。piece で決めるなら、版 0 は P、版 1 は piece の持ち主。slot で決めるなら、その slot を持つシャードのどれか
  def routable(d: int, p: int): bool =
    d == P or (knowsSplit and (MOVE.contains(p) or not(WRITE_BY_PIECE)))
  // シャードの確認。slot だけを見るなら、その slot の一部を持っていれば受理する
  def pAccepts(p: int): bool =
    if (WRITE_BY_PIECE) (pOwns(p) and not(fenced and MOVE.contains(p))) else true
  def cAccepts(p: int): bool =
    if (WRITE_BY_PIECE) cOwns(p) else MOVE.exists(q => cOwns(q))

  action write(d: int, id: int): bool = all {
    pending.contains(id),
    routable(d, id),
    if (d == P) pAccepts(id) else cAccepts(id),
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
  // 子が親に piece を要求し、親が応答する (1 アクション)。親は moved[p] = m を永続化してから応答する。
  // 再送は同じ m で答える。intent は、その piece のものだけを載せる
  action pull(p: int): bool = all {
    MOVE.contains(p), knowsSplit,
    arrived.get(p) == 0, pullMsg.p == 0,
    val first = moved.get(p) == 0
    val m = if (first) hlc.get(P) + 1 else moved.get(p)
    val carried = XP.filter(q => xi.get(q).where == P and (q == p or not(INTENTS_BY_PIECE)))
    all {
      moved' = moved.set(p, m),
      hlc' = if (first) hlc.set(P, m) else hlc,
      pullMsg' = { p: p, m: m, data: hist.get(P).get(p), intents: carried },
      arrived' = arrived, fenced' = fenced, route' = route,
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
      moved' = moved, fenced' = fenced, route' = route,
      truth' = truth, pending' = pending, xc' = xc, xpushed' = xpushed,
      keepRead, keepGhost
    }
  }

  // 応答が失われる (親または子の再起動)。子は後で pull をやり直す
  action losePull = all {
    pullMsg.p != 0,
    pullMsg' = noPull,
    moved' = moved, arrived' = arrived, fenced' = fenced, route' = route,
    hlc' = hlc, keepData, keepX, keepRead, keepGhost
  }

  // ---- テナントの中のクロスシャード取引 X ----------------------------------------
  // prepare は piece の持ち主に届く
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
  // anchor が c を決める。全部の prepare_ts 以上で、push された時刻より大きい。この時点で X は確定している
  def maxPts: int = XP.fold(0, (a, p) => max(a, xi.get(p).pts))
  action decideX(c: int): bool = all {
    WITH_X, xc == 0,
    XP.forall(p => xi.get(p).where == P or xi.get(p).where == C),
    c >= maxPts, c > xpushed, c <= maxPts + 1,
    xc' = c,
    truth' = PIECES.mapBy(p => if (XP.contains(p)) truth.get(p).union(Set({ ver: c, writer: X })) else truth.get(p)),
    lateWrite' = (lateWrite or XP.exists(p => c <= served.get(p))),
    served' = served,
    xi' = xi, xpushed' = xpushed, hist' = hist, pending' = pending,
    hlc' = hlc, keepMove, keepRead
  }
  // phase 2 は piece ごとに、moved 表で決めた持ち主に届く。親が m を決めた後は子。子が未到着なら適用せず待つ
  action phase2X(p: int): bool = all {
    XP.contains(p), xc > 0,
    xi.get(p).where == P or xi.get(p).where == C,
    val o = if (moved.get(p) > 0) C else P
    all {
      holds(o, p),
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

  // 主キーの読み。Worker は piece を知っているので、piece の持ち主が答える
  action readPiece(d: int, p: int, t: int): bool = all {
    ownsAt(d, p, t),
    not(xBlocks(d, p, t)),
    val got = rowsAt(hist.get(d).get(p), t)
    val want = rowsAt(truth.get(p), t)
    all {
      badRead' = (badRead or got != want),
      lastBad' = if (not(badRead) and got != want) { t: t, p: p, n: 1 } else lastBad,
      rd' = rd,
      hlc' = hlc.set(d, max(hlc.get(d), t)),
      xpushed' = if (xPushes(d, p, t)) max(xpushed, t) else xpushed,
      served' = if (TRACK_READS) served.set(p, max(served.get(p), t)) else served,
      xi' = xi, xc' = xc, lateWrite' = lateWrite,
      keepMove, keepData
    }
  }

  // テナントの読みに、シャード d が claim k で答える。
  // 断るか: 親は claim に手放した piece があれば断る。子は claim の全部が届いていて、T がどの m よりも小さくないときだけ答える
  def mayAnswer(d: int, k: Set[int], t: int): bool =
    if (d == P) (not(REFUSE_STALE) or k.forall(p => pOwns(p)))
    else if (CHILD_WAITS_CLAIM) k.forall(p => ownsAt(C, p, t))
    else k.forall(p => not(cOwns(p)) or t >= arrived.get(p))
  // 返す piece
  def answered(d: int, k: Set[int]): Set[int] =
    if (not(ANSWER_BY_CLAIM)) PIECES.filter(p => hist.get(d).get(p) != Set())
    else k.filter(p => holds(d, p) or (d == P and REFUSE_STALE) or (d == C and CHILD_WAITS_CLAIM))
  def ownedAnswered(d: int, k: Set[int]): Set[int] = answered(d, k).filter(p => holds(d, p))
  def answerOk(d: int, k: Set[int], t: int): bool =
    mayAnswer(d, k, t) and ownedAnswered(d, k).forall(p => not(xBlocks(d, p, t)))
  def partsFrom(d: int, k: Set[int], t: int): Set[Part] =
    answered(d, k).map(p => { d: d, p: p, rows: rowsAt(hist.get(d).get(p), t) })
  action answerEffects(d: int, k: Set[int], t: int): bool = all {
    hlc' = hlc.set(d, max(hlc.get(d), t)),
    xpushed' = if (ownedAnswered(d, k).exists(p => xPushes(d, p, t))) max(xpushed, t) else xpushed,
    served' = if (TRACK_READS) PIECES.mapBy(p => if (ownedAnswered(d, k).contains(p)) max(served.get(p), t) else served.get(p))
              else served,
    xi' = xi, xc' = xc, lateWrite' = lateWrite,
    keepMove, keepData
  }

  // 合わせた答えの確認。どの piece も、ちょうど 1 つのシャードが答え、その行が T 時点の真の行と一致する
  def pieceBad(parts: Set[Part], p: int, t: int): bool =
    partsOf(parts, p).size() != 1 or partsOf(parts, p).exists(a => a.rows != rowsAt(truth.get(p), t))
  def badOf(parts: Set[Part], t: int): Bad =
    val p = PIECES.fold(0, (a, q) => if (a == 0 and pieceBad(parts, q, t)) q else a)
    { t: t, p: p, n: partsOf(parts, p).size() }
  // 分割の後に、P が piece 1 に、C が移った piece に確定した行を、どちらも見た
  def sawBoth(t: int): bool = and {
    MOVE.forall(p => moved.get(p) > 0),
    MOVE.exists(p => hist.get(C).get(p).exists(v => v.ver > arrived.get(p) and v.ver <= t)),
    hist.get(P).get(1).exists(v => v.ver <= t and MOVE.forall(p => v.ver > moved.get(p)))
  }

  // 版 0 の Worker のテナントの読み。P だけに、全部の piece を claim として送る
  action readTenantWhole(t: int): bool = all {
    answerOk(P, PIECES, t),
    val parts = partsFrom(P, PIECES, t)
    val bad = PIECES.exists(p => pieceBad(parts, p, t))
    all {
      badRead' = (badRead or bad),
      lastBad' = if (not(badRead) and bad) badOf(parts, t) else lastBad,
      rd' = rd,
      answerEffects(P, PIECES, t)
    }
  }

  // 移動の途中に揃った。P が上の範囲のまだ手放していない piece を、C が届いた piece を答えた
  pure def whileMoving(parts: Set[Part]): bool =
    parts.exists(a => a.d == P and MOVE.contains(a.p)) and parts.exists(a => a.d == C)

  // 2 つのシャードに送るテナントの読み。Worker は、P の claim を k、C の claim を残りの piece にする。
  // P と C が、別々の時点に、自分の claim で答える。2 つ目の答えで揃う。
  // 範囲表の版 1 のとおりなら k = {1} である。ANY_CLAIM なら k は何でもよい
  action readTenantClaim(d: int, k: Set[int], t: int): bool = all {
    knowsSplit,
    ANY_CLAIM or k == STAY,
    rd.st == 0 or (rd.st == 3 - d and rd.t == t and rd.k == k),
    val mine = if (d == P) k else PIECES.exclude(k)
    val parts = rd.parts.union(partsFrom(d, mine, t))
    val complete = rd.st != 0
    val bad = complete and PIECES.exists(p => pieceBad(parts, p, t))
    all {
      answerOk(d, mine, t),
      rd' = if (complete) { st: if (whileMoving(parts)) 5 else if (sawBoth(t)) 4 else 3, t: 0, k: Set(), parts: Set() }
            else { st: d, t: t, k: k, parts: parts },
      badRead' = (badRead or bad),
      lastBad' = if (not(badRead) and bad) badOf(parts, t) else lastBad,
      answerEffects(d, mine, t)
    }
  }
  // 版 1 の Worker のテナントの読み
  action readTenantPart(d: int, t: int): bool = readTenantClaim(d, STAY, t)

  // Worker が読みを捨てる (片方に断られた、または答えを受け取り終えた)
  action forgetRead = all {
    rd.st != 0,
    rd' = noRd, badRead' = badRead, lastBad' = lastBad,
    hlc' = hlc, keepMove, keepData, keepX, keepGhost
  }

  action step = any {
    { nondet d = oneOf(DOMS) tick(d) },
    fence,
    switchRoute,
    { nondet d = oneOf(DOMS) nondet id = oneOf(WRITES) write(d, id) },
    { nondet p = oneOf(PIECES) pull(p) },
    recvPull,
    losePull,
    { nondet d = oneOf(DOMS) nondet p = oneOf(PIECES) prepareX(d, p) },
    { nondet c = oneOf(1.to(T_MAX + 8)) decideX(c) },
    { nondet p = oneOf(PIECES) phase2X(p) },
    { nondet d = oneOf(DOMS) nondet p = oneOf(PIECES) nondet t = oneOf(0.to(T_MAX)) readPiece(d, p, t) },
    { nondet t = oneOf(0.to(T_MAX)) readTenantWhole(t) },
    { nondet d = oneOf(DOMS) nondet k = oneOf(PIECES.powerset()) nondet t = oneOf(0.to(T_MAX)) readTenantClaim(d, k, t) },
    forgetRead
  }

  // ---- 不変条件 -------------------------------------------------------------
  // 受理した書き込みは、piece の持ち主だけにある。
  // 子は届いた piece の行だけを持つ。親が手放した piece の控えには、手放した時刻 m 以後の行がない
  val singleOwner = PIECES.forall(p =>
    (hist.get(C).get(p) == Set() or cOwns(p)) and
    (moved.get(p) == 0 or hist.get(P).get(p).forall(v => v.ver < moved.get(p))))
  val readConsistent = not(badRead)
  // piece を持つシャード (応答が飛んでいる間は親の控え) の行は、確定した書き込みの全部である。
  // X は c が決まった時点で確定しているので、未適用の intent の分を足して比べる
  def keeper(p: int): int = if (cOwns(p)) C else P
  def unapplied(p: int): Set[Ver] =
    if (XP.contains(p) and xc > 0 and (xi.get(p).where == P or xi.get(p).where == C)) Set({ ver: xc, writer: X }) else Set()
  val noLostWrite = PIECES.forall(p => hist.get(keeper(p)).get(p).union(unapplied(p)) == truth.get(p))
  // 子に piece が到着するまでは親が intent を保持してよい。到着後に親に残るか、持ち主でない子にあれば、取り残されている
  val intentNotLost = XP.forall(p =>
    (xi.get(p).where != P or not(cOwns(p))) and (xi.get(p).where != C or cOwns(p)))
  val noWriteBelowRead = not(lateWrite)
  val tenantSplitSafe = singleOwner and readConsistent and noLostWrite and intentNotLost and noWriteBelowRead

  // witness
  // piece 2 が移った後で、C が piece 2 への書き込みを、P が piece 1 への書き込みを受理した
  val witnessSplitWritten = not(
    arrived.get(2) > 0
    and hist.get(C).get(2).exists(v => v.writer == 2 and v.ver > arrived.get(2))
    and hist.get(P).get(1).exists(v => v.writer == 1 and v.ver > moved.get(2)))
  // テナントの読みに両方のシャードが答え、分割の後に両側で確定した行を、合わせた答えが含む
  val witnessTenantReadBoth = not(rd.st == 4)
  // P で prepare した piece 2 の intent が子へ移り、子で適用された
  val witnessIntentMovedThenApplied = not(
    WITH_X and xi.get(2).where == 3 and xi.get(2).pts < arrived.get(2)
    and hist.get(C).get(2).exists(v => v.writer == X) and not(hist.get(P).get(2).exists(v => v.writer == X)))
  // 上の範囲の piece が 1 つだけ届いている (NPIECE = 3 のとき、移動の途中)
  val witnessHalfArrived = not(MOVE.exists(p => cOwns(p)) and MOVE.exists(p => not(cOwns(p))))
  // 移動の途中に、テナントの読みが揃う (ANY_CLAIM のとき。P の claim が、残る piece と、まだ手放していない piece)
  val witnessReadWhileMoving = not(rd.st == 5)
}

// 修正版 (green)。piece 1 は親に残り、piece 2 は子へ移る
module m18_green {
  import m18_core(NPIECE = 2, NWRITE = 2, WITH_X = true,
                  REFUSE_STALE = true, CHILD_WAITS_CLAIM = true, ANSWER_BY_CLAIM = true, WRITE_BY_PIECE = true,
                  CARRY_CLOCK = true, INTENTS_BY_PIECE = true, TRACK_READS = false, ANY_CLAIM = false, CLOCK_MAX = 1, T_MAX = 3).*
  run splitTenantTest =
    init.then(prepareX(P, 2))                     // X の intent を piece 2 に置く (P、pts 1)
        .then(prepareX(P, 1))                     // piece 1 にも置く (P、pts 2)
        .then(fence).then(switchRoute)
        .then(pull(2))                            // m = 3。piece 2 の intent だけを載せる
        .then(losePull)                           // 応答が失われる
        .then(pull(2))                            // 再送: 同じ m
        .expect(pullMsg.m == 3 and moved.get(2) == 3 and pullMsg.intents == Set(2))
        .then(recvPull)
        .expect(arrived.get(2) == 3 and hlc.get(C) == 3 and xi.get(2).where == C and xi.get(1).where == P)
        .then(decideX(2))                         // c = 2 < m
        .then(phase2X(2))                         // 子で適用
        .then(phase2X(1))                         // 親で適用
        .expect(not(witnessIntentMovedThenApplied))
        .then(write(C, 2))                        // C が piece 2 に 4 で書く
        .then(write(P, 1))                        // P が piece 1 に 4 で書く
        .expect(not(witnessSplitWritten))
        .expect(not(answerOk(P, PIECES, 3)))      // 版 0 の Worker のテナントの読み: P は piece 2 を手放したので断る
        .expect(not(answerOk(C, claim1(C), 2)))   // T = 2 < m: 子は断る
        .then(readTenantPart(P, 3))               // 版 1。P が piece 1 を T = 3 で答える (X を含み、4 の書き込みを含まない)
        .expect(rd.st == P and rd.parts == Set({ d: P, p: 1, rows: Set(0, X) }))
        .then(readTenantPart(C, 3))               // C が piece 2 を答えて揃う
        .expect(rd.st == 3 and not(badRead))
        .then(forgetRead)
        .then(readTenantPart(C, 4))               // C が先に答えても同じ。T = 4 では、両側の 4 の書き込みも見える
        .expect(rd.parts == Set({ d: C, p: 2, rows: Set(0, X, 2) }))
        .then(readTenantPart(P, 4))
        .expect(rd.st == 4 and not(badRead) and tenantSplitSafe)
}

// 答えた読みの時刻を覚えて、noWriteBelowRead も確かめる。状態が増えるので、T の上限を小さくしてある
module m18_green_clock {
  import m18_core(NPIECE = 2, NWRITE = 2, WITH_X = true,
                  REFUSE_STALE = true, CHILD_WAITS_CLAIM = true, ANSWER_BY_CLAIM = true, WRITE_BY_PIECE = true,
                  CARRY_CLOCK = true, INTENTS_BY_PIECE = true, TRACK_READS = true, ANY_CLAIM = false, CLOCK_MAX = 1, T_MAX = 2).*
  run clockCarriedTest =
    init.then(prepareX(P, 1))                     // piece 1 の intent (P、pts 1)
        .then(readPiece(P, 2, 2))                 // P が piece 2 を T = 2 で答える。piece 2 の intent はまだない
        .then(switchRoute)
        .then(pull(2)).then(recvPull)             // m = 3。C の時計は 3 になる
        .expect(hlc.get(C) == 3)
        .then(prepareX(C, 2))                     // C で prepare (pts 4)
        .then(decideX(4))                         // c = 4 > 2
        .then(write(C, 2))                        // C の書き込みは 5
        .expect(not(lateWrite) and tenantSplitSafe)
}

// 上の範囲が 2 通の応答に分かれて移る (16 MB を超えるテナントの形)。書き込みは piece ごとに 1 件で、取引 X はない。
// Worker は、piece を P と C に好きに分けて claim にする (範囲表のとおりの分け方も含む)
module m18_green_chunks {
  import m18_core(NPIECE = 3, NWRITE = 3, WITH_X = false,
                  REFUSE_STALE = true, CHILD_WAITS_CLAIM = true, ANSWER_BY_CLAIM = true, WRITE_BY_PIECE = true,
                  CARRY_CLOCK = true, INTENTS_BY_PIECE = true, TRACK_READS = false, ANY_CLAIM = true, CLOCK_MAX = 1, T_MAX = 3).*
  run halfArrivedTest =
    init.then(switchRoute)
        .then(pull(2)).then(recvPull)             // piece 2 だけが届く (m = 1)
        .then(write(C, 2))                        // 主キーで宛先の決まる書き込みは、届いた piece に通る (2)
        .expect(not(witnessHalfArrived))
        .expect(not(answerOk(P, PIECES, 3)))      // 版 0 の claim: P は断る
        .expect(not(answerOk(C, claim1(C), 3)))   // 版 1 の claim: C は piece 3 が届くまで断る
        .then(readTenantClaim(P, Set(1, 3), 2))   // claim を piece で分け直す。P に {1, 3}、C に {2}
        .then(readTenantClaim(C, Set(1, 3), 2))
        .expect(rd.st == 5 and not(badRead))      // 移動の途中でも揃う
        .then(forgetRead)
        .then(pull(3)).then(recvPull)             // piece 3 が届く (m = 3)
        .expect(not(answerOk(C, claim1(C), 2)))   // T = 2 は piece 3 の m より小さい
        .expect(not(answerOk(P, Set(1, 3), 3)))   // 前の分け方の claim は、P が piece 3 を手放したので断る
        .then(write(P, 1))                        // P が piece 1 に 4 で書く
        .then(readTenantPart(C, 4)).then(readTenantPart(P, 4))
        .expect(rd.st == 4 and not(badRead) and tenantSplitSafe)
}

// 親が、claim に手放した piece があっても断らず、まだ持っている piece だけを答える。
// 範囲表の古い Worker は P の答えを全部だと思うので、子へ移った行がどこからも返らない
module m18_red_partial_answer {
  import m18_core(NPIECE = 2, NWRITE = 2, WITH_X = true,
                  REFUSE_STALE = false, CHILD_WAITS_CLAIM = true, ANSWER_BY_CLAIM = true, WRITE_BY_PIECE = true,
                  CARRY_CLOCK = true, INTENTS_BY_PIECE = true, TRACK_READS = false, ANY_CLAIM = false, CLOCK_MAX = 1, T_MAX = 3).*
  run counterexampleTest =
    init.then(switchRoute)
        .then(pull(2)).then(recvPull)             // piece 2 が C へ移る (m = 1)
        .then(write(C, 2))                        // C が piece 2 に 2 で書く
        .then(readTenantWhole(3))                 // 版 0 の Worker。P は piece 1 だけを答える
        .expect(badRead and lastBad.p == 2 and lastBad.n == 0)
}

// 子が、claim の全部が届くのを待たず、届いた piece だけを答える。まだ親にある piece の行が、どこからも返らない
module m18_red_child_partial {
  import m18_core(NPIECE = 3, NWRITE = 3, WITH_X = false,
                  REFUSE_STALE = true, CHILD_WAITS_CLAIM = false, ANSWER_BY_CLAIM = true, WRITE_BY_PIECE = true,
                  CARRY_CLOCK = true, INTENTS_BY_PIECE = true, TRACK_READS = false, ANY_CLAIM = true, CLOCK_MAX = 1, T_MAX = 3).*
  run counterexampleTest =
    init.then(switchRoute)
        .then(pull(2)).then(recvPull)             // piece 2 だけが届く。piece 3 はまだ P にある
        .then(readTenantPart(C, 1))               // 版 1。C は piece 2 だけを答える
        .then(readTenantPart(P, 1))               // P の claim は piece 1 だけ
        .expect(badRead and lastBad.p == 3 and lastBad.n == 0)
}

// シャードが、答える行を claim で絞らず、そのテナントの行で手元にあるものを全部返す。
// 親は、手放した piece の行を、子の ack が届くまで持っている。その行が、子の答えと重なる
module m18_red_answer_held {
  import m18_core(NPIECE = 2, NWRITE = 2, WITH_X = true,
                  REFUSE_STALE = true, CHILD_WAITS_CLAIM = true, ANSWER_BY_CLAIM = false, WRITE_BY_PIECE = true,
                  CARRY_CLOCK = true, INTENTS_BY_PIECE = true, TRACK_READS = false, ANY_CLAIM = false, CLOCK_MAX = 1, T_MAX = 3).*
  run counterexampleTest =
    init.then(switchRoute)
        .then(pull(2)).then(recvPull)             // piece 2 が C へ移る。P は控えを持っている
        .then(readTenantPart(C, 1))               // 版 1。C が piece 2 を答える
        .then(readTenantPart(P, 1))               // P の claim は piece 1 だけだが、piece 2 の控えも返す
        .expect(badRead and lastBad.p == 2 and lastBad.n == 2)
}

// piece が時刻を運ばない。親が答えた読みの時刻より小さい時刻で、子が同じ piece への書き込みを受理する
module m18_red_piece_without_clock {
  import m18_core(NPIECE = 2, NWRITE = 2, WITH_X = true,
                  REFUSE_STALE = true, CHILD_WAITS_CLAIM = true, ANSWER_BY_CLAIM = true, WRITE_BY_PIECE = true,
                  CARRY_CLOCK = false, INTENTS_BY_PIECE = true, TRACK_READS = true, ANY_CLAIM = false, CLOCK_MAX = 1, T_MAX = 2).*
  run counterexampleTest =
    init.then(readTenantWhole(2))                 // P がテナントを T = 2 で答える。P の時計は 2
        .then(switchRoute)
        .then(pull(2)).then(recvPull)             // m = 3。C の時計は 0 のまま
        .expect(arrived.get(2) == 3 and hlc.get(C) == 0)
        .then(write(C, 2))                        // C が 1 で受理する。1 <= 2
        .expect(lateWrite and not(noWriteBelowRead))
  // 取引 X でも起きる。piece 1 の intent は読みより前に置かれ、piece 2 の主キーの読みはそれを push しない
  run txnBelowReadTest =
    init.then(prepareX(P, 1))                     // piece 1 の intent (P、pts 1)
        .then(readPiece(P, 2, 2))                 // P が piece 2 を T = 2 で答える
        .then(switchRoute)
        .then(pull(2)).then(recvPull)             // m = 3。C の時計は 0 のまま
        .then(prepareX(C, 2))                     // C で prepare (pts 1)
        .then(decideX(1))                         // c = 1 <= 2
        .expect(lateWrite and not(noWriteBelowRead))
}

// 書き込みの宛先と持ち主の確認を、slot だけで決める (subslot を見ない)。
// slot は 2 つのシャードのものなので、piece の持ち主でないシャードが受理する
module m18_red_write_by_slot {
  import m18_core(NPIECE = 2, NWRITE = 2, WITH_X = true,
                  REFUSE_STALE = true, CHILD_WAITS_CLAIM = true, ANSWER_BY_CLAIM = true, WRITE_BY_PIECE = false,
                  CARRY_CLOCK = true, INTENTS_BY_PIECE = true, TRACK_READS = false, ANY_CLAIM = false, CLOCK_MAX = 1, T_MAX = 3).*
  // 親の側。手放した piece への書き込みを親が受理する。飛んでいる応答には入っていない
  run counterexampleTest =
    init.then(switchRoute)
        .then(pull(2))                            // P は m を決めて応答を送った
        .then(write(P, 2))                        // 版 0 の Worker の書き込みを、P が受理する
        .expect(not(singleOwner))
        .then(recvPull)                           // 子は、その書き込みを含まない行を受け取る
        .expect(not(noLostWrite))
  // 子の側。piece 1 への書き込みが C に届き、C は slot の一部を持っているので受理する
  run childSideTest =
    init.then(switchRoute)
        .then(pull(2)).then(recvPull)             // piece 2 が C へ移る
        .then(write(C, 1))
        .expect(not(singleOwner) and not(noLostWrite))
        .then(readTenantPart(P, 3)).then(readTenantPart(C, 3))   // P は piece 1 を答えるが、その行を持っていない
        .expect(badRead and lastBad.p == 1 and lastBad.n == 1)
}

// pull が、piece の intent ではなく、shard key の intent を全部運ぶ。P に残る piece の intent が C へ行く
module m18_red_intents_by_group {
  import m18_core(NPIECE = 2, NWRITE = 2, WITH_X = true,
                  REFUSE_STALE = true, CHILD_WAITS_CLAIM = true, ANSWER_BY_CLAIM = true, WRITE_BY_PIECE = true,
                  CARRY_CLOCK = true, INTENTS_BY_PIECE = false, TRACK_READS = false, ANY_CLAIM = false, CLOCK_MAX = 1, T_MAX = 3).*
  run counterexampleTest =
    init.then(prepareX(P, 1))                     // piece 1 の intent (P に残る piece)
        .then(switchRoute)
        .then(pull(2)).then(recvPull)             // piece 2 の pull が、piece 1 の intent も運ぶ
        .expect(xi.get(1).where == C and not(intentNotLost))
}

// TLC には大きすぎる定数 (piece 3 つ、取引 X、読みの時刻を覚える、claim の分け方は任意)。
// ランダム探索 (quint run) で使い、check.sh には含めない
module m18_green_wide {
  import m18_core(NPIECE = 3, NWRITE = 3, WITH_X = true,
                  REFUSE_STALE = true, CHILD_WAITS_CLAIM = true, ANSWER_BY_CLAIM = true, WRITE_BY_PIECE = true,
                  CARRY_CLOCK = true, INTENTS_BY_PIECE = true, TRACK_READS = true, ANY_CLAIM = true, CLOCK_MAX = 2, T_MAX = 6).*
}
