// -*- mode: Bluespec; -*-
// M23e: 範囲の移動で、行ロックを新しい持ち主へ運ぶ。ロックの寿命は、M25 の取引の lease である (未解決の問題 37 の続き)
//
// 2026-11-17 に書いた。実装より先に書いたモデルである。設計は docs/design-refresh-across-move.md の「3 回目の実装の規則」にある。
// 2 回目の実装 (main に入れていない) にも同じ名前のモデルがあった。そちらは、置き場所 1 つで、ロックが効いている間は別の接続が
// 書かないことを確かめた。ここでは、M25 (m25_txn_lock_lease.qnt) の形に合わせて、範囲が動く置き場所と動かない置き場所を、同じ
// 利用者の手の並びで並べて動かし、結果が同じであること (規則 4) を確かめる。
//
// 問い。M25 は、行ロックの寿命を取引のものにした。取引のどの文も、取引の全部のロックの lease を延ばす。そのうえで、範囲の移動は
// ロックを運ばなければならないか。
// 答えは、運ばなければならない、である。lease が決めるのは、ロックがいつ切れるかで、ロックがどのシャードにあるかではない。行の
// 範囲が動いた後、新しい持ち主にロックがなければ、別の接続は待たずに書く。動かない置き場所では、同じ書き込みが待つ。
// 延長が届いたときに、新しい持ち主がロックを与え直す形は、代わりにならない。届くまでの間に別の接続が書けるからで、M25 の
// m25_red_regrant (延長はロックを作らない) と同じ欠陥になる。
//
// 規則 (M25 の lease の規則の上に足すもの)。
//   CARRY        pull が、渡す範囲の行の、生きているロックを運ぶ (取引、lease の版、期限)
//   KEEP_LEASE   運んだロックは、取引の lease をそのまま持つ。受け取った側は、新しい期限を作らない
//   FWD_RENEW    ロックを運んだ親は、その取引の延長を受けたら、運んだ先へ転送する。Worker は、行を書き直さないかぎり移動を知らず、
//                延長を親へ送るからである
//   FWD_UNLOCK   同じく、unlock を転送する
//   EARLY        受け取る側は、ロックより先に届いた転送 (延長か unlock) を覚え、届いたロックに当てる。pull の応答が飛んでいる間に、
//                親が延長や unlock を受けて転送することがある。M25 の「延長はロックを作らない」は変えない。覚えた延長は、届いた
//                ロックの期限を延ばすだけである
//   DURABLE      親は、ロックを運んだ先を、保存した記録に持つ (false: メモリにだけ持つ)。親が再起動した後の転送にだけ効く
// M25 の規則は、設計どおりに固定した (Worker が lease の版と終わりを持つ、シャードは新しい版でだけ延ばす、延長は生きている
// ロックだけを延ばす、COMMIT は lease を信じずに検証する)。外した形は M25 が確かめている。
//
// 時刻と場面は M25 と同じである。刻み (tick) で進み、TTL と W の待ちは 2 刻み、利用者は時刻 UMAX までに手を出す。RPC は 5 秒に
// 比べて十分に速いので、文、延長、unlock は手の中で届く。範囲の移動 (fence、pull、recv、ack) も 1 刻みの中で終わるが、4 手に分け、
// 間に利用者の手 (延長を送る文、ROLLBACK) と親の再起動が入る。行を書く文 (取引の最初の文、COMMIT、W) は、行が飛んでいる間は
// 届かないので、移動の後に実行したものとして扱う。
// 取引 t (悲観) は、行 x を書き、別のシャード Q の行 y で何度でも働き、COMMIT か ROLLBACK する (しなくてもよい)。別の接続の W は
// x を書き、x の持ち主に取引のロックがあれば、空くか、待ちの期限が過ぎるまで待つ。
// 置き場所は 2 つで、U では x は P にあり続け、M では x の範囲が P から C へ動く。故障は、P の再起動である。
//
// invariant (置き場所ごと。M25 と同じ)
//   serializable  x の値は、確定した書き込みの数と同じである
//   stmtKeeps     持ち主のロックが期限で切れるのは、取引が終わったか、最後の文から TTL 以上経ったときだけである (故障のない走りで)
//   idleLoses     ロックが生きているのは、取引の最後の文から L のうちだけである
//   lockProtects  持ち主に取引のロックがある間は、x は、取引が読んだ後に、ほかの接続に書かれていない
// invariant (置き場所をまたいで。故障のない走りで)
//   locksSame     x の持ち主に取引のロックが生きているかは、動く置き場所でも動かない置き場所でも同じである
//   outcomeSame   W の結果 (確定か SQLITE_BUSY、その時刻) と取引の結果は、どちらの置き場所でも同じである (規則 4。行が飛んでいる
//                 間を除く)
// DURABLE を比べるための性質 (m23eSafe には入れない)
//   endReleases   取引が終わった後は、どのシャードにも、その取引の生きているロックはない (親が再起動した走りでも)
module m23e_core {
  const CARRY: int              // 1: 運ぶ。0 赤: 運ばない。2 赤: 運ばず、延長が届いたら、新しい持ち主がロックを与え直す
  const KEEP_LEASE: bool
  const FWD_RENEW: bool
  const FWD_UNLOCK: bool
  const EARLY: bool
  const DURABLE: bool
  const RESTARTS: int
  const R: int

  pure val P = 1
  pure val C = 2
  pure val U = 0                // x が P にあり続ける置き場所
  pure val M = 1                // x の範囲が P から C へ動く置き場所
  pure val COPIES = Set(0, 1)
  pure val TTL = 2
  pure val LW = 2
  pure val UMAX = 4
  val L = TTL + R
  val MAXT = UMAX + L
  pure val W_NONE = 0
  pure val W_WAIT = 1
  pure val W_OK = 2
  pure val W_BUSY = 3
  pure val T_NONE = 0
  pure val T_OK = 1
  pure val T_CONFLICT = 2
  pure val T_ROLLBACK = 3
  // 受け取る側が覚えた、ロックより先に届いた転送
  pure val PD_NONE = 0
  pure val PD_RENEW = 1
  pure val PD_RELEASED = 2

  type Lock = { held: bool, seen: int, until: int }      // seen: 受けた lease の版
  type Pend = { kind: int, ep: int, until: int }
  /** 1 つの置き場所の状態。 */
  type Copy = {
    lockP: Lock, lockC: Lock,     // P と C にある、取引の x のロック
    until: int, ep: int,          // Worker: 取引の lease の終わりと版
    view: int,                    // Worker: x のロックを持つと思っているシャード (延長と unlock の宛先)
    phase: int,                   // 移動の進み。0 前、1 fence の後、2 pull の後 (飛んでいる)、3 C に届いた、4 ack の後
    payload: Lock,                // pull が運ぶロック
    pend: Pend,
    record: bool,                 // P が持つ、この取引のロックを C へ運んだ記録
    xv: int, tv: int, w: int, wAt: int, tRes: int,
    early: bool,                  // ghost: 開いている取引の、最後の文から TTL のうちに、持ち主のロックが期限で切れた
    fwd: bool,                    // ghost: 転送された延長が、運んだロックを延ばした
    earlyRenew: bool,             // ghost: ロックより先に届いた延長を、届いたロックに当てた
    earlyUnlock: bool,            // ghost: ロックより先に届いた unlock のために、届いたロックを入れなかった
  }

  var now: int
  var pc: int                     // 取引: 0 x を書く前、1 開いている、2 終わった
  var lastAct: int
  var tX: int
  var wIssue: int
  var restarts: int
  var cp: int -> Copy

  pure val noLock: Lock = { held: false, seen: -1, until: -1 }
  pure val noPend: Pend = { kind: PD_NONE, ep: -1, until: -1 }
  pure val copy0: Copy = {
    lockP: noLock, lockC: noLock, until: -1, ep: 0, view: P, phase: 0, payload: noLock, pend: noPend, record: false,
    xv: 0, tv: 0, w: W_NONE, wAt: -1, tRes: T_NONE, early: false, fwd: false, earlyRenew: false, earlyUnlock: false,
  }
  pure def live(l: Lock, t: int): bool = l.held and l.until > t
  /** x の持ち主にある、取引のロック。飛んでいる間は、親の写しである (親は fence の後、書き込みを受けない)。 */
  pure def ownerLock(c: Copy): Lock = if (c.phase >= 3) c.lockC else c.lockP
  /** 持ち主にロックがなくなったら、待っている W が書く。行が飛んでいる間は書けない。 */
  pure def wake(c: Copy, t: int): Copy =
    if (c.w == W_WAIT and c.phase != 1 and c.phase != 2 and not(live(ownerLock(c), t))) { ...c, xv: c.xv + 1, w: W_OK, wAt: t } else c
  /** M25 の規則: 延長は、生きているロックを、新しい版でだけ延ばす。 */
  pure def extend(l: Lock, e: int, u: int, t: int): Lock = if (live(l, t) and e > l.seen) { held: true, seen: e, until: u } else l

  // C が延長を受ける。CARRY = 2 (赤) なら、範囲を持っていてロックがなければ、与え直す
  def renewAtC(c: Copy, e: int, u: int, t: int): Lock =
    if (CARRY == 2 and c.phase >= 3 and not(live(c.lockC, t))) { held: true, seen: e, until: u } else extend(c.lockC, e, u, t)
  // Worker が、延長を view のシャードへ送る。P は、ロックを運んだ記録があれば、C へ転送する。C にまだロックが届いていなければ
  // (飛んでいる)、EARLY なら覚える
  def renewCopy(c: Copy, e: int, u: int, t: int): Copy =
    if (c.view == C) { ...c, lockC: renewAtC(c, e, u, t) }
    else {
      val c1 = { ...c, lockP: extend(c.lockP, e, u, t) }
      if (not(c.record and FWD_RENEW)) c1
      else if (c.phase == 2)
        (if (EARLY and c.pend.kind != PD_RELEASED and e > c.pend.ep) { ...c1, pend: { kind: PD_RENEW, ep: e, until: u } } else c1)
      else { ...c1, lockC: renewAtC(c1, e, u, t), fwd: c1.fwd or (live(c1.lockC, t) and e > c1.lockC.seen) }
    }
  // unlock も同じ道を通る
  def unlockCopy(c: Copy): Copy =
    if (c.view == C) { ...c, lockC: noLock }
    else {
      val c1 = { ...c, lockP: noLock }
      if (not(c.record and FWD_UNLOCK)) c1
      else if (c.phase == 2) (if (EARLY) { ...c1, pend: { kind: PD_RELEASED, ep: -1, until: -1 } } else c1)
      else { ...c1, lockC: noLock }
    }

  // 取引の最初の文。x を書いて、持ち主でロックを取る。lease は now + L、版は 1
  def stmtXCopy(c: Copy, t: int): Copy = {
    val lk = { held: true, seen: 1, until: t + L }
    if (c.phase >= 3) { ...c, until: t + L, ep: 1, view: C, lockC: lk, tv: c.xv }
    else { ...c, until: t + L, ep: 1, view: P, lockP: lk, tv: c.xv }
  }
  // y で働く文 (シャード Q)。lease の残りが TTL より短ければ延ばし、x のロックを持つシャードへ延長を送る (M25)
  def stmtYCopy(c: Copy, t: int): Copy =
    if (c.until - t < TTL) renewCopy({ ...c, until: t + L, ep: c.ep + 1 }, c.ep + 1, t + L, t) else c
  // COMMIT。x を検証する。確定すれば、x の持ち主で書き込みを適用し、ロックを放す。競合なら unlock を送る
  def commitCopy(c: Copy, t: int): Copy =
    if (c.xv == c.tv) wake({ ...c, xv: c.tv + 1, tRes: T_OK, lockP: noLock, lockC: noLock }, t)
    else wake(unlockCopy({ ...c, tRes: T_CONFLICT }), t)
  def rollbackCopy(c: Copy, t: int): Copy = wake(unlockCopy({ ...c, tRes: T_ROLLBACK }), t)
  pure def issueWCopy(c: Copy, t: int): Copy =
    if (live(ownerLock(c), t)) { ...c, w: W_WAIT } else { ...c, xv: c.xv + 1, w: W_OK, wAt: t }
  // 時刻が t になる。期限の来たロックが切れ、待っている W は、空けば書き、期限が来れば SQLITE_BUSY になる
  pure def tickCopy(c: Copy, t: int, wDeadline: int, active: bool): Copy = {
    val ol = ownerLock(c)
    val c1 = {
      ...c,
      lockP: if (c.lockP.held and c.lockP.until <= t) noLock else c.lockP,
      lockC: if (c.lockC.held and c.lockC.until <= t) noLock else c.lockC,
      early: c.early or (active and ol.held and ol.until <= t),
    }
    val c2 = wake(c1, t)
    if (c2.w == W_WAIT and t >= wDeadline) { ...c2, w: W_BUSY, wAt: t } else c2
  }

  action init = all {
    now' = 0, pc' = 0, lastAct' = -1, tX' = -1, wIssue' = -1, restarts' = 0,
    cp' = COPIES.mapBy(_ => copy0),
  }
  def userTurn: bool = now <= UMAX and lastAct < now
  // 動く置き場所で、行が飛んでいる
  def flying: bool = cp.get(M).phase == 1 or cp.get(M).phase == 2
  action keepUser = all { now' = now, pc' = pc, lastAct' = lastAct, tX' = tX, wIssue' = wIssue, restarts' = restarts }

  // ---- 利用者の手 (どちらの置き場所にも、同じ時刻に) ----
  action stmtX = all {
    pc == 0, userTurn, not(flying),
    pc' = 1, lastAct' = now, tX' = now,
    cp' = COPIES.mapBy(k => stmtXCopy(cp.get(k), now)),
    now' = now, wIssue' = wIssue, restarts' = restarts,
  }
  action stmtY = all {
    pc == 1, userTurn,
    lastAct' = now,
    cp' = COPIES.mapBy(k => stmtYCopy(cp.get(k), now)),
    now' = now, pc' = pc, tX' = tX, wIssue' = wIssue, restarts' = restarts,
  }
  action commit = all {
    pc == 1, userTurn, not(flying),
    pc' = 2, lastAct' = now,
    cp' = COPIES.mapBy(k => commitCopy(cp.get(k), now)),
    now' = now, tX' = tX, wIssue' = wIssue, restarts' = restarts,
  }
  action rollback = all {
    pc == 1, userTurn,
    pc' = 2, lastAct' = now,
    cp' = COPIES.mapBy(k => rollbackCopy(cp.get(k), now)),
    now' = now, tX' = tX, wIssue' = wIssue, restarts' = restarts,
  }
  action issueW = all {
    wIssue == -1, now <= UMAX, not(flying),
    wIssue' = now,
    cp' = COPIES.mapBy(k => issueWCopy(cp.get(k), now)),
    now' = now, pc' = pc, lastAct' = lastAct, tX' = tX, restarts' = restarts,
  }
  // 範囲の移動は、1 刻みの中で終わる
  action tick = all {
    now < MAXT, not(flying), cp.get(M).phase != 3,
    now' = now + 1,
    cp' = COPIES.mapBy(k => tickCopy(cp.get(k), now + 1, wIssue + LW, pc == 1 and now + 1 < lastAct + TTL)),
    pc' = pc, lastAct' = lastAct, tX' = tX, wIssue' = wIssue, restarts' = restarts,
  }

  // ---- 範囲の移動 (動く置き場所だけ) ----
  action fence = all {
    cp.get(M).phase == 0,
    cp' = cp.setBy(M, c => { ...c, phase: 1 }),
    keepUser,
  }
  // pull。CARRY なら、生きているロックを応答に載せ、運んだ先を記録する
  action pull = all {
    cp.get(M).phase == 1,
    val c = cp.get(M)
    val lv = live(c.lockP, now)
    cp' = cp.set(M, { ...c, phase: 2, payload: if (CARRY == 1 and lv) c.lockP else noLock, record: c.record or (CARRY != 0 and lv) }),
    keepUser,
  }
  // C が受け取る。先に届いた転送を覚えていれば当てる (放されていれば入れない。延長なら、版の新しいほう)。
  // 親の fence の前から待っていた W は、ここで、新しい持ち主のロックを見る
  action recv = all {
    cp.get(M).phase == 2,
    val c = cp.get(M)
    val released = c.pend.kind == PD_RELEASED
    val newer = c.pend.kind == PD_RENEW and c.pend.ep > c.payload.seen
    val got = if (newer) { held: true, seen: c.pend.ep, until: c.pend.until } else c.payload
    val lk = if (not(c.payload.held) or released) noLock
             else if (KEEP_LEASE) got
             else { held: true, seen: got.seen, until: now + L }
    cp' = cp.set(M, wake({ ...c, phase: 3, lockC: lk, pend: noPend,
                           earlyRenew: c.earlyRenew or (c.payload.held and newer and not(released)),
                           earlyUnlock: c.earlyUnlock or (c.payload.held and released) }, now)),
    keepUser,
  }
  // ack。親は、ロックの写しを消す
  action ack = all {
    cp.get(M).phase == 3,
    cp' = cp.setBy(M, c => { ...c, phase: 4, lockP: noLock }),
    keepUser,
  }

  // ---- 故障: P の再起動。メモリのロックと、保存していない記録が消える。待っていた W は、やり直して書く ----
  action restartP = all {
    restarts < RESTARTS, now <= UMAX,
    restarts' = restarts + 1,
    cp' = COPIES.mapBy(k => wake({ ...cp.get(k), lockP: noLock, record: DURABLE and cp.get(k).record }, now)),
    now' = now, pc' = pc, lastAct' = lastAct, tX' = tX, wIssue' = wIssue,
  }

  action step = any { stmtX, stmtY, commit, rollback, issueW, tick, fence, pull, recv, ack, restartP }

  // ---- 不変条件 ----
  def faulted: bool = restarts > 0
  pure def wrote(c: Copy): int = (if (c.w == W_OK) 1 else 0) + (if (c.tRes == T_OK) 1 else 0)
  val serializable = COPIES.forall(k => cp.get(k).xv == wrote(cp.get(k)))
  val stmtKeeps = faulted or COPIES.forall(k => not(cp.get(k).early))
  val idleLoses = COPIES.forall(k => (live(cp.get(k).lockP, now) or live(cp.get(k).lockC, now)) implies now < lastAct + L)
  val lockProtects = COPIES.forall(k => live(ownerLock(cp.get(k)), now) implies cp.get(k).xv == cp.get(k).tv)
  val locksSame = faulted or live(ownerLock(cp.get(U)), now) == live(ownerLock(cp.get(M)), now)
  pure def outcome(c: Copy): (int, int, int) = (c.w, c.wAt, c.tRes)
  // 行が飛んでいる間は比べない。その間、動く置き場所の W は書けず、届いたときに、同じ時刻で追いつく (移動は 1 刻みの中で終わる)
  val outcomeSame = faulted or flying or outcome(cp.get(U)) == outcome(cp.get(M))
  val m23eSafe = and { serializable, stmtKeeps, idleLoses, lockProtects, locksSame, outcomeSame }
  val endReleases = pc != 2 or COPIES.forall(k => not(live(cp.get(k).lockP, now)) and not(live(cp.get(k).lockC, now)))

  // ---- witness ----
  // 移動の後も y で働き続ける取引の、運んだロックが、転送された延長で延び、W はどちらの置き場所でも SQLITE_BUSY になり、取引が確定する
  val witnessCarriedBusy = not(not(faulted) and cp.get(M).phase == 4 and cp.get(M).fwd
                               and COPIES.forall(k => cp.get(k).w == W_BUSY and cp.get(k).tRes == T_OK))
  // pull の応答が飛んでいる間の延長を、届いたロックに当てる
  val witnessEarlyRenew = not(not(faulted) and cp.get(M).earlyRenew and cp.get(M).tRes == T_OK)
  // pull の応答が飛んでいる間に ROLLBACK した取引のロックを、C は入れず、W がどちらの置き場所でも書く
  val witnessEarlyUnlock = not(not(faulted) and cp.get(M).earlyUnlock and COPIES.forall(k => cp.get(k).w == W_OK))
  // 親の再起動の後に取引が終わり、運んだロックが残る (lease の期限で切れる)
  val witnessLeftover = not(faulted and pc == 2 and live(cp.get(M).lockC, now))

  // ---- 活性 ----
  val vars = (now, pc, lastAct, tX, wIssue, restarts, cp)
  temporal fairness = weakFair(tick, vars) and weakFair(pull, vars) and weakFair(recv, vars) and weakFair(ack, vars)
  def noLocks: bool = COPIES.forall(k => not(cp.get(k).lockP.held) and not(cp.get(k).lockC.held))
  // ロックはいつか全部切れたままになり、待つ W は終わり、時刻は上限まで進む (M25 の leaseLive)
  temporal leaseLive = fairness implies and {
    eventually(always(noLocks)),
    always(COPIES.exists(k => cp.get(k).w == W_WAIT) implies eventually(COPIES.forall(k => cp.get(k).w != W_WAIT))),
    eventually(now == MAXT),
  }
}

// ---- 規則 (緑) ----------------------------------------------------------------------------------------------------------

// 運ぶ。lease をそのまま持ち、延長と unlock を転送し、先に届いた転送を覚える。記録は保存する。P の再起動 1 回
module m23e_green {
  import m23e_core(CARRY = 1, KEEP_LEASE = true, FWD_RENEW = true, FWD_UNLOCK = true, EARLY = true, DURABLE = true, RESTARTS = 1, R = 1).*
  // 取引が x を書き、範囲が C へ動く。取引は y で働き続け、時刻 2 の文の延長が P から C へ転送される。W は時刻 2 に送られ、
  // どちらの置き場所でも時刻 4 に SQLITE_BUSY になり、取引は確定する
  run carriedBusyTest =
    init.then(stmtX).then(fence).then(pull).then(recv).then(ack)
        .expect(cp.get(M).lockC == { held: true, seen: 1, until: 3 } and cp.get(M).record)
        .then(tick).then(stmtY).then(tick).then(stmtY)
        .expect(cp.get(M).lockC.until == 5 and cp.get(U).lockP.until == 5)
        .then(issueW).then(tick).then(stmtY).then(tick)
        .expect(COPIES.forall(k => cp.get(k).w == W_BUSY and cp.get(k).wAt == 4))
        .then(commit)
        .expect(m23eSafe and endReleases and not(witnessCarriedBusy))
  // pull の応答が飛んでいる間の ROLLBACK。C は、先に届いた unlock を覚えて、届いたロックを入れない
  run earlyUnlockTest =
    init.then(stmtX).then(tick).then(fence).then(pull).then(rollback)
        .expect(cp.get(M).pend.kind == PD_RELEASED)
        .then(recv).then(ack).then(issueW)
        .expect(m23eSafe and endReleases and not(witnessEarlyUnlock))
}
// 同上、記録をメモリにだけ持つ。P が再起動すると転送は止まるが、M25 の性質は破れない
module m23e_memory_record {
  import m23e_core(CARRY = 1, KEEP_LEASE = true, FWD_RENEW = true, FWD_UNLOCK = true, EARLY = true, DURABLE = false, RESTARTS = 1, R = 1).*
  // P の再起動の後の ROLLBACK は、C のロックを外さない。残ったロックは、lease の期限 (時刻 3) で切れる
  run leftoverTest =
    init.then(stmtX).then(fence).then(pull).then(recv).then(ack)
        .then(restartP).then(tick).then(rollback)
        .expect(live(cp.get(M).lockC, now) and not(endReleases) and m23eSafe and not(witnessLeftover))
        .then(tick).then(tick)
        .expect(noLocks and m23eSafe)
}
// 活性 (故障なし)
module m23e_live {
  import m23e_core(CARRY = 1, KEEP_LEASE = true, FWD_RENEW = true, FWD_UNLOCK = true, EARLY = true, DURABLE = true, RESTARTS = 0, R = 1).*
}

// ---- 赤: 条件を 1 つずつ外す ----------------------------------------------------------------------------------------------

// 赤: 運ばない。lease は取引のものだが、新しい持ち主にロックがない。W は、動く置き場所でだけ、待たずに書く
module m23e_red_no_carry {
  import m23e_core(CARRY = 0, KEEP_LEASE = true, FWD_RENEW = true, FWD_UNLOCK = true, EARLY = true, DURABLE = true, RESTARTS = 0, R = 1).*
  run placementTest =
    init.then(stmtX).then(fence).then(pull).then(recv).then(ack).then(issueW)
        .expect(cp.get(U).w == W_WAIT and cp.get(M).w == W_OK and not(outcomeSame) and not(locksSame))
}
// 赤: 運ばず、延長が届いたら、新しい持ち主がロックを与え直す。届くまでの間に W が書き、取引は、読んだ後に書かれた行のロックを持つ
module m23e_red_regrant {
  import m23e_core(CARRY = 2, KEEP_LEASE = true, FWD_RENEW = true, FWD_UNLOCK = true, EARLY = true, DURABLE = true, RESTARTS = 0, R = 1).*
  run regrantTest =
    init.then(stmtX).then(fence).then(pull).then(recv).then(ack).then(issueW)
        .then(tick).then(tick).then(stmtY)                               // 時刻 2 の文が lease を延ばし、延長が C へ転送される
        .expect(live(cp.get(M).lockC, now) and cp.get(M).xv != cp.get(M).tv and not(lockProtects))
}
// 赤: 受け取った側が、運んだロックに新しい期限を与える。放っておかれた取引のロックが、L より長く残る
module m23e_red_fresh_lease {
  import m23e_core(CARRY = 1, KEEP_LEASE = false, FWD_RENEW = true, FWD_UNLOCK = true, EARLY = true, DURABLE = true, RESTARTS = 0, R = 1).*
  run outliveTest =
    init.then(stmtX).then(tick).then(tick).then(fence).then(pull).then(recv).then(ack).then(tick)
        .expect(live(cp.get(M).lockC, now) and not(live(cp.get(U).lockP, now)) and not(idleLoses) and not(locksSame))
}
// 赤: 親が延長を転送しない。運んだロックは、取引が y で働く間に切れる (動かない置き場所では切れない)
module m23e_red_no_forward_renew {
  import m23e_core(CARRY = 1, KEEP_LEASE = true, FWD_RENEW = false, FWD_UNLOCK = true, EARLY = true, DURABLE = true, RESTARTS = 0, R = 1).*
  run expireTest =
    init.then(stmtX).then(fence).then(pull).then(recv).then(ack)
        .then(tick).then(tick).then(stmtY).then(tick)
        .expect(not(live(cp.get(M).lockC, now)) and live(cp.get(U).lockP, now) and not(stmtKeeps) and not(locksSame))
}
// 赤: 親が unlock を転送しない。ROLLBACK の後も、運んだロックが残り、W は、動く置き場所でだけ待つ
module m23e_red_no_forward_unlock {
  import m23e_core(CARRY = 1, KEEP_LEASE = true, FWD_RENEW = true, FWD_UNLOCK = false, EARLY = true, DURABLE = true, RESTARTS = 0, R = 1).*
  run leakTest =
    init.then(stmtX).then(fence).then(pull).then(recv).then(ack).then(issueW).then(tick).then(rollback)
        .expect(cp.get(U).w == W_OK and cp.get(M).w == W_WAIT and not(outcomeSame))
}
// 赤: 受け取る側が、ロックより先に届いた転送を覚えない。飛んでいる間の ROLLBACK の後に、ロックが C に届く
module m23e_red_no_early {
  import m23e_core(CARRY = 1, KEEP_LEASE = true, FWD_RENEW = true, FWD_UNLOCK = true, EARLY = false, DURABLE = true, RESTARTS = 0, R = 1).*
  run raceTest =
    init.then(stmtX).then(tick).then(fence).then(pull).then(rollback).then(recv).then(ack).then(issueW)
        .expect(cp.get(U).w == W_OK and cp.get(M).w == W_WAIT and not(outcomeSame))
}
