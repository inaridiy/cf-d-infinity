// -*- mode: Bluespec; -*-
// M23f: Worker の 1 つの文と範囲表。1 つの試みの要求は、どれも、その試みを計画した範囲表で区間を切る (未解決の問題 37 の続き)
//
// 2026-11-17 に書いた。実装より先に書いたモデルである。設計は docs/design-refresh-across-move.md の「3 回目の実装の規則」にある。
//
// 背景。取引の文 (全表の読み) は、範囲表で宛先のシャードを決め、シャードごとに、そのシャードが持つ区間 (claim) を付けた要求を
// 並べて送る。応答によっては、同じ文の中で要求を送り直す。
//   moved at   fresh を付けた要求に、シャードが「範囲に T より新しい確定がある」と答えた。Worker は、それまでの読みが変わっていない
//              ことを確かめて T を進め (read refresh。M1b)、進めても進められなくても、同じシャードへ送り直す
//   stale      応答を待つ間に、並んだ別の要求が T を進めた。古い T の答えなので、いまの T で送り直す
//   over       集める行の予算の取り分を超えた。ほかのシャードが使わなかった分を配り直して、送り直す
// 範囲の移動をまたぐ取引では、T を進める確かめが NotOwner で断られると、取引は範囲表を取り直す (M23)。文の途中で取引の範囲表が
// 替わる。送り直す要求の claim を「いまの範囲表」で切ると、宛先は前の範囲表で決めたままなので、claim の和が文の区間を覆わない。
// 動いた区間が宛先にないシャードへ行っていれば、その区間は誰も読まず (行が落ちる)、答えを残した宛先から、送り直す宛先へ動いて
// いれば、2 つのシャードが同じ区間を答える (行が 2 度数えられる)。どちらも、前は NotOwner か read too old で断られていた場面である。
//
// 規則。1 つの文の 1 回の試みは、範囲表のスナップショットを 1 つ持つ。宛先も、どの要求の claim も、そのスナップショットで決める。
// 取引の範囲表がそのスナップショットでなくなったら、次の要求を送る前に (最初の送信でも、送り直しでも)、試みを捨てて、文を新しい
// 範囲表で計画し直す。捨てた試みの答えは、1 つも使わない。
// M19 (m19_claim_resplit.qnt) は、Worker が claim を文の状態として持ち、断られた claim だけをちょうど分け直す形で、区間を過不足なく
// 覆うこと (m19_red_gap) と、1 つの文の答えが同じ T であること (m19_red_mixed_t) を確かめた。M19 に範囲表はなく、claim を範囲表から
// 作り直す実装の形は書けない。ここでは、範囲表のスナップショットと、T を進める確かめと、範囲表の取り直しを足して、同じ性質を確かめる。
//
// シャードの約束 (このモデルの前提。m23h_wide_read.qnt と M23c が確かめる)。
//   シャードは、要求の claim の全部を、自分のスナップショットでいま持っているときだけ答え、持っていなければ NotOwner で断る。
//   答えるのは、claim の中の行の、時刻 T の値だけである (T が受け持ち始めた時刻より前なら、前の持ち主に尋ねて答える。M23c)。
// モデルのシャードは、この約束のとおりに答える。移動は 1 手で終わる (途中の待ちと断りは M19、M23c、m23h が扱う)。
//
// 舞台。シャード A、B、D。区間 1、2、3。最初の置き場所は 2 通り (A が全部を持つ。A が区間 1 と 2、B が区間 3 を持つ)。D は最初は
// 何も持たないので、文の宛先に入らない。区間は 1 つずつ、ほかのシャードへ動く。別の接続の書き込みが、区間に時刻を付けて確定する。
// 取引は、前の文で PRIOR の区間を読んでいて、次の文 (全表の読み) を実行する。
//
// invariant
//   noRegionTwice    集めた答えに、同じ区間が 2 つない
//   noRegionDropped  揃った文の答えは、どの区間も持つ
//   readAtT          集めた答えは、取引の読み取り時刻 T の値である (T を進めた後も)
//   priorHolds       前の文で読んだ値も、T の値である (読むだけの取引では、これと readAtT が直列化可能であることと同じ)
//   boundedRestarts  文を計画し直す回数は、移動の数以下である
// temporal
//   stmtEnds         文は、いつか揃う (移動では失敗しない)
module m23f_core {
  // ---- 規則の条件 ----
  // 要求の claim を切る範囲表と、計画し直す時期
  //   1  送る前に確かめる (決めた形)。取引の範囲表が、試みのスナップショットでなければ、送らずに計画し直す
  //   2  claim を、試みのスナップショットで切る。計画し直すのは、シャードが NotOwner で断ったときだけ (これも安全)
  //   0  赤: claim を、送るときの取引の範囲表で切り、確かめない (2 回目の実装)
  //   3  赤: 送り直しの前だけ確かめ、最初の送信の前は確かめない
  const SNAPSHOT: int
  const DROP_ON_RESTART: bool   // 計画し直すとき、それまでの答えを全部捨てる (false: 答えた宛先の答えを残す。赤)
  // ---- 場面 ----
  const LAYS: Set[int]          // 最初の置き場所 (0: A が全部。1: A が区間 1 と 2、B が区間 3)
  const PRIOR: Set[int]         // 取引が前の文で読んだ区間
  const MOVES_N: int
  const WRITES_N: int
  const OVERS_N: int            // 予算の取り分を超えて送り直す回数の上限
  const OTHER_SWAP: bool        // 同じ取引の別の読み (計画の途中の読み) が NotOwner で断られて、範囲表を取り直すことがある

  pure val A = 1
  pure val B = 2
  pure val D = 3
  pure val SHARDS = Set(1, 2, 3)
  pure val REGIONS = Set(1, 2, 3)
  // 要求の状態
  pure val Q_NONE = 0           // この試みの宛先ではない
  pure val Q_UNSENT = 1         // これから送る (送り直しを含む)
  pure val Q_FLIGHT = 2         // 送った。シャードはまだ答えていない
  pure val Q_SERVED = 3         // シャードが答えた。応答は Worker に届いていない
  pure val Q_DONE = 4           // 答えを受け取った
  pure val Q_WAIT = 5           // 自分が始めた、T を進める確かめを待っている
  // 応答の種類
  pure val K_ANSWER = 1
  pure val K_MOVED = 2
  pure val K_NOTOWNER = 3
  pure val K_OVER = 4

  type Part = { d: int, r: int, v: int }
  type Req = { st: int, sent: bool, t: int, fresh: bool, claim: Set[int], kind: int, x: int, rows: Set[Part] }
  type Worker = {
    st: int,                    // 0 まだ、1 文を実行中、2 文が揃った
    T: int, t0: int,            // 読み取り時刻と、最初の読み取り時刻
    cat: int,                   // 取引の範囲表の版
    fresh: bool,                // これから送る読みに、新しい確定を知らせてもらうか (T を進められなかったら false)
    rec: Set[int],              // 記録した読み (区間)。T を進める確かめが見る
    prior: int -> int,          // 前の文で読んだ値
    ps: int,                    // 試みのスナップショット (範囲表の版)
    req: int -> Req,
    parts: Set[Part],           // 集めた答え
    adv: int,                   // T を進める確かめの宛先の時刻 (0 = していない)
    restarts: int,
    overs: int,
    // ghost (witness 用)
    advSwap: bool,              // いまの確かめが、範囲表を取り直した
    passedSwap: bool,           // 範囲表を取り直した確かめが通って、T が進んだ
    firstRestart: bool,         // 最初の送信の前の確かめで、計画し直した
  }

  var now: int                      // 時計 (1 つ)
  var commits: int -> Set[int]      // 区間 -> 確定の時刻
  var route: int -> (int -> int)    // 範囲表の版 -> 区間 -> シャード
  var meta: int                     // 最新の版
  var writes: int
  var w: Worker

  pure def max(a: int, b: int): int = if (a > b) a else b
  pure def layout(i: int): int -> int = if (i == 0) REGIONS.mapBy(_ => A) else Map(1 -> A, 2 -> A, 3 -> B)
  pure val noReq: Req = { st: Q_NONE, sent: false, t: 0, fresh: false, claim: Set(), kind: 0, x: 0, rows: Set() }
  pure val unsent: Req = { ...noReq, st: Q_UNSENT }

  def regionsOf(v: int, d: int): Set[int] = REGIONS.filter(r => route.get(v).get(r) == d)
  def owner(r: int): int = route.get(meta).get(r)
  def newest(r: int): int = commits.get(r).fold(0, (a, c) => max(a, c))
  def valueAt(r: int, t: int): int = commits.get(r).filter(c => c <= t).fold(0, (a, c) => max(a, c))
  // 版 v の範囲表で計画した試みの要求。宛先は、その範囲表で区間を持つシャードである
  def planned(v: int): int -> Req = SHARDS.mapBy(d => if (regionsOf(v, d) != Set()) unsent else noReq)

  action initWith(lay: int): bool = all {
    now' = 0, commits' = REGIONS.mapBy(_ => Set()), route' = 0.to(MOVES_N).mapBy(_ => layout(lay)), meta' = 0, writes' = 0,
    w' = { st: 0, T: 0, t0: 0, cat: 0, fresh: true, rec: Set(), prior: REGIONS.mapBy(_ => -1), ps: 0, req: SHARDS.mapBy(_ => noReq),
           parts: Set(), adv: 0, restarts: 0, overs: 0, advSwap: false, passedSwap: false, firstRestart: false },
  }
  action init = { nondet lay = oneOf(LAYS) initWith(lay) }
  action keepWorld = all { now' = now, commits' = commits, route' = route, meta' = meta, writes' = writes }

  // ---- 世界 ----
  // 区間 r が、いまの持ち主から d へ動く。Meta の範囲表の版が 1 つ進む
  action move(r: int, d: int): bool = all {
    meta < MOVES_N, d != owner(r),
    meta' = meta + 1, route' = route.set(meta + 1, route.get(meta).set(r, d)),
    now' = now, commits' = commits, writes' = writes, w' = w,
  }
  // 別の接続の書き込みが、区間 r に確定する
  action write(r: int): bool = all {
    writes < WRITES_N,
    now' = now + 1, commits' = commits.set(r, commits.get(r).union(Set(now + 1))), writes' = writes + 1,
    route' = route, meta' = meta, w' = w,
  }

  // ---- 取引と文 ----
  // 取引は、前の文で PRIOR の区間を読んでいる (T = いまの時計)。次の文を、いまの範囲表で計画する
  action begin = all {
    w.st == 0,
    w' = { ...w, st: 1, T: now, t0: now, cat: meta, rec: PRIOR, ps: meta, req: planned(meta),
           prior: REGIONS.mapBy(r => if (PRIOR.contains(r)) valueAt(r, now) else -1) },
    keepWorld,
  }

  // 送る前の確かめ。取引の範囲表が、試みのスナップショットでなくなっていたら、計画し直す
  def mustRestart(d: int): bool =
    w.cat != w.ps and (SNAPSHOT == 1 or (SNAPSHOT == 3 and w.req.get(d).sent))
  // 計画し直す。DROP_ON_RESTART でなければ、答えた宛先の答えを残し、残りの宛先だけを新しい範囲表で決め直す
  def replanned(c: int, first: bool): Worker = {
    ...w, cat: c, ps: c, restarts: w.restarts + 1, firstRestart: w.firstRestart or first,
    parts: if (DROP_ON_RESTART) Set() else w.parts,
    req: SHARDS.mapBy(d => if (not(DROP_ON_RESTART) and w.req.get(d).st == Q_DONE) w.req.get(d) else planned(c).get(d)),
  }
  action restart(d: int): bool = all {
    w.st == 1, w.adv == 0, w.req.get(d).st == Q_UNSENT, mustRestart(d),
    w' = replanned(w.cat, not(w.req.get(d).sent)),
    keepWorld,
  }

  // 要求を送る。claim を切る範囲表は、SNAPSHOT が 2 なら試みのスナップショット、そのほかは、送るときの取引の範囲表である
  // (1 では、送る前の確かめがあるので、2 つは同じである)
  action send(d: int): bool = all {
    w.st == 1, w.req.get(d).st == Q_UNSENT, not(mustRestart(d)),
    val v = if (SNAPSHOT == 2) w.ps else w.cat
    w' = { ...w, req: w.req.set(d, { ...noReq, st: Q_FLIGHT, sent: true, t: w.T, fresh: w.fresh, claim: regionsOf(v, d) }) },
    keepWorld,
  }

  // シャード d が答える (シャードの約束)。claim の全部をいま持っていなければ NotOwner。fresh で、claim に T より新しい確定があれば
  // moved at。そうでなければ、claim の中の区間の、時刻 T の値を答える
  action serve(d: int, over: bool): bool = all {
    w.req.get(d).st == Q_FLIGHT,
    val q = w.req.get(d)
    val owned = q.claim.forall(r => owner(r) == d)
    val x = q.claim.fold(0, (a, r) => max(a, newest(r)))
    val kind = if (not(owned)) K_NOTOWNER else if (q.fresh and x > q.t) K_MOVED else if (over) K_OVER else K_ANSWER
    all {
      not(over) or w.overs < OVERS_N,
      w' = { ...w, overs: if (kind == K_OVER) w.overs + 1 else w.overs,
             req: w.req.set(d, { ...q, st: Q_SERVED, kind: kind, x: x, rows: q.claim.map(r => { d: d, r: r, v: valueAt(r, q.t) }) }) },
      keepWorld,
    }
  }

  // Worker が応答を受け取る。T を進める確かめの最中に届いた応答は、確かめが終わってから扱う
  action recv(d: int): bool = all {
    w.st == 1, w.adv == 0, w.req.get(d).st == Q_SERVED,
    val q = w.req.get(d)
    val again = w.req.set(d, { ...q, st: Q_UNSENT })
    all {
      // NotOwner: 取引の範囲表が、もう試みのスナップショットでなければそれで、同じなら Meta から取り直して、計画し直す
      w' = if (q.kind == K_NOTOWNER) replanned(if (w.cat != w.ps) w.cat else meta, false)
           else if (q.kind == K_MOVED and w.fresh and w.T < q.x)                     // T を進める確かめを始める
             { ...w, adv: q.x, advSwap: false, req: w.req.set(d, { ...q, st: Q_WAIT }) }
           else if (q.kind == K_MOVED or q.kind == K_OVER or q.t < w.T) { ...w, req: again }   // 送り直す
           else { ...w, parts: w.parts.union(q.rows), rec: w.rec.union(q.claim), req: w.req.set(d, { ...q, st: Q_DONE }) },
      keepWorld,
    }
  }

  // T を進める確かめ (read refresh)。記録した読みを、取引の範囲表の持ち主へ送る。持ち主でないシャードは NotOwner で断り、
  // 取引は範囲表を取り直して、分け直した読みを送り直す (M23)
  def refused: bool = w.rec.exists(r => route.get(w.cat).get(r) != owner(r))
  action advRefused = all {
    w.st == 1, w.adv > 0, refused,
    w' = { ...w, cat: meta, advSwap: true },
    keepWorld,
  }
  // 確かめが終わる。記録した読みに、窓 (T, to] の確定がなければ T を進める。あれば、T はそのままで、以後は fresh を付けない
  action advEnd = all {
    w.st == 1, w.adv > 0, not(refused),
    val ok = w.rec.forall(r => not(commits.get(r).exists(c => c > w.T and c <= w.adv)))
    w' = { ...w, adv: 0, T: if (ok) w.adv else w.T, fresh: w.fresh and ok, passedSwap: w.passedSwap or (ok and w.advSwap),
           req: SHARDS.mapBy(d => if (w.req.get(d).st == Q_WAIT) { ...w.req.get(d), st: Q_UNSENT } else w.req.get(d)) },
    keepWorld,
  }
  // 同じ取引の別の読みが NotOwner で断られて、取引の範囲表を取り直す
  action otherSwap = all {
    OTHER_SWAP, w.st == 1, w.cat < meta,
    w' = { ...w, cat: meta },
    keepWorld,
  }
  // どの宛先も答えた。文が揃う
  action finish = all {
    w.st == 1, w.adv == 0, SHARDS.forall(d => w.req.get(d).st == Q_NONE or w.req.get(d).st == Q_DONE),
    w' = { ...w, st: 2 },
    keepWorld,
  }

  action workerStep = any {
    begin, advRefused, advEnd, finish,
    { nondet d = oneOf(SHARDS) any { restart(d), send(d), recv(d) } },
  }
  action shardStep = { nondet d = oneOf(SHARDS) serve(d, false) }
  action step = any {
    workerStep, shardStep, otherSwap,
    { nondet d = oneOf(SHARDS) serve(d, true) },
    { nondet r = oneOf(REGIONS) nondet d = oneOf(SHARDS) move(r, d) },
    { nondet r = oneOf(REGIONS) write(r) },
  }

  // ---- 不変条件 ----
  def answers(r: int): int = w.parts.filter(p => p.r == r).size()
  val noRegionTwice = REGIONS.forall(r => answers(r) <= 1)
  val noRegionDropped = w.st != 2 or REGIONS.forall(r => answers(r) >= 1)
  val readAtT = w.parts.forall(p => p.v == valueAt(p.r, w.T))
  val priorHolds = w.st == 0 or PRIOR.forall(r => w.prior.get(r) == valueAt(r, w.T))
  val boundedRestarts = w.restarts <= MOVES_N
  val stmtSafe = and { noRegionTwice, noRegionDropped, readAtT, priorHolds, boundedRestarts }

  // ---- witness ----
  // 計画し直した文が、2 つのシャードの答えで揃う
  val witnessRestartThenDone = not(w.st == 2 and w.restarts > 0 and w.parts.map(p => p.d).size() > 1)
  // 範囲表を取り直した確かめが通って T が進み、文が揃う
  val witnessAdvancedAcrossSwap = not(w.st == 2 and w.passedSwap and w.T > w.t0)
  // 取引の範囲表が替わった後、送る要求が残っていなかったので、前のスナップショットの答えだけで揃う
  val witnessDoneOnOldSnapshot = not(w.st == 2 and w.cat != w.ps)
  // 最初の送信の前の確かめで計画し直した文が、揃う (送り直しのない道)
  val witnessFirstSendRestart = not(w.st == 2 and w.firstRestart)
  // T を進められなかった文が、古い T のまま揃う
  val witnessNotAdvanced = not(w.st == 2 and not(w.fresh) and w.restarts > 0)

  // ---- 活性 ----
  // Worker の手とシャードの答えに、弱い公平性を置く。移動、書き込み、予算の超過、別の読みの取り直しには置かない
  val vars = (now, commits, route, meta, writes, w)
  temporal fairness = weakFair(workerStep, vars) and weakFair(shardStep, vars)
  temporal stmtEnds = fairness implies eventually(w.st == 2)
}

// ---- 規則 (緑) ----------------------------------------------------------------------------------------------------------

// 決めた形。送る前に確かめ、取引の範囲表が試みのスナップショットでなければ計画し直す。移動 1 回
module m23f_green {
  import m23f_core(SNAPSHOT = 1, DROP_ON_RESTART = true, LAYS = Set(0, 1), PRIOR = Set(2), MOVES_N = 1, WRITES_N = 2, OVERS_N = 1,
                   OTHER_SWAP = true).*
  // 下の赤 (m23f_red_claim_at_send の keptAnswerTest) と同じ順序。確かめが範囲表を取り直して通った後、B の送り直しの前の確かめが、
  // 文を計画し直す。A の答えは捨てる
  run restartTest =
    initWith(1).then(begin)
        .then(send(A)).then(serve(A, false)).then(recv(A))             // A が区間 1 と 2 を T = 0 で答える
        .then(write(3))                                                  // 区間 3 に時刻 1 の確定
        .then(send(B)).then(serve(B, false))                             // B は moved at 1
        .then(move(2, B))                                                // 区間 2 が A から B へ動く
        .then(recv(B)).then(advRefused).then(advEnd)                     // 確かめが範囲表を取り直して通る。T = 1
        .expect(w.T == 1 and w.cat == 1 and w.ps == 0 and mustRestart(B))
        .then(restart(B))
        .expect(w.parts == Set() and w.req.get(A).st == Q_UNSENT)
        .then(send(A)).then(serve(A, false)).then(recv(A)).then(send(B)).then(serve(B, false)).then(recv(B)).then(finish)
        .expect(w.st == 2 and stmtSafe and w.restarts == 1 and not(witnessAdvancedAcrossSwap))
}
// 同上、移動 2 回
module m23f_green2 {
  import m23f_core(SNAPSHOT = 1, DROP_ON_RESTART = true, LAYS = Set(0, 1), PRIOR = Set(2), MOVES_N = 2, WRITES_N = 2, OVERS_N = 1,
                   OTHER_SWAP = true).*
}
// claim を試みのスナップショットで切り、計画し直すのは NotOwner のときだけにする形。シャードの約束が、古い claim を断る
module m23f_green_plan {
  import m23f_core(SNAPSHOT = 2, DROP_ON_RESTART = true, LAYS = Set(0, 1), PRIOR = Set(2), MOVES_N = 1, WRITES_N = 2, OVERS_N = 1,
                   OTHER_SWAP = true).*
  // 同じ順序。B は、前のスナップショットの claim (区間 3) で送り直され、そのまま答える。区間 2 は、A の答え (移動の前に答えた) にある
  run oldClaimTest =
    initWith(1).then(begin)
        .then(send(A)).then(serve(A, false)).then(recv(A))
        .then(write(3)).then(send(B)).then(serve(B, false)).then(move(2, B))
        .then(recv(B)).then(advRefused).then(advEnd)
        .then(send(B)).then(serve(B, false)).then(recv(B)).then(finish)
        .expect(w.st == 2 and stmtSafe and w.restarts == 0 and not(witnessDoneOnOldSnapshot))
}
module m23f_green_plan2 {
  import m23f_core(SNAPSHOT = 2, DROP_ON_RESTART = true, LAYS = Set(0, 1), PRIOR = Set(2), MOVES_N = 2, WRITES_N = 2, OVERS_N = 1,
                   OTHER_SWAP = true).*
}
// 活性。文はいつか揃う
module m23f_live {
  import m23f_core(SNAPSHOT = 1, DROP_ON_RESTART = true, LAYS = Set(0, 1), PRIOR = Set(2), MOVES_N = 1, WRITES_N = 2, OVERS_N = 1,
                   OTHER_SWAP = true).*
}

// ---- 赤: 条件を 1 つずつ外す ----------------------------------------------------------------------------------------------

// 赤: 2 回目の実装。claim を、送るときの取引の範囲表で切る。宛先は、文を計画したときの範囲表のままである
module m23f_red_claim_at_send {
  import m23f_core(SNAPSHOT = 0, DROP_ON_RESTART = true, LAYS = Set(0, 1), PRIOR = Set(2), MOVES_N = 1, WRITES_N = 2, OVERS_N = 1,
                   OTHER_SWAP = true).*
  // 宛先が 1 つで、区間が宛先にないシャードへ動く (history の乱択が見つけた形)。T は進まない
  run soleTargetTest =
    initWith(0).then(begin)                                              // A が全部を持つ。取引は区間 2 を読んでいる
        .then(send(A))                                                   // claim は区間 1、2、3。fresh
        .then(write(2)).then(serve(A, false))                            // 区間 2 に時刻 1 の確定。A は moved at 1
        .then(move(2, D))                                                // 区間 2 が D へ動く
        .then(recv(A)).then(advRefused).then(advEnd)                     // 確かめは範囲表を取り直し、区間 2 の確定で通らない
        .expect(w.T == 0 and not(w.fresh) and w.cat == 1)
        .then(send(A))                                                   // 送り直す claim は、新しい範囲表の A の区間 1 と 3
        .expect(w.req.get(A).claim == Set(1, 3))
        .then(serve(A, false)).then(recv(A)).then(finish)
        .expect(w.st == 2 and not(noRegionDropped) and noRegionTwice)   // 区間 2 は、誰も読んでいない
  // 宛先が 2 つで、答えを残した宛先から、送り直す宛先へ区間が動く。T は進む
  run keptAnswerTest =
    initWith(1).then(begin)
        .then(send(A)).then(serve(A, false)).then(recv(A))             // A が区間 1 と 2 を答える
        .then(write(3)).then(send(B)).then(serve(B, false))              // B は moved at 1
        .then(move(2, B))
        .then(recv(B)).then(advRefused).then(advEnd)                     // 確かめは範囲表を取り直して通る。T = 1
        .then(send(B))                                                   // 送り直す claim は、新しい範囲表の B の区間 2 と 3
        .expect(w.req.get(B).claim == Set(2, 3))
        .then(serve(B, false)).then(recv(B)).then(finish)
        .expect(w.st == 2 and not(noRegionTwice))                        // 区間 2 を、A と B の両方が答えた
  // T を進めたのは、送り直す要求ではなく、並んだ別の要求である (stale)。応答を待つ間に区間が、宛先にないシャードへ動く
  run staleTest =
    initWith(1).then(begin)
        .then(send(A)).then(serve(A, false))                             // A が区間 1 と 2 を T = 0 で答える。応答は届いていない
        .then(move(2, D))
        .then(write(3)).then(send(B)).then(serve(B, false)).then(recv(B))   // B は moved at 1。確かめが始まる
        .then(advRefused).then(advEnd)                                   // 記録した区間 2 は D へ。変わっていないので通る。T = 1
        .then(recv(A))                                                   // A の答えは古い T のもの。送り直す
        .expect(w.req.get(A).st == Q_UNSENT and w.T == 1)
        .then(send(A)).expect(w.req.get(A).claim == Set(1))
        .then(serve(A, false)).then(recv(A))
        .then(send(B)).then(serve(B, false)).then(recv(B)).then(finish)
        .expect(w.st == 2 and not(noRegionDropped))                      // 区間 2 は、誰も読んでいない
}

// 赤: 送り直しの前だけ確かめる。同じ取引の別の読みが範囲表を取り直した後の、最初の送信が、新しい範囲表で claim を切る
module m23f_red_resend_only {
  import m23f_core(SNAPSHOT = 3, DROP_ON_RESTART = true, LAYS = Set(0, 1), PRIOR = Set(2), MOVES_N = 1, WRITES_N = 2, OVERS_N = 1,
                   OTHER_SWAP = true).*
  run lateFirstSendTest =
    initWith(1).then(begin)
        .then(send(A)).then(serve(A, false)).then(recv(A))             // A が区間 1 と 2 を答える
        .then(move(2, B)).then(otherSwap)                                // 別の読みが範囲表を取り直す
        .then(send(B))                                                   // B への最初の送信。claim は区間 2 と 3
        .then(serve(B, false)).then(recv(B)).then(finish)
        .expect(w.st == 2 and not(noRegionTwice))
}

// 赤: 計画し直すとき、答えた宛先の答えを残す。2 つのスナップショットの答えが混ざる
module m23f_red_keep_answers {
  import m23f_core(SNAPSHOT = 1, DROP_ON_RESTART = false, LAYS = Set(0, 1), PRIOR = Set(2), MOVES_N = 1, WRITES_N = 2, OVERS_N = 1,
                   OTHER_SWAP = true).*
  run mixedTest =
    initWith(1).then(begin)
        .then(send(A)).then(serve(A, false)).then(recv(A))
        .then(move(2, B)).then(otherSwap)
        .then(restart(B))                                                // A の答え (区間 1 と 2) を残して、B を新しい範囲表で決め直す
        .then(send(B)).then(serve(B, false)).then(recv(B)).then(finish)
        .expect(w.st == 2 and not(noRegionTwice))
}
