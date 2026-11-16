// -*- mode: Bluespec; -*-
// M25: 行ロックの寿命を、シャードごとではなく取引ごとにする (取引の lease)。実装より先に書いたモデルである。
// 設計は docs/design-lock-lease.md にある。
//
// いまの実装の行ロックは、5 秒の TTL で切れ、TTL は、取引がそのシャードで文を実行したときだけ延びる (src/shard/kernel.ts の renew)。
// 取引がシャード A で働き続ける間に、シャード B のロックは切れる。行が 1 つのシャードにあれば切れない。ロックが切れた後に起きること
// (ほかの接続の書き込みや DDL が進む、取引の COMMIT が競合になる) が、行の置き場所で決まるので、規則 4 に反する
// (docs/design-catalog-epoch.md の「持ち主の判断が要ること」の 6)。
//
// 決めた設計は、条件 5 つの積である。
//   TXN_LEASE     取引のどの文も、取引の全部のロックを延ばす。Worker が、取引の lease (終わりの時刻 until と、版 ep) を持ち、
//                 文を送るときに、lease の残りが TTL より短ければ、until を now + L に、ep を 1 つ進めて延ばす。延ばすときは、文が
//                 触らない、ロックを持つシャードにも延長 (renew) を送る。文の要求も、lease (版と残り) を運ぶ。
//                 false は、いまの形 (文を受けたシャードだけが、自分のロックを now + TTL に延ばす)。
//   SHARED_LEASE  文を受けたシャードも、要求が運ぶ lease で延ばし、自分で now + L に延ばさない。どのシャードのロックも、同じ until
//                 で切れる。false は、文を受けたシャードが、受けるたびに now + L に延ばす形。
//   EPOCH_CHECK   シャードは、受けたことのある版 (以下) の lease では延ばさない。延長の要求は、ランタイムの再試行などで、遅れて、
//                 何度でも届き得る。false は、届くたびに、受けた時刻 + 残りに延ばす形。
//   EXTEND_ONLY   延長は、シャードに生きているロックの期限だけを延ばし、ロックを作らない (期限の過ぎたロック、放したロック、
//                 再起動で消えたロックを、取り戻さない)。false は、延長を、書いた行のロックを取り直す要求 (Txn.lockWritten の形)
//                 で済ませる形。
//   VALIDATE      COMMIT は、lease を信じずに、書いた行を検証する (今と同じ)。false は、lease が一度も切れていないと Worker が
//                 信じるなら、検証を省く形。
// L = TTL + R。R は lease の余裕で、R = 0 なら文ごとに延ばす。R > 0 なら、延ばすのは、前に延ばしてから R より後の文だけである
// (最初のロックから R のうちに終わる取引は、延長を送らない。それより長く働く取引は、R ごとに高々 1 回送る)。
// どちらでも、ロックは、最後の文から TTL の間は切れず、L の後には残らない。どのシャードのロックも、同じ until で切れるので、
// 切れる時刻は、取引の文の時刻だけで決まる。モデルの文は、どれもロックを取る書き込みで、要求が lease を運ぶ。
//
// 時刻: 刻み (tick) で進む。RPC は 5 秒に比べて十分に速い、という仮定で、文の実行、延長の配達、ロックの解放、待っている書き込みの
// やり直しは、手の中で済ませた (m24_retry の内部の手を、手の中にまとめた形)。そのため、利用者の手の並びが決まれば、置き場所ごとの
// 結果は 1 つに決まる。TTL、W の待ちの期限 LW は 2 刻み (5 秒) である。利用者は、時刻 UMAX までに手を出し、時刻は MAXT = UMAX + L
// まで進む。
//
// 場面: 取引 t (悲観。SQL の BEGIN か、Hrana の baton) が、行 x を書き、行 y で何度でも働き (書き込み)、COMMIT か ROLLBACK
// する (どちらもしない、つまり放っておいてもよい)。文は 1 刻みに 1 つまでである。ほかの接続の autocommit の書き込み W が x を書く。
// W は、x のロックがあれば、空くか、LW が過ぎるまで待つ (取引の行を奪わない)。W の待ちは、x の表の DDL の prepare が、x のロックを
// 待つ (m24 の WAIT_LOCKS) のと同じ形である。x と y の置き場所は、P と Q の 4 通りで、4 つの置き場所を、同じ利用者の手の並びで、
// 並べて動かす (cp)。故障は 3 つで、x のシャードの再起動 (メモリのロックが消える)、ROLLBACK か失敗した COMMIT の unlock が
// あるシャードに届かないこと (unlockAll は届かなくてもよい作り)、延長の再配達である。
//
// invariant (置き場所ごと):
//   serializable  x の値は、確定した書き込みの数と同じである (失われた更新がない)
//   stmtKeeps     ロックが期限で切れるのは、取引が終わったか、最後の文から TTL 以上経ったときだけである (開いている取引が
//                 TTL のうちに文を出し続ける間は、どのロックも切れない。再起動で消えるのは故障で、数えない)
//   idleLoses     ロックが生きているのは、取引の最後の文から L のうちだけである (終わった取引の、unlock の届かなかったロックも)
//   lockProtects  取引が x のロックを持つ間は、x は、取引が読んだ後に、ほかの接続に書かれていない
// invariant (置き場所をまたいで。故障 (再起動か、届かない unlock) のない走りで):
//   locksSame     取引のどの行のロックが生きているかは、どの置き場所でも同じである
//   outcomeSame   W の結果 (確定か SQLITE_BUSY、その時刻) と取引の結果は、どの置き場所でも同じである (規則 4)
module m25_core {
  const TXN_LEASE: bool
  const SHARED_LEASE: bool
  const EPOCH_CHECK: bool
  const EXTEND_ONLY: bool
  const VALIDATE: bool
  const R: int
  // ---- 場面 ----
  const ONE_SHARD: bool         // 行 x と y を同じシャードに置く置き場所だけにする

  pure val P = 1
  pure val Q = 2
  pure val SHARDS = Set(1, 2)
  pure val X = 1                // 行 x (取引が最初に書き、W も書く)
  pure val Y = 2                // 行 y (取引が続けて働く)
  pure val ROWS = Set(1, 2)
  pure val TTL = 2              // ロックの TTL (5 秒) を、刻みの数で
  pure val LW = 2               // W の行ロックの待ちの上限 (5 秒)
  pure val UMAX = 4             // 利用者が手を出せる最後の時刻
  val L = TTL + R               // lease の長さ
  val MAXT = UMAX + L
  val PLACES: Set[(int, int)] = if (ONE_SHARD) Set((1, 1), (2, 2)) else tuples(SHARDS, SHARDS)

  // W の状態
  pure val W_NONE = 0
  pure val W_WAIT = 1
  pure val W_OK = 2
  pure val W_BUSY = 3
  // 取引の結果
  pure val T_NONE = 0
  pure val T_OK = 1
  pure val T_CONFLICT = 2
  pure val T_ROLLBACK = 3

  /** 1 つの置き場所の状態。シャードの側、Worker の側、行の値、W、ghost。 */
  type Copy = {
    held: int -> bool,          // 行 -> 取引の生きているロックがある (期限は、行のシャードの lease)
    lease: int -> int,          // シャード -> 取引のロックの期限 (ロックがなければ -1)
    seen: int -> int,           // シャード -> 受けた lease の版 (ロックがなければ -1。シャードはロックと一緒に忘れる)
    sentEp: int -> int,         // シャード -> Worker が最後に送った延長の版 (-1 送っていない)。ランタイムが再配達し得る
    sentRem: int -> int,        // シャード -> その延長が運んだ残り
    until: int,                 // Worker: 取引の lease の終わり (-1 まだ)
    ep: int,                    // Worker: lease の版
    lapsed: bool,               // Worker: 文を送ったとき、lease が過ぎていたことがある
    bel: Set[int],              // Worker: ロックを取った行 (取引の終わりで空)
    early: bool,                // ghost: 開いている取引の、最後の文から TTL のうちに、ロックが期限で切れた
    xv: int,                   // 行 x の確定した値
    tv: int,                    // 取引が x を書いたときに読んだ値 (悲観の書き込みは最新を読む)
    w: int,
    wAt: int,                   // W が終わった時刻
    tRes: int,
    renewed: bool,              // ghost (witness): 文が触らないシャードへ、延長が届いた
  }

  pure val copy0: Copy = {
    held: ROWS.mapBy(_ => false), lease: SHARDS.mapBy(_ => -1), seen: SHARDS.mapBy(_ => -1),
    sentEp: SHARDS.mapBy(_ => -1), sentRem: SHARDS.mapBy(_ => 0),
    until: -1, ep: 0, lapsed: false, bel: Set(), early: false,
    xv: 0, tv: 0, w: W_NONE, wAt: -1, tRes: T_NONE, renewed: false,
  }

  // ---- 共通の状態 (利用者の手と時刻) ----
  var now: int
  var pc: int                   // 取引: 0 x を書く前、1 x を書いた (開いている)、2 終わった
  var lastAct: int              // 取引の最後の文 (COMMIT と ROLLBACK を含む) の時刻
  var tX: int                   // 取引が x を書いた時刻
  var tEnd: int                 // 取引が終わった時刻
  var wIssue: int               // W を送った時刻
  var restarted: bool           // ghost: x のシャードが再起動した
  var unlockLost: bool          // ghost: 取引の終わりの後に、届かなかった unlock のロックが残った
  // ---- 置き場所ごとの状態 ----
  var cp: (int, int) -> Copy    // (x のシャード, y のシャード) -> 状態

  pure def max(a: int, b: int): int = if (a > b) a else b
  pure def shardOf(p: (int, int), r: int): int = if (r == X) p._1 else p._2
  pure def rowsAt(p: (int, int), s: int): Set[int] = ROWS.filter(r => shardOf(p, r) == s)
  pure def heldAt(p: (int, int), h: int -> bool, s: int): bool = rowsAt(p, s).exists(r => h.get(r))

  /** ロックのないシャードの lease と版を忘れる (シャードは、取引のロックと一緒に、その lease を持つ)。 */
  pure def norm(p: (int, int), c: Copy): Copy = {
    ...c,
    lease: SHARDS.mapBy(s => if (heldAt(p, c.held, s)) c.lease.get(s) else -1),
    seen: SHARDS.mapBy(s => if (heldAt(p, c.held, s)) c.seen.get(s) else -1),
  }
  /** x のロックが消えたら、待っている W が書く。 */
  pure def wake(c: Copy, t: int): Copy =
    if (c.w == W_WAIT and not(c.held.get(X))) { ...c, xv: c.xv + 1, w: W_OK, wAt: t } else c

  // ---- 置き場所ごとの手 ----

  // 取引の文 (x か y の書き込み)。行のシャードがロックを与える。Worker は、lease の残りが TTL より短ければ延ばし、ロックを持つ
  // ほかのシャードへ延長を送る。文の要求も、lease (版と残り) を運ぶ。
  def stmtCopy(p: (int, int), c: Copy, r: int, t: int): Copy = {
    val s = shardOf(p, r)
    val renew = TXN_LEASE and c.until - t < TTL
    val until2 = if (renew) t + L else c.until
    val ep2 = if (renew) c.ep + 1 else c.ep
    val rem = until2 - t
    val bel2 = c.bel.union(Set(r))
    // EXTEND_ONLY でないとき、延長は、Worker が持つと信じる行のロックを取り直す (取り直す行のシャードも、延長を受ける)。
    val regrant = not(EXTEND_ONLY) and renew
    val held2 = ROWS.mapBy(b => c.held.get(b) or b == r or (regrant and bel2.contains(b)))
    // 延長を受ける、文が触らないシャード: Worker がロックを持つと信じるシャード。シャードは、生きているロックがあるときだけ延ばす。
    val targets = SHARDS.filter(o => o != s and renew and rowsAt(p, o).exists(b => bel2.contains(b)))
    val applied = targets.filter(o => heldAt(p, held2, o))
    val leaseS =
      if (not(TXN_LEASE)) t + TTL
      else if (not(SHARED_LEASE)) t + L
      else if (ep2 > c.seen.get(s)) t + rem
      else c.lease.get(s)
    val seenS = if (not(TXN_LEASE)) -1 else max(c.seen.get(s), ep2)
    norm(p, {
      ...c,
      held: held2,
      lease: SHARDS.mapBy(o => if (o == s) leaseS else if (applied.contains(o)) t + rem else c.lease.get(o)),
      seen: SHARDS.mapBy(o => if (o == s) seenS else if (applied.contains(o)) ep2 else c.seen.get(o)),
      sentEp: SHARDS.mapBy(o => if (targets.contains(o)) ep2 else c.sentEp.get(o)),
      sentRem: SHARDS.mapBy(o => if (targets.contains(o)) rem else c.sentRem.get(o)),
      until: until2, ep: ep2,
      lapsed: c.lapsed or (c.until >= 0 and t >= c.until),
      bel: bel2,
      tv: if (r == X) c.xv else c.tv,
      renewed: c.renewed or applied != Set(),
    })
  }

  // 取引の終わりでロックを放す。lostS のシャードには unlock が届かず、そこのロックは、lease の期限まで残る。
  pure def release(p: (int, int), c: Copy, lostS: Set[int]): Copy =
    norm(p, { ...c, held: ROWS.mapBy(b => c.held.get(b) and lostS.contains(shardOf(p, b))), bel: Set() })

  // COMMIT。x を、取引が読んだ時刻から検証する (ほかの接続の確定があれば競合)。VALIDATE でないとき、lease が一度も切れていないと
  // Worker が信じるなら、検証を省く。確定すれば、全部のロックが放される。競合なら unlock を送る (lostS には届かない)。
  def commitCopy(p: (int, int), c: Copy, lostS: Set[int], t: int): Copy = {
    val trusted = not(VALIDATE) and not(c.lapsed) and t < c.until
    if (trusted or c.xv == c.tv) wake(release(p, { ...c, xv: c.tv + 1, tRes: T_OK }, Set()), t)
    else wake(release(p, { ...c, tRes: T_CONFLICT }, lostS), t)
  }
  pure def rollbackCopy(p: (int, int), c: Copy, lostS: Set[int], t: int): Copy =
    wake(release(p, { ...c, tRes: T_ROLLBACK }, lostS), t)

  // W を送る。x のロックがなければ書いて確定する。あれば待つ。
  pure def issueWCopy(c: Copy, t: int): Copy =
    if (c.held.get(X)) { ...c, w: W_WAIT } else { ...c, xv: c.xv + 1, w: W_OK, wAt: t }

  // x のシャードが再起動する。メモリのロックと lease が消える。待っていた W は、失敗を受けて自分でやり直し、書く。
  pure def restartCopy(p: (int, int), c: Copy, t: int): Copy = {
    val gone = rowsAt(p, p._1)
    wake(norm(p, { ...c, held: ROWS.mapBy(b => c.held.get(b) and not(gone.contains(b))) }), t)
  }

  // ランタイムが、シャード s への最後の延長を、もう一度届ける。EPOCH_CHECK では、受けたことのある版なので延ばさない。
  def redeliverCopy(p: (int, int), c: Copy, s: int, t: int): Copy =
    if (c.sentEp.get(s) < 0 or not(heldAt(p, c.held, s))) c
    else if (EPOCH_CHECK and c.sentEp.get(s) <= c.seen.get(s)) c
    else {
      ...c,
      lease: c.lease.set(s, max(c.lease.get(s), t + c.sentRem.get(s))),
      seen: c.seen.set(s, max(c.seen.get(s), c.sentEp.get(s))),
    }

  // 時刻が t になる。期限の来た lease のロックが切れ、待っている W は、x が空けば書き、期限が来れば SQLITE_BUSY になる。
  // active は、取引が開いていて、時刻 t が最後の文から TTL のうちであること (そのときに切れるロックを ghost に残す)。
  pure def tickCopy(p: (int, int), c: Copy, t: int, wDeadline: int, active: bool): Copy = {
    val h = ROWS.mapBy(b => c.held.get(b) and c.lease.get(shardOf(p, b)) > t)
    val c1 = norm(p, { ...c, held: h, early: c.early or (active and h != c.held) })
    val c2 = wake(c1, t)
    if (c2.w == W_WAIT and t >= wDeadline) { ...c2, w: W_BUSY, wAt: t } else c2
  }

  // ---- 手 ----
  action init = all {
    now' = 0, pc' = 0, lastAct' = -1, tX' = -1, tEnd' = -1, wIssue' = -1, restarted' = false, unlockLost' = false,
    cp' = PLACES.mapBy(_ => copy0),
  }
  action keepGhost = all { restarted' = restarted, unlockLost' = unlockLost }
  /** 利用者は、UMAX までに、1 刻みに 1 つまで、取引の文を出す。 */
  def userTurn: bool = now <= UMAX and lastAct < now

  action stmtX = all {
    pc == 0, userTurn,
    pc' = 1, lastAct' = now, tX' = now,
    cp' = PLACES.mapBy(p => stmtCopy(p, cp.get(p), X, now)),
    now' = now, tEnd' = tEnd, wIssue' = wIssue, keepGhost,
  }
  action stmtY = all {
    pc == 1, userTurn,
    lastAct' = now,
    cp' = PLACES.mapBy(p => stmtCopy(p, cp.get(p), Y, now)),
    now' = now, pc' = pc, tX' = tX, tEnd' = tEnd, wIssue' = wIssue, keepGhost,
  }
  action commitWith(lostS: Set[int]): bool = all {
    pc == 1, userTurn,
    val after = PLACES.mapBy(p => commitCopy(p, cp.get(p), lostS, now))
    all {
      cp' = after,
      unlockLost' = (unlockLost or PLACES.exists(p => ROWS.exists(r => after.get(p).held.get(r)))),
    },
    pc' = 2, lastAct' = now, tEnd' = now,
    now' = now, tX' = tX, wIssue' = wIssue, restarted' = restarted,
  }
  action rollbackWith(lostS: Set[int]): bool = all {
    pc == 1, userTurn,
    val after = PLACES.mapBy(p => rollbackCopy(p, cp.get(p), lostS, now))
    all {
      cp' = after,
      unlockLost' = (unlockLost or PLACES.exists(p => ROWS.exists(r => after.get(p).held.get(r)))),
    },
    pc' = 2, lastAct' = now, tEnd' = now,
    now' = now, tX' = tX, wIssue' = wIssue, restarted' = restarted,
  }
  action commit = { nondet lostS = SHARDS.powerset().oneOf() commitWith(lostS) }
  action rollback = { nondet lostS = SHARDS.powerset().oneOf() rollbackWith(lostS) }
  // ほかの接続の autocommit の書き込み W を送る (1 回)。
  action issueW = all {
    wIssue == -1, now <= UMAX,
    wIssue' = now,
    cp' = PLACES.mapBy(p => issueWCopy(cp.get(p), now)),
    now' = now, pc' = pc, lastAct' = lastAct, tX' = tX, tEnd' = tEnd, keepGhost,
  }
  // 故障: x のシャードが再起動する (1 回)。
  action restart = all {
    not(restarted), now <= UMAX,
    restarted' = true,
    cp' = PLACES.mapBy(p => restartCopy(p, cp.get(p), now)),
    now' = now, pc' = pc, lastAct' = lastAct, tX' = tX, tEnd' = tEnd, wIssue' = wIssue, unlockLost' = unlockLost,
  }
  // 故障: シャード s への最後の延長が、もう一度届く (何度でも、いつでも)。
  action redeliver(s: int): bool = all {
    cp' = PLACES.mapBy(p => redeliverCopy(p, cp.get(p), s, now)),
    now' = now, pc' = pc, lastAct' = lastAct, tX' = tX, tEnd' = tEnd, wIssue' = wIssue, keepGhost,
  }
  action tick = all {
    now < MAXT,
    now' = now + 1,
    cp' = PLACES.mapBy(p => tickCopy(p, cp.get(p), now + 1, wIssue + LW, pc == 1 and now + 1 < lastAct + TTL)),
    pc' = pc, lastAct' = lastAct, tX' = tX, tEnd' = tEnd, wIssue' = wIssue, keepGhost,
  }

  action step = any {
    stmtX, stmtY, commit, rollback, issueW, restart, tick,
    { nondet s = oneOf(SHARDS) redeliver(s) },
  }

  // ---- 不変条件 -------------------------------------------------------------
  def faulted: bool = restarted or unlockLost
  def wrote(c: Copy): int = (if (c.w == W_OK) 1 else 0) + (if (c.tRes == T_OK) 1 else 0)
  val serializable = PLACES.forall(p => cp.get(p).xv == wrote(cp.get(p)))
  val stmtKeeps = PLACES.forall(p => not(cp.get(p).early))
  val idleLoses = PLACES.forall(p => ROWS.forall(r => cp.get(p).held.get(r) implies now < lastAct + L))
  val lockProtects = PLACES.forall(p => cp.get(p).held.get(X) implies cp.get(p).xv == cp.get(p).tv)
  val locksSame = faulted or PLACES.forall(p => PLACES.forall(q => cp.get(p).held == cp.get(q).held))
  def outcome(p: (int, int)): (int, int, int) = (cp.get(p).w, cp.get(p).wAt, cp.get(p).tRes)
  val outcomeSame = faulted or PLACES.forall(p => PLACES.forall(q => outcome(p) == outcome(q)))
  val leaseSafe = and { serializable, stmtKeeps, idleLoses, lockProtects, locksSame, outcomeSame }

  // ---- witness (故障のない走りの、行が 2 つのシャードにある置き場所 (P, Q)) ----
  def split: Copy = cp.get((1, 2))
  // 取引が y で働き続け、x を書いた文の後 TTL 以上経ってから W を送った。x のロックは生きていて、W は SQLITE_BUSY になり、
  // 取引は確定する
  val witnessBusyKeeps = not(not(faulted) and not(ONE_SHARD) and tX >= 0 and wIssue >= tX + TTL
                             and split.w == W_BUSY and split.tRes == T_OK)
  // 開いている取引を放っておくと、x のロックが切れて W が書き、取引の COMMIT が競合になる (どの置き場所でも)
  val witnessIdleLoses = not(not(faulted) and tX >= 0 and PLACES.forall(p =>
                               cp.get(p).w == W_OK and cp.get(p).wAt > tX and cp.get(p).tRes == T_CONFLICT))
  // 文が触らないシャードへ延長が届き、取引が確定する
  val witnessRenew = not(not(faulted) and not(ONE_SHARD) and split.renewed and split.tRes == T_OK)
  // 取引が終わったが、unlock が届かなかったロックが残り、W はそれを待ち、lease の期限の後で書く
  val witnessLeftover = not(not(restarted) and unlockLost and PLACES.exists(p =>
                              cp.get(p).tRes != T_OK and cp.get(p).w == W_OK and cp.get(p).wAt > tEnd))
  // 再起動で x のロックが消え、W が書く。lease は一度も切れていないが、COMMIT の検証が競合を見つける
  val witnessRestartCaught = not(restarted and PLACES.exists(p =>
                                   cp.get(p).w == W_OK and cp.get(p).tRes == T_CONFLICT and not(cp.get(p).lapsed)))

  // ---- 活性 -----------------------------------------------------------------
  // 刻みに弱い公平性を置く。利用者の手と故障には置かない (取引は、放っておかれてもよい)。
  val vars = (now, pc, lastAct, tX, tEnd, wIssue, restarted, unlockLost, cp)
  temporal fairness = weakFair(tick, vars)
  def noLocks: bool = PLACES.forall(p => ROWS.forall(r => not(cp.get(p).held.get(r))))
  // 放っておかれた取引と、終わった取引のロックは、いつか全部切れて、切れたままになる
  temporal locksReleased = fairness implies eventually(always(noLocks))
  // 待っている W は、いつか終わる
  temporal writerEnds = fairness implies always(PLACES.exists(p => cp.get(p).w == W_WAIT)
                                                  implies eventually(PLACES.forall(p => cp.get(p).w != W_WAIT)))
  temporal leaseLive = fairness implies and {
    eventually(always(noLocks)),
    always(PLACES.exists(p => cp.get(p).w == W_WAIT) implies eventually(PLACES.forall(p => cp.get(p).w != W_WAIT))),
    eventually(now == MAXT),
  }
}

// 決めた設計 (R = 1。L = 3 刻み、実際の値では TTL 5 秒、R 2.5 秒、L 7.5 秒)。
module m25_green {
  import m25_core(TXN_LEASE = true, SHARED_LEASE = true, EPOCH_CHECK = true, EXTEND_ONLY = true, VALIDATE = true, R = 1,
    ONE_SHARD = false).*
  // 取引が x を書き、y で働き続ける。時刻 2 の文で lease を延ばし、(P, Q) では x のシャード P へ延長が届く。W は時刻 2 に送られ、
  // どの置き場所でも、時刻 4 に SQLITE_BUSY になる。取引は確定する。
  run busyTest =
    init.then(stmtX).then(tick).then(stmtY).then(tick).then(stmtY).then(issueW).then(tick).then(stmtY).then(tick)
        .expect(PLACES.forall(p => cp.get(p).w == W_BUSY and cp.get(p).wAt == 4 and cp.get(p).held.get(X)) and split.renewed)
        .then(commitWith(Set()))
        .expect(leaseSafe and PLACES.forall(p => cp.get(p).tRes == T_OK and cp.get(p).xv == 1))
  // 取引が x を書いて放っておかれる。x のロックは時刻 3 に切れ、待っていた W が書き、取引の COMMIT は競合になる。
  run idleTest =
    init.then(stmtX).then(tick).then(issueW).then(tick).then(tick)
        .expect(PLACES.forall(p => cp.get(p).w == W_OK and cp.get(p).wAt == 3 and not(cp.get(p).held.get(X))))
        .then(commitWith(Set()))
        .expect(leaseSafe and PLACES.forall(p => cp.get(p).tRes == T_CONFLICT and cp.get(p).xv == 1))
  // ROLLBACK の unlock が P に届かない。P に残った x のロックは、lease の期限 (時刻 3) で切れ、W が書く。
  run leftoverTest =
    init.then(stmtX).then(tick).then(issueW).then(tick).then(rollbackWith(Set(1)))
        .expect(unlockLost and cp.get((1, 2)).held.get(X) and not(cp.get((2, 1)).held.get(X)))
        .then(tick)
        .expect(leaseSafe and cp.get((1, 2)).w == W_OK and cp.get((1, 2)).wAt == 3)
  // 延長の再配達は、受けたことのある版なので、延ばさない。
  run redeliverTest =
    init.then(stmtX).then(tick).then(stmtY).then(tick).then(stmtY).then(tick).then(rollbackWith(Set(1)))
        .then(tick).then(redeliver(1))
        .expect(cp.get((1, 2)).lease.get(1) == 5)
        .then(tick)
        .expect(leaseSafe and noLocks)
}
// 文ごとに延ばす形 (R = 0)。ロックは、最後の文からちょうど TTL で切れる。
module m25_green_exact {
  import m25_core(TXN_LEASE = true, SHARED_LEASE = true, EPOCH_CHECK = true, EXTEND_ONLY = true, VALIDATE = true, R = 0,
    ONE_SHARD = false).*
  run exactTest =
    init.then(stmtX).then(tick).then(stmtY).expect(split.renewed and split.lease.get(1) == 3)
        .then(tick).then(issueW).then(tick)
        .expect(PLACES.forall(p => cp.get(p).w == W_OK and cp.get(p).wAt == 3))
        .then(commitWith(Set()))
        .expect(leaseSafe and PLACES.forall(p => cp.get(p).tRes == T_CONFLICT))
}
// 今の形 (シャードごとの TTL) でも、行が 1 つのシャードにあれば、どの文もロックを延ばす。下の赤と合わせて、今の形で
// ロックが切れるかどうかが、行の置き場所で決まることを示す。
module m25_per_shard_same {
  import m25_core(TXN_LEASE = false, SHARED_LEASE = true, EPOCH_CHECK = true, EXTEND_ONLY = true, VALIDATE = true, R = 1,
    ONE_SHARD = true).*
  run sameTest =
    init.then(stmtX).then(tick).then(stmtY).then(tick).then(issueW)
        .expect(leaseSafe and PLACES.forall(p => cp.get(p).w == W_WAIT))
}
// 今の形: 文を受けたシャードだけが、自分のロックを now + TTL に延ばす。(P, Q) では、y の文が x のロックを延ばさず、x のロックが
// 時刻 2 に切れて W が書く。(P, P) では、y の文が x のロックも延ばし、W は待つ。
module m25_red_per_shard {
  import m25_core(TXN_LEASE = false, SHARED_LEASE = true, EPOCH_CHECK = true, EXTEND_ONLY = true, VALIDATE = true, R = 1,
    ONE_SHARD = false).*
  run perShardTest =
    init.then(stmtX).then(tick).then(stmtY).then(tick).then(issueW)
        .expect(cp.get((1, 2)).w == W_OK and cp.get((1, 1)).w == W_WAIT and not(outcomeSame) and not(stmtKeeps))
}
// 文を受けたシャードが、受けるたびに now + L に延ばす (ほかのシャードは、Worker の延長だけで延びる)。時刻 1 の y の文は lease を
// 延ばさないので、(P, Q) の P のロックは時刻 3 に、(P, P) では 4 に切れる。
module m25_red_local_lease {
  import m25_core(TXN_LEASE = true, SHARED_LEASE = false, EPOCH_CHECK = true, EXTEND_ONLY = true, VALIDATE = true, R = 1,
    ONE_SHARD = false).*
  run localTest =
    init.then(stmtX).then(tick).then(stmtY).then(tick).then(issueW).then(tick)
        .expect(cp.get((1, 2)).w == W_OK and cp.get((1, 1)).w == W_WAIT and not(outcomeSame))
}
// シャードが、延長を受けるたびに、受けた時刻 + 残りに延ばす (版を見ない)。ROLLBACK の unlock が P に届かず残ったロックが、
// 延長の再配達で延び続ける (取り消した取引のロックが、いつまでも残る)。
module m25_red_no_epoch {
  import m25_core(TXN_LEASE = true, SHARED_LEASE = true, EPOCH_CHECK = false, EXTEND_ONLY = true, VALIDATE = true, R = 1,
    ONE_SHARD = false).*
  run noEpochTest =
    init.then(stmtX).then(tick).then(stmtY).then(tick).then(stmtY).then(tick).then(rollbackWith(Set(1)))
        .then(tick).then(redeliver(1)).then(tick).then(redeliver(1)).then(tick)
        .expect(cp.get((1, 2)).held.get(X) and not(idleLoses))
}
// 延長を、書いた行のロックを取り直す要求で済ませる。放っておかれて切れた x のロックの後で W が書き、取引の次の文の延長が、
// x のロックを取り直す。取引は、読んだ後に書かれた x のロックを持つ。
module m25_red_regrant {
  import m25_core(TXN_LEASE = true, SHARED_LEASE = true, EPOCH_CHECK = true, EXTEND_ONLY = false, VALIDATE = true, R = 1,
    ONE_SHARD = false).*
  run regrantTest =
    init.then(stmtX).then(tick).then(issueW).then(tick).then(tick).then(stmtY)
        .expect(cp.get((1, 2)).held.get(X) and not(lockProtects))
}
// COMMIT が lease を信じて検証を省く。再起動で x のロックが消え、W が書いた後で、取引が x を上書きして確定する (失われた更新)。
module m25_red_trust_lease {
  import m25_core(TXN_LEASE = true, SHARED_LEASE = true, EPOCH_CHECK = true, EXTEND_ONLY = true, VALIDATE = false, R = 1,
    ONE_SHARD = false).*
  run trustTest =
    init.then(stmtX).then(restart).then(tick).then(issueW).then(commitWith(Set()))
        .expect(not(serializable))
}
