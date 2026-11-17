// -*- mode: Bluespec; -*-
// M24c: DDL が待つ表の集合と、ロックを与える 1 つの判断 (不変条件 16。D1、D2、D3)
//
// M24 の m24_retry (specs/m24_table_epochs.qnt) は、悲観の取引 1 件と、書き込みのロックだけを持つ。実装した後で、同じ場所に欠陥が
// 3 つ見つかった (docs/design-catalog-epoch.md の「ロックを与える判断と fence」)。
//   D1  ロックを取る読み (BEGIN IMMEDIATE の主キーの読み) が、書き込み禁止の表でロックを得る。全シャードが prepare を適用した後に
//       始めた取引が、DDL を取り消させる。
//   D2  一意でない CREATE INDEX と DROP INDEX は、表の書きの epoch を進めるのに、fence が空で、行ロックの持ち主を待たない。
//   D3  シャードが行ロックの持ち主を待っている間に、新しい取引がロックを得る。その取引がロックを持ち続けると、DDL は失敗する。
//       行が、もう prepare を適用したシャードにあれば、その取引は待ち、DDL は確定する (規則 4 に反する)。
// m24_retry は、取引 1 件なので D3 を、ロックを取る読みがないので D1 を持てず、X の DDL は X を fence に持つものとしていた (D2)。
// このファイルは、m24_retry の時刻の数え方をそのまま使い、取引を 2 件にし、ロックを取る読みと、DDL の前に読んだ取引を足したものである。
// m24_retry の条件 (WAIT_LOCKS、WOUND、HOLD、KEEP_BUDGET、FRESH_EPOCH) は、決めたとおりに固定した (外した形は m24_retry が確かめている)。
//
// 決めた設計 (条件 5 つの積。赤は 1 つずつ外す):
//   ANY_DEP        シャードは、行ロックを与えるかを、1 つの判断で決める。要求が表に書き込みとして頼るか、読みとして頼るか (ロックを取る
//                  読み) を見ない。false は D1 (書き込みだけが fence を見る)。
//   FENCE_COVERS   DDL が書きの epoch を進める表 X は、その DDL の fence に入る (prepare は X の行ロックを待ち、X への書き込みを止める)。
//                  false は D2 (fence が空。prepare は待たずに適用され、DDL はすぐに確定する)。
//   CLOSE_WINDOW   シャードは、prepare の適用を待ち始めた時 (PENDING) から、X の新しいロックを、X のロックを持たない取引に与えない。
//                  与えられなかった要求は、断られずに、DDL の後ろで待つ (適用した後の書き込み禁止と同じ)。false は D3。
//   ONE_RESTART    ロックを持つ取引が書き込み禁止に当たって試みを取り消させるとき、Meta は、取り消しと、やり直しの prepare (新しい
//                  epoch、同じ期限) を、1 手で記録する。DDL が始まってから終わるまで、開いている試みのない時がない。false は、
//                  m24_retry の形 (進める側が、取り消しを知ってからやり直す)。取り消しを適用したシャードは、やり直しの prepare を
//                  見るまで、禁止も待ちもなく、その間に来た取引がロックを得る (CLOSE_WINDOW が試みごとにしか効かない)。
//   HOLDS_ANYWHERE 「X のロックを持つ取引」は、X のロックをどのシャードに持っていてもよい (要求が運ぶ。m24_retry の HOLD と同じ)。
//                  false は、待っているシャードに持つ取引だけ。P に持つ取引の、Q (別の取引を待っている) への書き込みが、DDL の
//                  期限まで待たされる。行が 1 つのシャードにあれば待たない。
//
// 待つ間の新しいロックの要求の扱い (決めたこと): 断らずに、DDL の後ろで待たせる。SQLITE_BUSY で断る案は採らない。SQLite では、
// DDL が書き込みのロックを待つ間に来た書き手は、busy_timeout まで待ち、DDL が終われば通る。すぐに断ると、SQLite では通る文が失敗する
// (BEGIN IMMEDIATE の取引は、何も読んでいないので、DDL の後の表定義で計画し直して通る)。待ちは、DDL が終わるまでで、DDL は期限
// (5 秒) までに終わる (適用した後の仕事が長い DDL では、今の書き込み禁止の待ちの上限 30 秒。モデルにない)。
//
// SQLite と比べた、許す結果。SQLite の書き込みのロックに公平な列はない。持ち主 H が確定した時、待っていた DDL と、待っていた新しい
// 書き手 R の、どちらが先にロックを取るかは決まっていない。R が先に取って期限まで持てば、DDL は SQLITE_BUSY になる。
// D∞ は、そのうちの片方だけを起こす。DDL を始めた刻みより後の刻みに最初のロックを求めた取引は、いつも DDL の後ろになる。
// だから DDL の結果は、DDL より前の刻みにロックを求めた取引 (strict) の時刻だけで決まる。同じ刻みの競り (最初のロックを DDL を
// 始めた刻みに求める、COMMIT を期限の刻みに送る) は、SQLite と同じく、両方を許す。
//
// 時刻、内部の手、刻みは m24_retry と同じ (刻みは、内部の手がどれもできないときにだけ進む。期限 B は 2 刻み)。
// モデル: 表 X、シャード P と Q、取引 2 件。取引は、ロックを取る文を 2 つ実行して COMMIT する。行の置き場所は init が選ぶ
// (取引 1 の 1 つ目の行は P。対称なので)。取引の形は 3 つ。
//   WRITER     SQL の BEGIN。文は 2 つとも書き込み。
//   IMMEDIATE  BEGIN IMMEDIATE。1 つ目の文は、主キーで読んでロックを取る読み、2 つ目は書き込み。
//   READER     素の BEGIN で、DDL より前に X をロックなしで読んだ。文は 2 つとも書き込み。何も読んでいない取引と違って、DDL の確定の
//              後に計画し直せない (SQLite の SQLITE_BUSY_SNAPSHOT)。
// シャードの、いまの試みについての位置は 4 つ: UNSEEN (prepare を見ていない)、PENDING (見たが、X の行ロックがあるので適用を待って
// いる)、FENCED (適用した。書き込み禁止)、ENDED (終わりを適用した)。
//
// invariant:
//   asSqlite          DDL の結果は、DDL より前の刻みにロックを求めた取引の時刻だけで決まる。そういう取引が期限の刻みまでに COMMIT を
//                     送らなかったときだけ SQLITE_BUSY で、期限より前には失敗しない。DDL は期限までに終わる。
//   placementFree     競りのない予定では、DDL の結果は、利用者の時刻の関数と等しい (置き場所も、取引の形も、使わない)。
//   holderSurvives    X の行ロックを持つ取引は、DDL のために断られない。
//   writersSurvive    断られるのは READER だけである (BEGIN IMMEDIATE の取引と、書き込みから始める取引は、DDL の後で計画し直す)。
//   readerOutcome     DDL より後の刻みに最初の書き込みを求めた READER は、DDL が確定したときにだけ、断られる (SQLite と同じ。
//                     置き場所に依らない)。
//   holderNotDelayed  ロックを持つ取引の文は、時刻をまたいで待たない。
//   waitsOnlyForDdl   文が時刻をまたいで待つのは、DDL が進んでいる間だけである (待ちは DDL の期限までに終わる)。
//   preparedStays     全シャードが prepare を適用して ok と答えた試みは、取引に取り消されない。
//   noReblock         取引は、同じシャードで、2 度取り消させない。
//   checkSawRows      DDL の commit が頼る ok は、どれも、そのシャードがその後で行の書き込みを受けていないものである。
module m24c_core {
  const ANY_DEP: bool
  const FENCE_COVERS: bool
  const CLOSE_WINDOW: bool
  const ONE_RESTART: bool
  const HOLDS_ANYWHERE: bool
  // ---- 場面 ----
  const SCENE: int              // 0 どの置き場所も、1 全部の行を P に、2 取引 1 の行を P に、取引 2 の行を Q に、
                                // 3 取引 1 の 2 つ目の行と、取引 2 の行を Q に (取引 1 が、取引 2 の待つ Q の禁止に当たる)
  const STYLE1: Set[int]        // init が選ぶ、取引 1 の形
  const STYLE2: Set[int]        // init が選ぶ、取引 2 の形

  pure val P = 1
  pure val Q = 2
  pure val SHARDS = Set(1, 2)
  pure val TXNS = Set(1, 2)
  pure val B = 2                // DDL の期限 (busy_timeout の 5 秒) を、刻みの数で
  pure val MAXT = 4

  // 場面
  pure val ANYWHERE = 0
  pure val ONE_SHARD = 1
  pure val APART = 2
  pure val CROSS = 3
  // 取引の形
  pure val WRITER = 0
  pure val IMMEDIATE = 1
  pure val READER = 2
  // いまの試み
  pure val NONE = 0
  pure val OPEN = 1
  pure val COMMITTED = 2
  pure val ABORTED = 3
  // DDL の結果
  pure val RUNNING = 0
  pure val OK = 1
  pure val BUSY = 2
  // シャードの、いまの試みについての位置
  pure val UNSEEN = 0
  pure val PENDING = 1
  pure val FENCED = 2
  pure val ENDED = 3

  var now: int
  var sh: int -> int            // 文 -> 行のシャード。1 と 2 は取引 1 の、3 と 4 は取引 2 の、1 つ目と 2 つ目の文
  var style: int -> int         // 取引 -> 形
  // ---- DDL ----
  var meta: int                 // いまの試み
  var dres: int                 // DDL の結果
  var dstart: int               // 期限を数え始めた時刻 (-1 まだ)
  var cur: int -> int           // シャード -> いまの試みについての位置
  var lag: int -> bool          // シャード -> 前の試みの prepare を適用したまま、その abort をまだ適用していない (書き込み禁止)
  var acked: Set[int]           // いまの試みに ok と答えたシャード
  // ---- 取引 ----
  var pc: int -> int            // 取引 -> 0 文 1 の前、1 文 1 が済んだ、2 文 2 が済んだ、3 確定した、4 断られた
  var pend: int -> bool         // 取引 -> 利用者が次の文を送り、まだ答えがない
  var locks: int -> Set[int]    // 取引 -> X の行ロックを持つシャード
  var rebased: int -> bool      // 取引 -> DDL の commit の後の表定義で計画した
  // ---- ghost ----
  var d0: int                   // DDL を始めた時刻 (-1 まだ)
  var dEnd: int                 // DDL が終わった時刻
  var tW: int -> int            // 取引 -> 利用者が文 1 を送った時刻 (-1 まだ)
  var tC: int -> int            // 取引 -> 利用者が COMMIT を送った時刻 (-1 まだ)
  var refusedHolder: bool       // 行ロックを持つ取引が、DDL のために断られた
  var delayed: bool             // ロックを持つ取引の文が、答えのないまま時刻をまたいだ
  var stuck: bool               // 文が、DDL が進んでいないのに、答えのないまま時刻をまたいだ
  var reblocked: bool           // 取引が、取り消させたことのあるシャードで、また取り消させた
  var badCheck: bool            // DDL の commit が、その後で行の書き込みを受けたシャードの ok に頼った
  var preparedWound: bool       // 全シャードが ok と答えた試みを、取引が取り消させた
  var retried: bool             // やり直しの試みがある (witness 用)
  var woundAt: Set[int]         // 取り消させた (取引, シャード)。10 * 取引 + シャード
  var late: Set[int]            // ok と答えた後で、行の書き込みを受けたシャード

  action initWith(a2: int, b1: int, b2: int, s1: int, s2: int): bool = all {
    now' = 0, sh' = Map(1 -> P, 2 -> a2, 3 -> b1, 4 -> b2), style' = Map(1 -> s1, 2 -> s2),
    meta' = NONE, dres' = RUNNING, dstart' = -1, cur' = SHARDS.mapBy(_ => UNSEEN), lag' = SHARDS.mapBy(_ => false), acked' = Set(),
    pc' = TXNS.mapBy(_ => 0), pend' = TXNS.mapBy(_ => false), locks' = TXNS.mapBy(_ => Set()), rebased' = TXNS.mapBy(_ => false),
    d0' = -1, dEnd' = -1, tW' = TXNS.mapBy(_ => -1), tC' = TXNS.mapBy(_ => -1),
    refusedHolder' = false, delayed' = false, stuck' = false, reblocked' = false, badCheck' = false, preparedWound' = false,
    retried' = false, woundAt' = Set(), late' = Set(),
  }
  action init = {
    nondet a2 = oneOf(SHARDS)
    nondet b1 = oneOf(SHARDS)
    nondet b2 = oneOf(SHARDS)
    nondet s1 = oneOf(STYLE1)
    nondet s2 = oneOf(STYLE2)
    all {
      SCENE != ONE_SHARD or (a2 == P and b1 == P and b2 == P),
      SCENE != APART or (a2 == P and b1 == Q and b2 == Q),
      SCENE != CROSS or (a2 == Q and b1 == Q and b2 == Q),
      initWith(a2, b1, b2, s1, s2),
    }
  }

  action keepDdl = all { meta' = meta, dres' = dres, dstart' = dstart, cur' = cur, lag' = lag, acked' = acked }
  action keepTxn = all { pc' = pc, pend' = pend, locks' = locks, rebased' = rebased }
  action keepTimes = all { d0' = d0, dEnd' = dEnd, tW' = tW, tC' = tC }
  action keepFlags = all {
    refusedHolder' = refusedHolder, delayed' = delayed, stuck' = stuck, reblocked' = reblocked, badCheck' = badCheck,
    preparedWound' = preparedWound, retried' = retried, woundAt' = woundAt, late' = late,
  }
  action keepEnv = all { now' = now, sh' = sh, style' = style }

  // ---- 見えるもの ----
  def deadline: int = dstart + B
  def closed: bool = meta == COMMITTED or meta == ABORTED
  /** シャード s に、X の行ロックがある。 */
  def held(s: int): bool = TXNS.exists(t => locks.get(t).contains(s))
  /** 取引 t は、X の行ロックを (どこかのシャードに) 持つ。要求が運ぶ。 */
  def holder(t: int): bool = locks.get(t) != Set()
  /** s は、X への書き込みを止めている (いまの試みか、前の試みの prepare を適用して、終わりをまだ適用していない)。 */
  def fencedAt(s: int): bool = FENCE_COVERS and (cur.get(s) == FENCED or lag.get(s))
  /** s の禁止は、開いている試みのものである (取り消させる相手がいる)。 */
  def openFence(s: int): bool = FENCE_COVERS and cur.get(s) == FENCED and meta == OPEN
  /** s は、prepare を見て、X の行ロックが空くのを待っている。 */
  def pendingAt(s: int): bool = cur.get(s) == PENDING
  /** s は DDL の commit を適用した。取引 t の、DDL より前の計画は古い。 */
  def stale(t: int, s: int): bool = cur.get(s) == ENDED and meta == COMMITTED and not(rebased.get(t))
  /** 取引 t の次の、ロックを取る文の行のシャード。 */
  def opShard(t: int): int = sh.get(2 * (t - 1) + (if (pc.get(t) == 0) 1 else 2))
  /** 取引 t の次の文は、ロックを取る読みである (書き込みとして頼らない)。 */
  def isRead(t: int): bool = pc.get(t) == 0 and style.get(t) == IMMEDIATE
  /** この要求は、fence を見る。欠陥 D1 では、ロックを取る読みは見ない。 */
  def gated(t: int): bool = ANY_DEP or not(isRead(t))
  /**
   * ロックを与える判断 (不変条件 16)。取引 t が、シャード s で、X の行のロックを求めた。
   *   適用した prepare (書き込み禁止) があれば、与えない。
   *   prepare の適用を待っている間は、X のロックを持つ取引にだけ与える。
   * 与えられなかった要求は、DDL の後ろで待つ。X のロックを持つ取引が禁止に当たったときは、下の holdAtFence と wound。
   */
  def mayLock(t: int, s: int): bool = or {
    not(gated(t)),
    and {
      not(fencedAt(s)),
      or { not(pendingAt(s)), not(CLOSE_WINDOW), if (HOLDS_ANYWHERE) holder(t) else locks.get(t).contains(s) },
    },
  }
  /** 開いている試みの禁止のうち、取引 t の送った文が当たっているもの。 */
  def blockers(t: int): Set[int] =
    (if (pc.get(t) <= 1) (if (gated(t)) Set(opShard(t)) else Set()) else locks.get(t)).filter(s => openFence(s))

  // ---- 内部の手ができるか。tick の条件と、手の条件の両方に、この定義だけを使う ----
  def canExec(t: int): bool = pend.get(t) and (
    if (pc.get(t) <= 1) mayLock(t, opShard(t))
    else pc.get(t) == 2 and not(locks.get(t).exists(s => fencedAt(s)))
  )
  def canHold(t: int): bool =
    pend.get(t) and pc.get(t) == 1 and gated(t) and holder(t) and fencedAt(opShard(t)) and not(locks.get(t).contains(opShard(t)))
  def canWound(t: int): bool =
    meta == OPEN and pend.get(t) and pc.get(t) <= 2 and holder(t) and blockers(t) != Set()
      and blockers(t).forall(s => locks.get(t).contains(s))
  def canSee(s: int): bool = meta == OPEN and cur.get(s) == UNSEEN and not(lag.get(s))
  def canApplyPrep(s: int): bool = meta == OPEN and cur.get(s) == PENDING and not(held(s))
  def canApplyEnd(s: int): bool = closed and cur.get(s) != ENDED and not(lag.get(s))
  def canApplyLag(s: int): bool = lag.get(s)
  def canAck(s: int): bool = meta == OPEN and cur.get(s) == FENCED and not(acked.contains(s))
  def canCommitDdl: bool = dres == RUNNING and meta == OPEN and acked == SHARDS and now <= deadline
  def canRetry: bool = not(ONE_RESTART) and dres == RUNNING and meta == ABORTED and now < deadline
  def canExpire: bool = dres == RUNNING and meta != NONE and now >= deadline
  def urgent: bool = or {
    TXNS.exists(t => canExec(t) or canHold(t) or canWound(t)),
    canCommitDdl, canRetry, canExpire,
    SHARDS.exists(s => canSee(s) or canApplyPrep(s) or canApplyEnd(s) or canApplyLag(s) or canAck(s)),
  }
  /** prepare を見たシャードの位置。X の行ロックがあれば待ち、なければ適用する。fence が空なら (D2)、待たずに適用する。 */
  def seen(s: int): int = if (FENCE_COVERS and held(s)) PENDING else FENCED

  // ---- 利用者 ----
  // 取引の次の文を送る (ロックを取る文 2 つ、COMMIT)。送らずに待ってもよい。
  action issue(t: int): bool = all {
    not(pend.get(t)), pc.get(t) <= 2,
    pend' = pend.set(t, true), pc' = pc, locks' = locks, rebased' = rebased,
    tW' = if (pc.get(t) == 0) tW.set(t, now) else tW, tC' = if (pc.get(t) == 2) tC.set(t, now) else tC, d0' = d0, dEnd' = dEnd,
    keepDdl, keepFlags, keepEnv,
  }
  // 別の接続が DDL を始める。最初の試みの prepare を記録する。
  action startDdl = all {
    meta == NONE, now + B <= MAXT,
    meta' = OPEN, dres' = RUNNING, dstart' = now, cur' = cur, lag' = lag, acked' = acked,
    d0' = now, dEnd' = dEnd, tW' = tW, tC' = tC,
    keepTxn, keepFlags, keepEnv,
  }
  // 時刻が進む。内部の手がどれもできないときだけ。
  action tick = all {
    now < MAXT, not(urgent),
    now' = now + 1, sh' = sh, style' = style,
    delayed' = (delayed or TXNS.exists(t => pend.get(t) and holder(t))),
    stuck' = (stuck or TXNS.exists(t => pend.get(t) and not(d0 >= 0 and dres == RUNNING))),
    refusedHolder' = refusedHolder, reblocked' = reblocked, badCheck' = badCheck, preparedWound' = preparedWound, retried' = retried,
    woundAt' = woundAt, late' = late,
    keepDdl, keepTxn, keepTimes,
  }

  // ---- 取引 ----
  // 送られた文を、シャードが実行する。ロックを取る文は、ロックを与える判断 (mayLock) を通ったときだけ。COMMIT は、ロックを持つ
  // シャードが書き込み禁止でないときだけ。古い計画なら断られる。何もしていない取引は、新しい表定義で計画し直す (READER は、
  // DDL の前に読んでいるので、計画し直せない)。
  action exec(t: int): bool = all {
    canExec(t),
    val p = pc.get(t)
    val s = opShard(t)
    val old = if (p <= 1) stale(t, s) else locks.get(t).exists(x => stale(t, x))
    all {
      if (old and p == 0 and style.get(t) != READER) all {
        rebased' = rebased.set(t, true), pc' = pc, pend' = pend, locks' = locks, refusedHolder' = refusedHolder, late' = late,
      } else if (old) all {
        pc' = pc.set(t, 4), pend' = pend.set(t, false), locks' = locks.set(t, Set()), rebased' = rebased,
        refusedHolder' = (refusedHolder or holder(t)), late' = late,
      } else if (p <= 1) all {
        pc' = pc.set(t, p + 1), pend' = pend.set(t, false), locks' = locks.set(t, locks.get(t).union(Set(s))), rebased' = rebased,
        refusedHolder' = refusedHolder,
        late' = if (not(isRead(t)) and dres == RUNNING and acked.contains(s)) late.union(Set(s)) else late,
      } else all {
        pc' = pc.set(t, 3), pend' = pend.set(t, false), locks' = locks.set(t, Set()), rebased' = rebased,
        refusedHolder' = refusedHolder, late' = late,
      },
      delayed' = delayed, stuck' = stuck, reblocked' = reblocked, badCheck' = badCheck, preparedWound' = preparedWound,
      retried' = retried, woundAt' = woundAt,
      keepDdl, keepTimes, keepEnv,
    }
  }
  // HOLD (m24_retry): X のロックを持つ取引の文が、書き込み禁止に当たった。シャードは文を断り、その行のロックを取引に与える。
  action holdAtFence(t: int): bool = all {
    canHold(t),
    locks' = locks.set(t, locks.get(t).union(Set(opShard(t)))), pc' = pc, pend' = pend, rebased' = rebased,
    keepDdl, keepTimes, keepFlags, keepEnv,
  }
  // WOUND: X のロックを持つ取引の文が、開いている試みの書き込み禁止に当たった。Worker が Meta に、その試みを取り消させる。
  // ONE_RESTART なら、Meta は同じ 1 手で、やり直しの prepare (新しい epoch、同じ期限) を記録する。待っているシャードは、待ったまま
  // 新しい試みを待つ。適用したシャードは、abort を適用するまで禁止が残り (lag)、abort と新しい prepare を続けて適用する (applyLag)。
  action wound(t: int): bool = all {
    canWound(t),
    if (ONE_RESTART) all {
      meta' = OPEN,
      cur' = SHARDS.mapBy(s => if (cur.get(s) == PENDING) PENDING else UNSEEN),
      lag' = SHARDS.mapBy(s => lag.get(s) or cur.get(s) == FENCED),
      acked' = Set(), late' = Set(), retried' = true,
    } else all {
      meta' = ABORTED, cur' = cur, lag' = lag, acked' = acked, late' = late, retried' = retried,
    },
    dres' = dres, dstart' = dstart,
    reblocked' = (reblocked or blockers(t).exists(s => woundAt.contains(10 * t + s))),
    woundAt' = woundAt.union(blockers(t).map(s => 10 * t + s)),
    preparedWound' = (preparedWound or acked == SHARDS),
    refusedHolder' = refusedHolder, delayed' = delayed, stuck' = stuck, badCheck' = badCheck,
    keepTxn, keepTimes, keepEnv,
  }

  // ---- 進める側 ----
  // ONE_RESTART でない形 (m24_retry): 進める側が、取り消された DDL を、後から新しい試みでやり直す。待っていたシャードも、
  // やり直しの prepare を見るまで、待っていない。
  action retry = all {
    canRetry,
    meta' = OPEN, dres' = dres, dstart' = dstart,
    cur' = SHARDS.mapBy(_ => UNSEEN),
    lag' = SHARDS.mapBy(s => lag.get(s) or cur.get(s) == FENCED),
    acked' = Set(), late' = Set(), retried' = true,
    refusedHolder' = refusedHolder, delayed' = delayed, stuck' = stuck, reblocked' = reblocked, badCheck' = badCheck,
    preparedWound' = preparedWound, woundAt' = woundAt,
    keepTxn, keepTimes, keepEnv,
  }
  // 全部のシャードが ok と答えた。期限のうちなら、commit を記録する。
  action commitDdl = all {
    canCommitDdl,
    meta' = COMMITTED, dres' = OK, dEnd' = now,
    badCheck' = (badCheck or late != Set()),
    dstart' = dstart, cur' = cur, lag' = lag, acked' = acked,
    d0' = d0, tW' = tW, tC' = tC,
    refusedHolder' = refusedHolder, delayed' = delayed, stuck' = stuck, reblocked' = reblocked, preparedWound' = preparedWound,
    retried' = retried, woundAt' = woundAt, late' = late,
    keepTxn, keepEnv,
  }
  // 期限が来た。開いている試みを取り消し、DDL は SQLITE_BUSY で失敗する。
  action expire = all {
    canExpire,
    meta' = if (meta == OPEN) ABORTED else meta, dres' = BUSY, dEnd' = now,
    dstart' = dstart, cur' = cur, lag' = lag, acked' = acked,
    d0' = d0, tW' = tW, tC' = tC,
    keepTxn, keepFlags, keepEnv,
  }

  // ---- シャード ----
  // いまの試みの prepare を見る。X の行ロックがあれば、適用を待ち始める (PENDING)。なければ適用する。
  action see(s: int): bool = all {
    canSee(s),
    cur' = cur.set(s, seen(s)), meta' = meta, dres' = dres, dstart' = dstart, lag' = lag, acked' = acked,
    keepTxn, keepTimes, keepFlags, keepEnv,
  }
  // 待っていたシャードが、X の行ロックが空いたので、prepare を適用する。
  action applyPrep(s: int): bool = all {
    canApplyPrep(s),
    cur' = cur.set(s, FENCED), meta' = meta, dres' = dres, dstart' = dstart, lag' = lag, acked' = acked,
    keepTxn, keepTimes, keepFlags, keepEnv,
  }
  // 閉じた試みの終わりを適用する (prepare をまだ適用していなければ、待たずに続けて適用する)。
  action applyEnd(s: int): bool = all {
    canApplyEnd(s),
    cur' = cur.set(s, ENDED), meta' = meta, dres' = dres, dstart' = dstart, lag' = lag, acked' = acked,
    keepTxn, keepTimes, keepFlags, keepEnv,
  }
  // 前の試みの abort を適用して、その禁止を解く。ONE_RESTART なら、列の続きに、やり直しの prepare がある。同じ 1 歩で見る。
  action applyLag(s: int): bool = all {
    canApplyLag(s),
    lag' = lag.set(s, false),
    cur' = if (ONE_RESTART and meta == OPEN and cur.get(s) == UNSEEN) cur.set(s, seen(s)) else cur,
    meta' = meta, dres' = dres, dstart' = dstart, acked' = acked,
    keepTxn, keepTimes, keepFlags, keepEnv,
  }
  // いまの試みの prepare を適用したシャードが、ok と答える (行の確かめは、ここで行う)。
  action ack(s: int): bool = all {
    canAck(s),
    acked' = acked.union(Set(s)), meta' = meta, dres' = dres, dstart' = dstart, cur' = cur, lag' = lag,
    keepTxn, keepTimes, keepFlags, keepEnv,
  }

  action step = any {
    startDdl, tick, retry, commitDdl, expire,
    { nondet t = oneOf(TXNS) any { issue(t), exec(t), holdAtFence(t), wound(t) } },
    { nondet s = oneOf(SHARDS) any { see(s), applyPrep(s), applyEnd(s), applyLag(s), ack(s) } },
  }

  // ---- 不変条件 -------------------------------------------------------------
  def D0: int = d0 + B
  /** 取引 t は、DDL を始める前の刻みに、最初のロックを求めた。 */
  def strict(t: int): bool = tW.get(t) >= 0 and tW.get(t) < d0
  /** 取引 t は、DDL の期限のあいだずっとロックを持っていた (DDL より前の刻みに求め、COMMIT を期限の刻みまでに送っていない)。 */
  def heldThrough(t: int): bool = strict(t) and not(tC.get(t) >= 0 and tC.get(t) <= D0)
  /** 取引 t は、DDL を待たせないか、期限のうちにロックを放した (DDL より後の刻みに求めたか求めていない、または COMMIT を期限より前の刻みに送った)。 */
  def releasedInTime(t: int): bool = not(tW.get(t) >= 0 and tW.get(t) <= d0) or (tC.get(t) >= 0 and tC.get(t) < D0)
  val asSqlite = d0 < 0 or and {
    dres != BUSY or (dEnd >= D0 and TXNS.exists(t => not(releasedInTime(t)))),
    dres != OK or TXNS.forall(t => not(heldThrough(t))),
    not(dres == RUNNING and now > D0),
  }
  /** 同じ刻みの競りがない (最初のロックを DDL を始めた刻みに求めた取引も、COMMIT を期限の刻みに送った取引もない)。 */
  def noTies: bool = TXNS.forall(t => tW.get(t) != d0 and tC.get(t) != D0)
  // 競りのない予定では、終わった DDL の結果は、利用者の時刻だけの関数である。行の置き場所も、取引の形も、使わない。
  val placementFree = d0 < 0 or dres == RUNNING or not(noTies) or ((dres == BUSY) == TXNS.exists(t => heldThrough(t)))
  val holderSurvives = not(refusedHolder)
  val writersSurvive = TXNS.forall(t => pc.get(t) != 4 or style.get(t) == READER)
  // DDL より後の刻みに最初の書き込みを求めた READER は、DDL の後ろで待ち、DDL が確定していれば断られ、失敗していれば通る。
  // DDL より前の刻みに求めた READER は、ロックを持つ取引で、断られない (holderSurvives)。
  val readerOutcome = TXNS.forall(t => or {
    style.get(t) != READER, pc.get(t) == 0,
    if (d0 >= 0 and tW.get(t) > d0) (pc.get(t) == 4) == (dres == OK) else (tW.get(t) == d0 or pc.get(t) != 4),
  })
  val holderNotDelayed = not(delayed)
  val waitsOnlyForDdl = not(stuck)
  val preparedStays = not(preparedWound)
  val noReblock = not(reblocked)
  val checkSawRows = not(badCheck)
  val lockSafe = and {
    asSqlite, placementFree, holderSurvives, writersSurvive, readerOutcome, holderNotDelayed, waitsOnlyForDdl, preparedStays,
    noReblock, checkSawRows,
  }

  // ---- witness (時刻は競りのないものだけ) ----
  def onOneShard: bool = sh.get(2) == P and sh.get(3) == P and sh.get(4) == P
  /**
   * 取引 1 が DDL より前にロックを取り、期限より前に確定した。取引 2 は、DDL より後の、取引 1 の COMMIT までの刻みに、最初のロックを
   * 求めた (期限が 2 刻みなので、取引 1 の COMMIT と同じ刻みである。待たされている状態そのものは witnessLateBlocked* が示す)。
   */
  def duringWait: bool =
    strict(1) and tC.get(1) > d0 and tC.get(1) < D0 and tW.get(2) > d0 and tW.get(2) <= tC.get(1)
  /** 取引 2 の最初のロックの要求が、DDL より後の刻みに送られ、取引 1 がロックを持って DDL が待っている間、与えられずに待っている。 */
  def lateBlocked: bool =
    strict(1) and holder(1) and dres == RUNNING and tW.get(2) > d0 and pend.get(2) and pc.get(2) == 0 and not(canExec(2))
  // 待っているシャード (行は全部 P) で、取引 2 が待たされている
  val witnessLateBlockedPending = not(onOneShard and lateBlocked and pendingAt(P))
  // prepare を適用したシャード (取引 2 の行は Q) で、取引 2 が待たされている
  val witnessLateBlockedFenced = not(sh.get(3) == Q and lateBlocked and fencedAt(Q))
  // BEGIN IMMEDIATE の取引 2 が、DDL が取引 1 を待っている間に来て、DDL の後ろで待ち、DDL が確定し、取引 2 も確定する。行は 1 つのシャード
  val witnessLateWaitsOne = not(onOneShard and style.get(2) == IMMEDIATE and duringWait and dres == OK and pc.get(1) == 3 and pc.get(2) == 3)
  // 同じ予定で、取引 2 の行が、もう prepare を適用したシャードにある
  val witnessLateWaitsTwo = not(sh.get(2) == P and sh.get(3) == Q and style.get(2) == IMMEDIATE and duringWait and dres == OK
                                and pc.get(1) == 3 and pc.get(2) == 3)
  // 取引 1 が別のシャードの禁止に当たって取り消させ、やり直しの間も取引 2 は待ち続け、DDL が確定し、取引 2 も確定する
  val witnessRestartKeepsWaiting = not(retried and sh.get(2) == Q and sh.get(3) == Q and duringWait and dres == OK
                                       and pc.get(1) == 3 and pc.get(2) == 3)
  // 取引 1 が期限を過ぎてロックを持ち、DDL は期限に SQLITE_BUSY で失敗する。待っていた取引 2 は、その後で通って確定する
  val witnessBusyThenLate = not(strict(1) and tC.get(1) > D0 and tW.get(2) > d0 and tW.get(2) < D0 and dres == BUSY and dEnd == D0
                                and pc.get(1) == 3 and pc.get(2) == 3)
  // 2 つの取引が、DDL より前に、別々のシャードにロックを取る。取引 1 の 2 つ目の文は、取引 2 を待っているシャードで、取り消させずに通る
  val witnessTwoHolders = not(strict(1) and strict(2) and sh.get(2) == Q and sh.get(3) == Q and not(retried) and tC.get(2) > tC.get(1)
                              and tC.get(2) < D0 and dres == OK and pc.get(1) == 3 and pc.get(2) == 3)
  // DDL の前に読んだ取引 2 (READER) が、DDL が待っている間に書こうとして待ち、DDL の確定の後で断られる
  val witnessReaderRefused = not(style.get(2) == READER and duringWait and dres == OK and pc.get(1) == 3 and pc.get(2) == 4)
  // 同じ取引 2 が、DDL が失敗した後で通って確定する
  val witnessReaderPasses = not(style.get(2) == READER and strict(1) and tC.get(1) > D0 and tW.get(2) > d0 and tW.get(2) < D0
                                and dres == BUSY and pc.get(2) == 3)

  // ---- 活性 -----------------------------------------------------------------
  // 内部の手と刻みに、弱い公平性を置く。利用者の手 (文を送る、DDL を始める) には置かない。
  val vars = (now, sh, style, meta, dres, dstart, cur, lag, acked, pc, pend, locks, rebased, d0, dEnd, tW, tC,
              refusedHolder, delayed, stuck, reblocked, badCheck, preparedWound, retried, woundAt, late)
  temporal fairness = and {
    weakFair(exec(1), vars), weakFair(exec(2), vars), weakFair(holdAtFence(1), vars), weakFair(holdAtFence(2), vars),
    weakFair(wound(1), vars), weakFair(wound(2), vars), weakFair(retry, vars),
    weakFair(commitDdl, vars), weakFair(expire, vars), weakFair(tick, vars),
    weakFair(see(P), vars), weakFair(see(Q), vars), weakFair(applyPrep(P), vars), weakFair(applyPrep(Q), vars),
    weakFair(applyEnd(P), vars), weakFair(applyEnd(Q), vars), weakFair(applyLag(P), vars), weakFair(applyLag(Q), vars),
    weakFair(ack(P), vars), weakFair(ack(Q), vars),
  }
  // 始めた DDL は終わり、時刻は上限まで進み、送られた文は答えを得る
  temporal lockLive = fairness implies and {
    always((d0 >= 0 and dres == RUNNING) implies eventually(dres != RUNNING)),
    eventually(now == MAXT),
    always(pend.get(1) implies eventually(not(pend.get(1)))),
    always(pend.get(2) implies eventually(not(pend.get(2)))),
  }
}

// 決めた設計。取引は 2 件とも、書き込みから始めるか、ロックを取る読みから始める。置き場所は 8 通り。
module m24c_green {
  import m24c_core(ANY_DEP = true, FENCE_COVERS = true, CLOSE_WINDOW = true, ONE_RESTART = true, HOLDS_ANYWHERE = true,
    SCENE = 0, STYLE1 = Set(0, 1), STYLE2 = Set(0, 1)).*
  // 行は全部 P。取引 1 が x の行を書き、DDL が始まり、P は取引 1 を待つ。BEGIN IMMEDIATE の取引 2 が、待っている間に来て、ロックを
  // 与えられずに待つ。取引 1 の次の書き込みと COMMIT は待たない。DDL が確定した後で、取引 2 は、新しい表定義で計画し直して通る。
  run lateWaitsTest =
    initWith(P, P, P, WRITER, IMMEDIATE).then(issue(1)).then(exec(1)).then(tick)
        .then(startDdl).then(see(P)).then(see(Q)).then(ack(Q))
        .expect(pendingAt(P) and not(urgent))
        .then(tick).then(issue(2))
        .expect(not(canExec(2)))
        .then(issue(1)).then(exec(1)).then(issue(1)).then(exec(1))
        .then(applyPrep(P)).then(ack(P)).then(commitDdl).then(applyEnd(P)).then(applyEnd(Q))
        .then(exec(2)).then(exec(2)).then(issue(2)).then(exec(2)).then(issue(2)).then(exec(2))
        .expect(lockSafe and dres == OK and dEnd == 2 and pc.get(1) == 3 and pc.get(2) == 3 and rebased.get(2))
  // 取引 1 の 2 つ目の行と、取引 2 の行は Q。Q は prepare を適用していて、取引 2 は禁止で待つ。取引 1 の書き込みが Q の禁止に当たり、
  // Q のロックを取って、試みを取り消させる。Meta は、同じ手で、やり直しの prepare を記録する。Q は、abort と新しい prepare を続けて
  // 適用し、取引 1 を待ち始める。その間のどの時点でも、取引 2 はロックを得ない。
  run restartTest =
    initWith(Q, Q, Q, WRITER, WRITER).then(issue(1)).then(exec(1)).then(tick)
        .then(startDdl).then(see(P)).then(see(Q)).then(ack(Q))
        .then(tick).then(issue(2))
        .expect(not(canExec(2)))
        .then(issue(1)).then(holdAtFence(1)).then(wound(1))
        .expect(meta == OPEN and retried and not(canExec(2)) and not(canExec(1)))
        .then(applyLag(Q))
        .expect(pendingAt(Q) and not(canExec(2)) and canExec(1))
        .then(exec(1)).then(issue(1)).then(exec(1))
        .then(applyPrep(P)).then(applyPrep(Q)).then(ack(P)).then(ack(Q)).then(commitDdl).then(applyEnd(P)).then(applyEnd(Q))
        .then(exec(2)).then(exec(2)).then(issue(2)).then(exec(2)).then(issue(2)).then(exec(2))
        .expect(lockSafe and dres == OK and dEnd == 2 and pc.get(1) == 3 and pc.get(2) == 3)
}
// 決めた設計で、取引 2 が、DDL より前に X をロックなしで読んでいる (計画し直せない)。
module m24c_green_reader {
  import m24c_core(ANY_DEP = true, FENCE_COVERS = true, CLOSE_WINDOW = true, ONE_RESTART = true, HOLDS_ANYWHERE = true,
    SCENE = 0, STYLE1 = Set(0), STYLE2 = Set(2)).*
}
// 決めた設計の活性を確かめる場面。取引 1 の 2 つ目の行と、取引 2 の行を Q に置く (取り消しとやり直しが起きる置き場所)。
module m24c_green_cross {
  import m24c_core(ANY_DEP = true, FENCE_COVERS = true, CLOSE_WINDOW = true, ONE_RESTART = true, HOLDS_ANYWHERE = true,
    SCENE = 3, STYLE1 = Set(0), STYLE2 = Set(0, 1)).*
}

// D1: ロックを与える判断が、書き込みとして頼る表にしか、fence を見ない。全シャードが prepare を適用した後に始めた BEGIN IMMEDIATE の
// 取引の読みが、ロックを得る。続く書き込みは、ロックを持つ取引として禁止に当たり、DDL を取り消させる。
module m24c_red_reads {
  import m24c_core(ANY_DEP = false, FENCE_COVERS = true, CLOSE_WINDOW = true, ONE_RESTART = true, HOLDS_ANYWHERE = true,
    SCENE = 0, STYLE1 = Set(0), STYLE2 = Set(1)).*
  // 取引 1 が P の行を書き、DDL が始まる。Q は prepare を適用して ok と答える。次の刻みに、BEGIN IMMEDIATE の取引 2 が、Q の行を読んで
  // ロックを得る。続く書き込みは、ロックを持つ取引として Q の禁止に当たり、試みを取り消させる。取引 1 は期限のうちに確定するが、
  // やり直しは取引 2 を待ち、DDL は期限に失敗する。
  run readLockTest =
    initWith(P, Q, Q, WRITER, IMMEDIATE).then(issue(1)).then(exec(1)).then(tick)
        .then(startDdl).then(see(P)).then(see(Q)).then(ack(Q))
        .then(tick).then(issue(2)).then(exec(2))
        .expect(locks.get(2) == Set(Q) and fencedAt(Q))
        .then(issue(2)).then(wound(2)).then(applyLag(Q)).then(exec(2))
        .then(issue(1)).then(exec(1)).then(issue(1)).then(exec(1))
        .then(applyPrep(P)).then(ack(P)).then(tick).then(expire)
        .expect(dres == BUSY and tC.get(1) < D0 and not(asSqlite))
  // 取引 1 がいない。全シャードが prepare を適用して ok と答えた後に、取引 2 の読みがロックを得て、書き込みが試みを取り消させる。
  run preparedWoundTest =
    initWith(P, P, P, WRITER, IMMEDIATE).then(startDdl).then(see(P)).then(see(Q)).then(ack(P)).then(ack(Q))
        .then(issue(2)).then(exec(2)).then(issue(2)).then(wound(2))
        .expect(not(preparedStays))
}
// D2: DDL が書きの epoch を進める表が、fence にない (一意でない CREATE INDEX と DROP INDEX)。prepare は行ロックを待たず、DDL はすぐに
// 確定し、行を書いた取引の次の書き込みと COMMIT が、古い計画として断られる。
module m24c_red_fence {
  import m24c_core(ANY_DEP = true, FENCE_COVERS = false, CLOSE_WINDOW = true, ONE_RESTART = true, HOLDS_ANYWHERE = true,
    SCENE = 0, STYLE1 = Set(0), STYLE2 = Set(0)).*
  // 取引 1 が行を書いた後で、DDL が始まる。fence が空なので、P は待たずに prepare を適用し、DDL は確定する。取引 1 の次の書き込みが、
  // 古い計画として断られる。
  run noFenceTest =
    initWith(P, P, P, WRITER, WRITER).then(issue(1)).then(exec(1)).then(tick)
        .then(startDdl).then(see(P)).then(see(Q)).then(ack(P)).then(ack(Q)).then(commitDdl).then(applyEnd(P)).then(applyEnd(Q))
        .then(issue(1)).then(exec(1))
        .expect(not(holderSurvives) and pc.get(1) == 4)
}
// D3: シャードが、行ロックの持ち主を待っている間も、新しい取引にロックを与える。行は全部 1 つのシャードにある。待っている間に来た
// 取引がロックを持ち続けると、DDL は、DDL より前の取引が期限のうちに確定しても、失敗する。
module m24c_red_window {
  import m24c_core(ANY_DEP = true, FENCE_COVERS = true, CLOSE_WINDOW = false, ONE_RESTART = true, HOLDS_ANYWHERE = true,
    SCENE = 1, STYLE1 = Set(0), STYLE2 = Set(0, 2)).*
  // 行は全部 P。P が取引 1 を待っている間に、取引 2 が書いてロックを得る。取引 1 は期限のうちに確定するが、P は取引 2 を待ち続け、
  // DDL は期限に失敗する。
  run windowTest =
    initWith(P, P, P, WRITER, WRITER).then(issue(1)).then(exec(1)).then(tick)
        .then(startDdl).then(see(P)).then(see(Q)).then(ack(Q))
        .then(tick).then(issue(2)).then(exec(2))
        .then(issue(1)).then(exec(1)).then(issue(1)).then(exec(1))
        .expect(not(canApplyPrep(P)) and not(urgent))
        .then(tick).then(expire)
        .expect(dres == BUSY and tC.get(1) < D0 and not(asSqlite) and not(placementFree))
}
// 同じ形 (待つ間も与える) で、取引 1 の行を P に、取引 2 の行を Q に置く。Q は、ロックがないのですぐに prepare を適用し、取引 2 は
// 禁止で待つ。SQLite と同じ結果になる。m24c_red_window と合わせて、待つ間も与える形の成否が、行の置き場所で決まることを示す。
module m24c_window_apart {
  import m24c_core(ANY_DEP = true, FENCE_COVERS = true, CLOSE_WINDOW = false, ONE_RESTART = true, HOLDS_ANYWHERE = true,
    SCENE = 2, STYLE1 = Set(0), STYLE2 = Set(0, 2)).*
  // m24c_red_window と同じ利用者の時刻で、取引 2 の行を Q に置く。取引 2 は Q の禁止で待ち、DDL は取引 1 の確定の後で確定する。
  run apartTest =
    initWith(P, Q, Q, WRITER, WRITER).then(issue(1)).then(exec(1)).then(tick)
        .then(startDdl).then(see(P)).then(see(Q)).then(ack(Q))
        .then(tick).then(issue(2))
        .expect(not(canExec(2)))
        .then(issue(1)).then(exec(1)).then(issue(1)).then(exec(1))
        .then(applyPrep(P)).then(ack(P)).then(commitDdl).then(applyEnd(P)).then(applyEnd(Q)).then(exec(2)).then(exec(2))
        .expect(lockSafe and dres == OK and dEnd == 2)
}
// やり直しを、進める側が、取り消しを知ってから記録する (m24_retry の形)。取り消しを適用したシャードは、やり直しの prepare を見るまで、
// 禁止も待ちもない。DDL の後ろで待っていた取引が、その間にロックを得て、持ち続けると、DDL は失敗する。
module m24c_red_gap {
  import m24c_core(ANY_DEP = true, FENCE_COVERS = true, CLOSE_WINDOW = true, ONE_RESTART = false, HOLDS_ANYWHERE = true,
    SCENE = 0, STYLE1 = Set(0), STYLE2 = Set(0)).*
  // m24c_green の restartTest と同じ始まり。取引 1 が Q の禁止に当たって取り消させた後、Q は abort を適用し、やり直しの prepare は
  // まだ記録されていない。Q の禁止で待っていた取引 2 が、その間にロックを得る。取引 1 は期限のうちに確定するが、やり直しは取引 2 を
  // 待ち、DDL は期限に失敗する。
  run gapTest =
    initWith(Q, Q, Q, WRITER, WRITER).then(issue(1)).then(exec(1)).then(tick)
        .then(startDdl).then(see(P)).then(see(Q)).then(ack(Q))
        .then(tick).then(issue(2))
        .expect(not(canExec(2)))
        .then(issue(1)).then(holdAtFence(1)).then(wound(1)).then(applyEnd(Q))
        .expect(meta == ABORTED and canExec(2))
        .then(exec(2)).then(retry).then(see(P)).then(see(Q))
        .then(exec(1)).then(issue(1)).then(exec(1)).then(applyPrep(P)).then(ack(P))
        .expect(not(canApplyPrep(Q)) and not(urgent))
        .then(tick).then(expire)
        .expect(dres == BUSY and tC.get(1) < D0 and not(asSqlite))
}
// 同じ形 (進める側が後からやり直す) で、行を全部 1 つのシャードに置く。取り消させる手が起きないので、SQLite と同じ結果になる。
module m24c_gap_one_shard {
  import m24c_core(ANY_DEP = true, FENCE_COVERS = true, CLOSE_WINDOW = true, ONE_RESTART = false, HOLDS_ANYWHERE = true,
    SCENE = 1, STYLE1 = Set(0), STYLE2 = Set(0)).*
  // 同じ利用者の時刻で、行を全部 P に置く。取り消させる手は起きず、取引 2 は P で待ち続け、DDL は取引 1 の確定の後で確定する。
  run oneShardTest =
    initWith(P, P, P, WRITER, WRITER).then(issue(1)).then(exec(1)).then(tick)
        .then(startDdl).then(see(P)).then(see(Q)).then(ack(Q))
        .then(tick).then(issue(2))
        .expect(not(canExec(2)))
        .then(issue(1)).then(exec(1)).then(issue(1)).then(exec(1))
        .then(applyPrep(P)).then(ack(P)).then(commitDdl).then(applyEnd(P)).then(applyEnd(Q)).then(exec(2)).then(exec(2))
        .expect(lockSafe and dres == OK and dEnd == 2)
}
// 待っているシャードが、そのシャードにロックを持つ取引にだけ、新しいロックを与える。P にロックを持つ取引の、Q (別の取引を待っている)
// への書き込みが、時刻をまたいで待たされる。
module m24c_red_holder_here {
  import m24c_core(ANY_DEP = true, FENCE_COVERS = true, CLOSE_WINDOW = true, ONE_RESTART = true, HOLDS_ANYWHERE = false,
    SCENE = 0, STYLE1 = Set(0), STYLE2 = Set(0)).*
  // 取引 1 は P に、取引 2 は Q に、DDL より前にロックを持つ。どちらのシャードも待つ。取引 1 の Q への書き込みは、Q にロックを
  // 持たないので与えられず、取引 2 が放すか、DDL の期限が来るまで待たされる。
  run holderHereTest =
    initWith(Q, Q, Q, WRITER, WRITER).then(issue(1)).then(exec(1)).then(issue(2)).then(exec(2)).then(tick)
        .then(startDdl).then(see(P)).then(see(Q)).then(issue(1))
        .expect(not(canExec(1)) and not(urgent))
        .then(tick)
        .expect(not(holderNotDelayed))
}
// 同じ形で、行を全部 1 つのシャードに置く。ロックを持つ取引は、そのシャードにロックを持つので、待たされない。
module m24c_holder_here_one_shard {
  import m24c_core(ANY_DEP = true, FENCE_COVERS = true, CLOSE_WINDOW = true, ONE_RESTART = true, HOLDS_ANYWHERE = false,
    SCENE = 1, STYLE1 = Set(0), STYLE2 = Set(0)).*
}
