// M9: 新プロトコルの統合モデル (実装 packages/cf-d-infinity/src/shard/core.ts、client/db.ts に揃えた版)
//
//   楽観の取引 (BEGIN): SELECT は T の snapshot (read-time refresh つき)、書きは buffer して commit 時に検証。
//   悲観の取引 (最初の DML 以降、または BEGIN IMMEDIATE):
//     DML は settleIntents(F) の後、最新 F で dry-run し変更行の pk ロックを取る (lockedExec)。span の since = F。
//     BEGIN IMMEDIATE では主キーの SELECT もロックを取って F で読む (lockRows)。
//     待ちは wound-wait: 古い要求者は遅延の後に保持者のロックを消す (フラグ無し。保持者は検証で気づく)。
//     若い要求者は待つ。prepare 済み (intent) は奪えないので待つ。prepare 自身は待たず abort。
//     commit の検証はロックを信用しない: 書きは since (最初の F) から changedSince、span も since から。
//     読みだけの取引でも since を持つ span があれば commit で検証する (読み取り専用の参加者)。
//     同じ行への 2 回目の DML は since = min(最初の F, 今回の F)。
//     autocommit の書き込みは開始時刻を持つ悲観取引 (DML 1 文) として同じ待ち行列に入る。
//   ロックはメモリだけ: TTL 切れ、再起動で消える。待ち行列もメモリ。
//   起こし方: ロック解放で先頭 1 件 (最も古い) を起こす。intent の決着では全員。TTL 切れは遅延検出 (impl) か timer (fix)。
//   述語 span (案 A): 「shard p で g = true の行」。窓の commit の before/after と他の intent で判定。
//
// invariants: serializable (読み取り専用も含む全 committed 取引の全 read が c 順の直前状態と一致)、atomicVisibility、
//   writeSerial、noDeadlock (傷つけられる相手への待ちを除く待ちグラフに閉路なし)、atomicWrites、noLostWakeup。
module m9_core {
  const RED_SKIP_LOST: bool       // trustLocks: ロックを持っていれば検証を飛ばす (消えていても)
  const RED_F_IS_T: bool          // DML の dry-run を T で行う
  const RED_WOUND_PREPARED: bool  // prepare 済みも奪い、そのシャードの intent を捨てる
  const RED_WAIT_DIE: bool        // wait-die
  const RED_NO_PRED: bool         // DML の述語 span を検証しない
  const RED_PREPARE_WAITS: bool   // prepare が他ロックを待つ
  const RED_RO_SKIP: bool         // (a) since を持つ読み取り専用取引の commit 検証を飛ばす
  const RED_SECOND_F_NEW: bool    // (b) 同じ行の 2 回目の DML で since を新しい F にする
  const RED_IMM_READ_T: bool      // (c) IMMEDIATE の主キー読みを T の snapshot で読むのに since = F で検証する
  const EXPIRE_WAKES: bool        // TTL 切れで次の待ち手を起こす (impl は遅延検出で起こさない)
  const LEAVE_WAKES: bool         // 起こされた待ち手が取らずに去るとき次を起こす (impl は起こさない)
  const NTXN: int
  const CLOCK_MAX: int

  pure val SHARDS = Set(1, 2)
  pure val KEYS = Set(1, 2, 3, 4)
  pure val BASE = Set(1, 3)
  pure def shardOf(k: int): int = if (k <= 2) 1 else 2
  pure def keysOn(s: int): Set[int] = KEYS.filter(k => shardOf(k) == s)
  pure val TXNS = 1.to(NTXN)
  pure val NONE = 0
  pure val BIG = 1000

  // pess: 最初の DML からロック。imm: BEGIN IMMEDIATE (主キー SELECT もロック、F で読む)。
  // reads: SELECT で読むキー。dmlReads: DML が読むキー (書きもする)。pred / dmlPred: 述語読み shard (T / F)。
  // twice: writes の行へ DML を 2 回行う。
  type Tmpl = { pess: bool, imm: bool, reads: Set[int], dmlReads: Set[int], pred: int, dmlPred: int, writes: Set[int], gval: bool, twice: bool }
  pure val TEMPLATES: Set[Tmpl] = Set(
    { pess: true,  imm: false, reads: Set(),     dmlReads: Set(1), pred: 0, dmlPred: 0, writes: Set(1),    gval: true,  twice: false }, // A 悲観 RMW x
    { pess: true,  imm: false, reads: Set(),     dmlReads: Set(1), pred: 0, dmlPred: 0, writes: Set(1),    gval: true,  twice: true },  // A2 同じ行へ DML 2 回
    { pess: true,  imm: true,  reads: Set(1),    dmlReads: Set(),  pred: 0, dmlPred: 0, writes: Set(1),    gval: true,  twice: false }, // K IMMEDIATE: x をロック読みして書く
    { pess: true,  imm: true,  reads: Set(1, 3), dmlReads: Set(),  pred: 0, dmlPred: 0, writes: Set(),     gval: true,  twice: false }, // L IMMEDIATE 読みだけ (x, y をロック読み)
    { pess: true,  imm: false, reads: Set(),     dmlReads: Set(),  pred: 0, dmlPred: 0, writes: Set(1, 3), gval: true,  twice: false }, // B 悲観 2 シャード blind
    { pess: true,  imm: false, reads: Set(),     dmlReads: Set(),  pred: 1, dmlPred: 0, writes: Set(1),    gval: true,  twice: false }, // C 述語を T で読んで x を書く
    { pess: true,  imm: false, reads: Set(),     dmlReads: Set(),  pred: 0, dmlPred: 1, writes: Set(1),    gval: false, twice: false }, // D UPDATE ... WHERE g
    { pess: false, imm: false, reads: Set(1),    dmlReads: Set(),  pred: 0, dmlPred: 0, writes: Set(3),    gval: true,  twice: false }, // E 楽観 x 読み y 書き
    { pess: false, imm: false, reads: Set(),     dmlReads: Set(),  pred: 0, dmlPred: 0, writes: Set(2),    gval: true,  twice: false }, // H 楽観 insert xi
    { pess: false, imm: false, reads: Set(1, 3), dmlReads: Set(),  pred: 0, dmlPred: 0, writes: Set(),     gval: true,  twice: false }, // I 読み取り専用 (T の snapshot)
    { pess: true,  imm: false, reads: Set(),     dmlReads: Set(),  pred: 0, dmlPred: 0, writes: Set(1),    gval: false, twice: false }  // J autocommit blind x
  )

  type Status = Idle | Reading | Preparing | Refreshing | Committed | Aborted
  type Txn = {
    status: Status, tmpl: Tmpl, T: int,
    readVals: int -> int,          // 読んだキー -> writer (SELECT@T、ロック読み@F、DML 読み@F)
    since: int -> int,             // キー -> 検証の下限 (ロック読み / DML の F。最初の F)
    predSeen: Set[int], predDone: bool,
    dmlPredSeen: Set[int], dmlPredDone: bool, dmlPredF: int,
    done: Set[int],                // DML / ロック読みを済ませたキー
    second: bool,                  // 2 回目の DML を済ませた (twice)
    waitKey: int, waitOn: int, awake: bool, waited: bool,
    rTo: int, rRem: Set[int],
    anchor: int, pts: int -> int, c: int, pushed: int, toRefresh: Set[int], applied: Set[int], dropped: Set[int]
  }
  type Ver = { ver: int, writer: int, g: bool }
  type Intent = { txn: int, pts: int }

  var txns: int -> Txn
  var hlc: int -> int
  var hist: int -> Set[Ver]
  var intents: int -> Intent
  var locks: int -> int             // key -> 保持者 (メモリ)
  var waiters: int -> Set[int]      // key -> 待っている取引 (メモリ)
  var youngDied: bool

  pure def max(a: int, b: int): int = if (a > b) a else b
  pure def min(a: int, b: int): int = if (a < b) a else b
  pure def maxOf(s: Set[int], d: int): int = s.fold(d, (acc, x) => max(acc, x))
  pure val noVer: Ver = { ver: -1, writer: -1, g: false }
  def versionAt(k: int, t: int): Ver =
    hist.get(k).filter(e => e.ver <= t).fold(noVer, (acc, e) => if (e.ver > acc.ver) e else acc)
  def latestVer(k: int): int = hist.get(k).fold(-1, (acc, e) => max(acc, e.ver))
  def latest(k: int): Ver = versionAt(k, BIG)
  def predAt(p: int, t: int): Set[int] = keysOn(p).filter(k => val v = versionAt(k, t) v.ver >= 0 and v.g)

  pure def isRO(t: Txn): bool = t.tmpl.writes == Set()
  pure def lockKeys(t: Txn): Set[int] = t.tmpl.writes.union(if (t.tmpl.imm) t.tmpl.reads else Set())  // ロックを取るキー
  pure def writeShards(t: Txn): Set[int] = t.tmpl.writes.map(k => shardOf(k))
  pure def readShards(t: Txn): Set[int] =
    t.tmpl.reads.map(k => shardOf(k)).union(if (t.tmpl.pred == 0) Set() else Set(t.tmpl.pred))
      .union(if (t.tmpl.dmlPred == 0) Set() else Set(t.tmpl.dmlPred))
  pure def participants(t: Txn): Set[int] = writeShards(t).union(readShards(t))
  pure def prepared(t: Txn): bool = t.status == Preparing or t.status == Refreshing or t.status == Committed
  pure def selectsDone(t: Txn): bool =
    t.tmpl.reads.filter(k => not(t.tmpl.imm)).subseteq(t.readVals.keys()) and (t.tmpl.pred == 0 or t.predDone)
  pure def locksDone(t: Txn): bool =
    (not(t.tmpl.pess) or lockKeys(t).subseteq(t.done)) and (t.tmpl.dmlPred == 0 or t.dmlPredDone) and (not(t.tmpl.twice) or t.second)
  pure def readsDone(t: Txn): bool = selectsDone(t) and locksDone(t) and t.waitKey == 0
  // 検証が要る読み取り専用取引 = since を持つ span がある (ロック読み)
  pure def needsValidate(t: Txn): bool = not(isRO(t)) or (t.since.keys() != Set() and not(RED_RO_SKIP))
  pure def readSoFar(t: Txn): Set[int] =
    t.tmpl.reads.filter(k => not(t.tmpl.imm) and t.readVals.keys().contains(k)).map(k => shardOf(k))
      .union(if (t.predDone) Set(t.tmpl.pred) else Set())
  def older(a: int, b: int): bool =
    val ta = txns.get(a)
    val tb = txns.get(b)
    ta.T < tb.T or (ta.T == tb.T and a < b)

  def otherIntent(k: int, tid: int): bool = intents.get(k).txn != NONE and intents.get(k).txn != tid
  def otherLock(k: int, tid: int): bool = locks.get(k) != NONE and locks.get(k) != tid
  pure def lo(t: Txn, k: int): int = if (t.since.keys().contains(k)) t.since.get(k) else t.T
  // 未保護の点 span: SELECT@T で読んで書かないキー、ロック読みして書かないキー (since から)
  pure def pointSpans(t: Txn, p: int): Set[int] = t.tmpl.reads.filter(k => shardOf(k) == p and not(t.tmpl.writes.contains(k)))
  pure def hasUnprotected(t: Txn, p: int): bool = pointSpans(t, p) != Set() or t.tmpl.pred == p or t.tmpl.dmlPred == p
  def readConflict(tid: int, k: int, from: int, hi: int): bool =
    hist.get(k).exists(e => e.ver > from and e.ver <= hi and e.writer != tid) or otherIntent(k, tid)
  def predConflict(tid: int, p: int, from: int, hi: int): bool =
    keysOn(p).exists(k =>
      hist.get(k).exists(e => e.ver > from and e.ver <= hi and e.writer != tid and (e.g or versionAt(k, e.ver - 1).g))
      or otherIntent(k, tid))
  // 書きの検証 (validate): 他の intent / 他のロックなら abort。ロックは信用せず since から changedSince (RED_SKIP_LOST で飛ばす)
  def writeConflict(tid: int, t: Txn, p: int): bool =
    t.tmpl.writes.filter(k => shardOf(k) == p).exists(k =>
      otherIntent(k, tid) or otherLock(k, tid)
      or (if (RED_SKIP_LOST and t.tmpl.pess and t.since.keys().contains(k)) false else latestVer(k) > lo(t, k)))
  def spanConflict(tid: int, t: Txn, p: int, from: int, hi: int): bool =
    pointSpans(t, p).exists(k => readConflict(tid, k, max(from, lo(t, k)), hi))
    or (t.tmpl.pred == p and predConflict(tid, p, from, hi))
    or (not(RED_NO_PRED) and t.tmpl.dmlPred == p and t.dmlPredDone and predConflict(tid, p, max(from, t.dmlPredF), hi))
  // prepare 時の span 検証は各 span の since (無ければ T) から
  def prepareSpanConflict(tid: int, t: Txn, p: int): bool =
    pointSpans(t, p).exists(k => readConflict(tid, k, lo(t, k), BIG))
    or (t.tmpl.pred == p and predConflict(tid, p, t.T, BIG))
    or (not(RED_NO_PRED) and t.tmpl.dmlPred == p and t.dmlPredDone and predConflict(tid, p, t.dmlPredF, BIG))
  def prepareConflict(tid: int, t: Txn, p: int): bool = writeConflict(tid, t, p) or prepareSpanConflict(tid, t, p)
  def readSpansConflict(tid: int, t: Txn, q: int): bool =
    t.tmpl.reads.filter(k => not(t.tmpl.imm) and shardOf(k) == q and t.readVals.keys().contains(k)).exists(k => readConflict(tid, k, t.T, BIG))
    or (t.predDone and t.tmpl.pred == q and predConflict(tid, q, t.T, BIG))

  def intentsWithout(tid: int): int -> Intent =
    KEYS.mapBy(k => if (intents.get(k).txn == tid) { txn: NONE, pts: 0 } else intents.get(k))
  def placeIntents(tid: int, t: Txn, p: int, pts: int): int -> Intent =
    KEYS.mapBy(k => if (t.tmpl.writes.contains(k) and shardOf(k) == p) { txn: tid, pts: pts } else intents.get(k))

  // ---- ロックと待ち行列 ----------------------------------------------------------------------
  def holderOf(k: int): int = if (locks.get(k) != NONE) locks.get(k) else intents.get(k).txn
  // 最も古い待ち手
  def oldestWaiter(k: int): int =
    val ws = waiters.get(k)
    ws.fold(NONE, (acc, w) => if (acc == NONE or older(w, acc)) w else acc)
  // key k のロックを tid が手放す。先頭 1 件を起こす
  def wakeOne(m: int -> Txn, k: int): int -> Txn =
    val w = oldestWaiter(k)
    if (w == NONE) m else m.set(w, m.get(w).with("awake", true))
  def wakeAllOn(m: int -> Txn, k: int): int -> Txn =
    waiters.get(k).fold(m, (acc, w) => acc.set(w, acc.get(w).with("awake", true)))
  def releaseAll(m: int -> Txn, tid: int): int -> Txn =
    KEYS.filter(k => locks.get(k) == tid).fold(m, (acc, k) => wakeOne(acc, k))
  // abort で intent を消すとき、その行の待ち手を全員起こす (impl の abort() の wakeAll)
  def wakeIntentWaiters(m: int -> Txn, tid: int): int -> Txn =
    KEYS.filter(k => intents.get(k).txn == tid).fold(m, (acc, k) => wakeAllOn(acc, k))
  def abortRelease(m: int -> Txn, tid: int): int -> Txn = wakeIntentWaiters(releaseAll(m, tid), tid)
  def locksWithout(tid: int): int -> int = KEYS.mapBy(k => if (locks.get(k) == tid) NONE else locks.get(k))
  def locksWithoutOn(tid: int, p: int): int -> int =
    KEYS.mapBy(k => if (locks.get(k) == tid and shardOf(k) == p) NONE else locks.get(k))
  def waitersWithout(tid: int): int -> Set[int] = KEYS.mapBy(k => waiters.get(k).exclude(Set(tid)))

  // 読み手の intent の扱い
  def blockedBy(k: int, tid: int, t: int): bool =
    val it = intents.get(k)
    if (it.txn == NONE or it.txn == tid or it.pts > t) false
    else
      val u = txns.get(it.txn)
      u.status == Committed or (u.status == Refreshing and u.c <= t)
  def pushTargets(ks: Set[int], tid: int, t: int): Set[int] =
    ks.filter(k =>
      val it = intents.get(k)
      if (it.txn == NONE or it.txn == tid or it.pts > t) false else txns.get(it.txn).status == Preparing
    ).map(k => intents.get(k).txn)
  def withPushes(m: int -> Txn, targets: Set[int], t: int): int -> Txn =
    targets.fold(m, (acc, u) => acc.set(u, acc.get(u).with("pushed", max(acc.get(u).pushed, t))))
  def newerThanT(ks: Set[int], t: int): bool = ks.exists(k => latestVer(k) > t)

  pure val idleTxn: Txn = {
    status: Idle, tmpl: { pess: false, imm: false, reads: Set(), dmlReads: Set(), pred: 0, dmlPred: 0, writes: Set(), gval: true, twice: false },
    T: 0, readVals: Map(), since: Map(), predSeen: Set(), predDone: false, dmlPredSeen: Set(), dmlPredDone: false, dmlPredF: 0,
    done: Set(), second: false, waitKey: 0, waitOn: NONE, awake: false, waited: false, rTo: 0, rRem: Set(),
    anchor: NONE, pts: Map(), c: 0, pushed: 0, toRefresh: Set(), applied: Set(), dropped: Set()
  }
  action init = all {
    txns' = TXNS.mapBy(_ => idleTxn),
    hlc' = SHARDS.mapBy(_ => 0),
    hist' = KEYS.mapBy(k => if (BASE.contains(k)) Set({ ver: 0, writer: 0, g: true }) else Set()),
    intents' = KEYS.mapBy(_ => { txn: NONE, pts: 0 }),
    locks' = KEYS.mapBy(_ => NONE),
    waiters' = KEYS.mapBy(_ => Set()),
    youngDied' = false
  }
  action keepEnv = all { hlc' = hlc, hist' = hist, intents' = intents, locks' = locks, waiters' = waiters, youngDied' = youngDied }

  action begin(tid: int, tm: Tmpl, home: int): bool = all {
    txns.get(tid).status == Idle,
    val tsh = tm.reads.map(k => shardOf(k)).union(tm.writes.map(k => shardOf(k)))
                .union(if (tm.pred == 0) Set() else Set(tm.pred)).union(if (tm.dmlPred == 0) Set() else Set(tm.dmlPred))
    all {
      tsh.contains(home),
      val t0 = if (not(tm.imm) and tm.reads.map(k => shardOf(k)).size() >= 2) maxOf(SHARDS.map(s => hlc.get(s)), 0) else hlc.get(home)
      txns' = txns.set(tid, idleTxn.with("status", Reading).with("tmpl", tm).with("T", t0)),
      keepEnv
    }
  }

  // ---- SELECT@T (楽観、および素の BEGIN の悲観) ------------------------------------------------
  action readKey(tid: int, k: int): bool = all {
    val t = txns.get(tid)
    all {
      t.status == Reading, t.rTo == 0, t.waitKey == 0, not(t.tmpl.imm),
      t.tmpl.reads.contains(k), not(t.readVals.keys().contains(k)),
      not(blockedBy(k, tid, t.T)), not(newerThanT(Set(k), t.T)),
      val p = shardOf(k)
      all {
        hlc' = hlc.set(p, max(hlc.get(p), t.T)),
        txns' = withPushes(txns.set(tid, t.with("readVals", t.readVals.put(k, versionAt(k, t.T).writer))), pushTargets(Set(k), tid, t.T), t.T),
        hist' = hist, intents' = intents, locks' = locks, waiters' = waiters, youngDied' = youngDied
      }
    }
  }
  action readPred(tid: int): bool = all {
    val t = txns.get(tid)
    all {
      t.status == Reading, t.rTo == 0, t.waitKey == 0, t.tmpl.pred != 0, not(t.predDone),
      val p = t.tmpl.pred
      all {
        not(keysOn(p).exists(k => blockedBy(k, tid, t.T))), not(newerThanT(keysOn(p), t.T)),
        hlc' = hlc.set(p, max(hlc.get(p), t.T)),
        txns' = withPushes(txns.set(tid, t.with("predSeen", predAt(p, t.T)).with("predDone", true)), pushTargets(keysOn(p), tid, t.T), t.T),
        hist' = hist, intents' = intents, locks' = locks, waiters' = waiters, youngDied' = youngDied
      }
    }
  }
  action startReadRefresh(tid: int, p: int): bool = all {
    val t = txns.get(tid)
    all {
      t.status == Reading, t.rTo == 0, t.waitKey == 0, not(t.tmpl.imm),
      val ks = (if (t.tmpl.pred == p and not(t.predDone)) keysOn(p) else Set())
                 .union(t.tmpl.reads.filter(k => shardOf(k) == p and not(t.readVals.keys().contains(k))))
      all {
        ks != Set(), not(ks.exists(k => blockedBy(k, tid, t.T))), newerThanT(ks, t.T),
        val upTo = hlc.get(p)
        val rem = readSoFar(t)
        txns' = txns.set(tid, if (rem == Set()) t.with("T", upTo) else t.with("rTo", upTo).with("rRem", rem)),
        keepEnv
      }
    }
  }
  action readRefreshStep(tid: int, q: int): bool = all {
    val t = txns.get(tid)
    all {
      t.status == Reading, t.rTo != 0, t.rRem.contains(q),
      val ok = not(readSpansConflict(tid, t, q))
      val rem = t.rRem.exclude(Set(q))
      all {
        hlc' = hlc.set(q, max(hlc.get(q), t.rTo)),
        txns' = if (ok and rem != Set()) txns.set(tid, t.with("rRem", rem))
                else if (ok) txns.set(tid, t.with("T", t.rTo).with("rTo", 0).with("rRem", Set()))
                else releaseAll(txns.set(tid, t.with("status", Aborted)), tid),
        locks' = if (ok) locks else locksWithout(tid),
        waiters' = if (ok) waiters else waitersWithout(tid),
        hist' = hist, intents' = intents, youngDied' = youngDied
      }
    }
  }

  // ---- 悲観の DML / ロック読み (lockedExec) ---------------------------------------------------------
  // F で読むキー: 自分の行 (dmlReads / imm の reads)、述語の行
  pure def dmlReadKeys(t: Txn, k: int): Set[int] =
    (if (t.tmpl.dmlReads.contains(k) or (t.tmpl.imm and t.tmpl.reads.contains(k))) Set(k) else Set())
      .union(if (t.tmpl.dmlPred == shardOf(k) and not(t.dmlPredDone)) keysOn(shardOf(k)) else Set())
  // 取得後の dry-run。読みは F (RED_IMM_READ_T ならロック読みは T で読む)。since は最初の F (RED_SECOND_F_NEW なら今回)
  def dryRun(tid: int, t: Txn, k: int, f: int): Txn =
    val p = shardOf(k)
    val isSecond = t.done.contains(k)
    val readT = if (RED_IMM_READ_T and t.tmpl.imm and t.tmpl.reads.contains(k)) t.T else f
    val prevSince = if (t.since.keys().contains(k)) t.since.get(k) else f
    val newSince = if (RED_SECOND_F_NEW) f else min(prevSince, f)
    val base = t.with("done", t.done.union(Set(k))).with("since", t.since.put(k, newSince))
                .with("waitKey", 0).with("waitOn", NONE).with("awake", false).with("second", t.second or isSecond)
    // 2 回目は自分の overlay を読むだけなので readVals は変えない
    val withRead = if (not(isSecond) and dmlReadKeys(t, k).contains(k)) base.with("readVals", t.readVals.put(k, versionAt(k, readT).writer)) else base
    if (t.tmpl.dmlPred == p and not(t.dmlPredDone))
      withRead.with("dmlPredSeen", predAt(p, f)).with("dmlPredDone", true).with("dmlPredF", f)
    else withRead

  def wantsLock(t: Txn, k: int): bool =
    lockKeys(t).contains(k) and (not(t.done.contains(k)) or (t.tmpl.twice and not(t.second) and t.tmpl.writes.contains(k)))

  // ロック要求。空いていれば取る。保持者がいれば待ち行列に入る (wound は後で woundTake)
  action dmlRequest(tid: int, k: int): bool = all {
    val t = txns.get(tid)
    all {
      t.status == Reading, t.tmpl.pess, t.rTo == 0, t.waitKey == 0, wantsLock(t, k),
      selectsDone(t),
      val p = shardOf(k)
      val h = holderOf(k)
      val f = if (RED_F_IS_T) t.T else hlc.get(p)
      all {
        if (h == NONE or h == tid)
          all {
            not(dmlReadKeys(t, k).exists(rk => rk != k and blockedBy(rk, tid, f))),
            locks' = locks.set(k, tid),
            txns' = withPushes(txns.set(tid, dryRun(tid, t, k, f)), pushTargets(dmlReadKeys(t, k).exclude(Set(k)), tid, f), f),
            waiters' = waiters, youngDied' = youngDied
          }
        else if (RED_WAIT_DIE and not(older(tid, h)))
          all {
            txns' = releaseAll(txns.set(tid, t.with("status", Aborted)), tid),
            locks' = locksWithout(tid), waiters' = waiters, youngDied' = true
          }
        else
          all {
            txns' = txns.set(tid, t.with("waitKey", k).with("waitOn", h).with("awake", false).with("waited", true)),
            waiters' = waiters.set(k, waiters.get(k).union(Set(tid))),
            locks' = locks, youngDied' = youngDied
          },
        hlc' = hlc, hist' = hist, intents' = intents
      }
    }
  }
  // 起こされた待ち手が取る (空いているときだけ)
  action dmlAcquire(tid: int): bool = all {
    val t = txns.get(tid)
    all {
      t.status == Reading, t.waitKey != 0, t.awake,
      val k = t.waitKey
      val f = if (RED_F_IS_T) t.T else hlc.get(shardOf(k))
      all {
        holderOf(k) == NONE or holderOf(k) == tid,
        not(dmlReadKeys(t, k).exists(rk => rk != k and blockedBy(rk, tid, f))),
        locks' = locks.set(k, tid),
        waiters' = waiters.set(k, waiters.get(k).exclude(Set(tid))),
        txns' = withPushes(txns.set(tid, dryRun(tid, t, k, f)), pushTargets(dmlReadKeys(t, k).exclude(Set(k)), tid, f), f),
        hlc' = hlc, hist' = hist, intents' = intents, youngDied' = youngDied
      }
    }
  }
  // 起こされたが保持者が替わっていた: 待ち行列に戻る (眠る)
  action dmlRewait(tid: int): bool = all {
    val t = txns.get(tid)
    all {
      t.status == Reading, t.waitKey != 0, t.awake,
      val k = t.waitKey
      val h = holderOf(k)
      all {
        h != NONE, h != tid,
        txns' = txns.set(tid, t.with("awake", false).with("waitOn", h)),
        keepEnv
      }
    }
  }
  // wound (遅延の後): 古い待ち手が若い保持者のロックを消して取る。保持者はフラグを持たず検証で気づく。
  // prepare 済み (intent) は奪えない (RED_WOUND_PREPARED なら奪って intent を捨てさせる)
  action woundTake(tid: int): bool = all {
    val t = txns.get(tid)
    all {
      t.status == Reading, t.waitKey != 0,
      val k = t.waitKey
      val h = locks.get(k)
      val ih = intents.get(k).txn
      val target = if (h != NONE) h else ih
      val f = if (RED_F_IS_T) t.T else hlc.get(shardOf(k))
      all {
        target != NONE, target != tid, older(tid, target),
        not(prepared(txns.get(target))) or RED_WOUND_PREPARED,
        not(dmlReadKeys(t, k).exists(rk => rk != k and blockedBy(rk, tid, f))),
        locks' = locks.set(k, tid),
        intents' = if (RED_WOUND_PREPARED and ih == target) intents.set(k, { txn: NONE, pts: 0 }) else intents,
        txns' = txns.set(tid, dryRun(tid, t, k, f))
                    .set(target, if (RED_WOUND_PREPARED and prepared(txns.get(target)))
                                   txns.get(target).with("dropped", txns.get(target).dropped.union(Set(shardOf(k))))
                                 else txns.get(target)),
        waiters' = waiters.set(k, waiters.get(k).exclude(Set(tid))),
        hlc' = hlc, hist' = hist, youngDied' = youngDied
      }
    }
  }
  // 起こされた待ち手が取らずに去る (Worker が他の理由で abort)。LEAVE_WAKES なら次を起こす
  action waiterLeave(tid: int): bool = all {
    val t = txns.get(tid)
    all {
      t.status == Reading, t.waitKey != 0, t.awake,
      val k = t.waitKey
      val m1 = txns.set(tid, t.with("status", Aborted).with("waitKey", 0).with("waitOn", NONE).with("awake", false))
      val m2 = releaseAll(m1, tid)
      all {
        waiters' = waitersWithout(tid),
        txns' = if (LEAVE_WAKES and locks.get(k) == NONE) wakeOneExcept(m2, k, tid) else m2,
        locks' = locksWithout(tid),
        hlc' = hlc, hist' = hist, intents' = intents, youngDied' = youngDied
      }
    }
  }
  def wakeOneExcept(m: int -> Txn, k: int, ex: int): int -> Txn =
    val ws = waiters.get(k).exclude(Set(ex))
    val w = ws.fold(NONE, (acc, x) => if (acc == NONE or older(x, acc)) x else acc)
    if (w == NONE) m else m.set(w, m.get(w).with("awake", true))
  // TTL 切れ: 保持者は気づかない。impl は遅延検出 (起こさない)、fix は timer で次を起こす
  action lockExpire(k: int): bool = all {
    locks.get(k) != NONE,
    locks' = locks.set(k, NONE),
    txns' = if (EXPIRE_WAKES) wakeOne(txns, k) else txns,
    hlc' = hlc, hist' = hist, intents' = intents, waiters' = waiters, youngDied' = youngDied
  }
  // 再起動: そのシャードのロックと待ち行列が消える (待ち手は RPC エラーで abort)
  action restart(s: int): bool = all {
    keysOn(s).exists(k => locks.get(k) != NONE or waiters.get(k) != Set()),
    locks' = KEYS.mapBy(k => if (shardOf(k) == s) NONE else locks.get(k)),
    waiters' = KEYS.mapBy(k => if (shardOf(k) == s) Set() else waiters.get(k)),
    txns' = TXNS.fold(txns, (m, w) =>
      if (m.get(w).waitKey != 0 and shardOf(m.get(w).waitKey) == s)
        m.set(w, m.get(w).with("status", Aborted).with("waitKey", 0).with("waitOn", NONE).with("awake", false))
      else m),
    hlc' = hlc, hist' = hist, intents' = intents, youngDied' = youngDied
  }

  // 読み取りだけで since を持たない取引は検証なしで終わる
  action finishRO(tid: int): bool = all {
    val t = txns.get(tid)
    all {
      t.status == Reading, t.rTo == 0, readsDone(t), isRO(t), not(needsValidate(t)),
      txns' = releaseAll(txns.set(tid, t.with("status", Committed).with("c", t.T)), tid),
      locks' = locksWithout(tid),
      hlc' = hlc, hist' = hist, intents' = intents, waiters' = waiters, youngDied' = youngDied
    }
  }

  // ---- anchor 2PC (読み取り専用の参加者も prepare を通す) -------------------------------------------
  action sendCommit(tid: int, a: int): bool = all {
    val t = txns.get(tid)
    all {
      t.status == Reading, t.rTo == 0, readsDone(t), needsValidate(t), participants(t).contains(a),
      txns' = txns.set(tid, t.with("status", Preparing).with("anchor", a)),
      keepEnv
    }
  }
  def foreignLock(tid: int, t: Txn, p: int): int =
    t.tmpl.writes.filter(k => shardOf(k) == p and otherLock(k, tid)).fold(NONE, (acc, k) => locks.get(k))
  action prepareAt(tid: int, p: int, isAnchor: bool): bool = all {
    val t = txns.get(tid)
    val fl = foreignLock(tid, t, p)
    all {
      if (RED_PREPARE_WAITS and fl != NONE)
        all {
          txns' = txns.set(tid, t.with("waitKey", -p).with("waitOn", fl)),
          hlc' = hlc, intents' = intents, locks' = locks, waiters' = waiters, hist' = hist, youngDied' = youngDied
        }
      else
        val ok = not(prepareConflict(tid, t, p))
        val others = maxOf(t.pts.keys().map(q => t.pts.get(q)), 0)
        val newPts = if (isAnchor) max(hlc.get(p), max(others, t.pushed)) + 1 else hlc.get(p) + 1
        val c = max(max(newPts, others), t.pushed + 1)
        val toRef = participants(t).filter(q => q != p and t.pts.get(q) < c and hasUnprotected(t, q))
        val done = isAnchor and toRef == Set()
        val t1 = if (ok)
                   t.with("pts", t.pts.put(p, newPts)).with("waitKey", 0).with("waitOn", NONE)
                    .with("c", if (isAnchor) c else t.c).with("toRefresh", if (isAnchor) toRef else t.toRefresh)
                    .with("status", if (done) Committed else if (isAnchor) Refreshing else Preparing)
                 else t.with("status", Aborted).with("waitKey", 0).with("waitOn", NONE)
        all {
          hlc' = if (ok) hlc.set(p, newPts) else hlc,
          intents' = if (ok) placeIntents(tid, t, p, newPts) else intentsWithout(tid),
          // 成功: このシャードのロックは intent に置き換わり、待ち手を起こす (intent を見て待ち続ける)。失敗: 全ロック解放
          locks' = if (ok) locksWithoutOn(tid, p) else locksWithout(tid),
          txns' = if (ok) KEYS.filter(k => locks.get(k) == tid and shardOf(k) == p).fold(txns.set(tid, t1), (m, k) => wakeOne(m, k))
                  else abortRelease(txns.set(tid, t1), tid),
          waiters' = waiters, hist' = hist, youngDied' = youngDied
        }
    }
  }
  action prepare(tid: int, p: int): bool = all {
    val t = txns.get(tid)
    all { t.status == Preparing, p != t.anchor, participants(t).contains(p), not(t.pts.keys().contains(p)), prepareAt(tid, p, false) }
  }
  action anchorPrepare(tid: int): bool = all {
    val t = txns.get(tid)
    all { t.status == Preparing, participants(t).exclude(Set(t.anchor)) == t.pts.keys(), prepareAt(tid, t.anchor, true) }
  }
  action refresh(tid: int, p: int): bool = all {
    val t = txns.get(tid)
    all {
      t.status == Refreshing, t.toRefresh.contains(p),
      val ok = not(spanConflict(tid, t, p, t.pts.get(p), t.c))
      val rest = t.toRefresh.exclude(Set(p))
      all {
        hlc' = hlc.set(p, max(hlc.get(p), t.c)),
        intents' = if (ok) intents else intentsWithout(tid),
        locks' = if (ok) locks else locksWithout(tid),
        txns' = if (ok) txns.set(tid, t.with("toRefresh", rest).with("status", if (rest == Set()) Committed else Refreshing))
                else abortRelease(txns.set(tid, t.with("status", Aborted)), tid),
        waiters' = waiters, hist' = hist, youngDied' = youngDied
      }
    }
  }
  // phase 2: 適用し intent を消し、その行の待ち手を全員起こす (finalize の wakeAll)
  action apply(tid: int, p: int): bool = all {
    val t = txns.get(tid)
    all {
      t.status == Committed, writeShards(t).contains(p), not(t.applied.contains(p)),
      hlc' = hlc.set(p, max(hlc.get(p), t.c)),
      hist' = KEYS.mapBy(k =>
        if (t.tmpl.writes.contains(k) and shardOf(k) == p and not(t.dropped.contains(p)))
          hist.get(k).union(Set({ ver: t.c, writer: tid, g: t.tmpl.gval }))
        else hist.get(k)),
      intents' = KEYS.mapBy(k => if (t.tmpl.writes.contains(k) and shardOf(k) == p) { txn: NONE, pts: 0 } else intents.get(k)),
      txns' = t.tmpl.writes.filter(k => shardOf(k) == p).fold(txns.set(tid, t.with("applied", t.applied.union(Set(p)))), (m, k) => wakeAllOn(m, k)),
      locks' = locks, waiters' = waiters, youngDied' = youngDied
    }
  }
  action tick(s: int): bool = all {
    hlc.get(s) < CLOCK_MAX,
    hlc' = hlc.set(s, hlc.get(s) + 1),
    txns' = txns, hist' = hist, intents' = intents, locks' = locks, waiters' = waiters, youngDied' = youngDied
  }

  action step = any {
    { nondet tid = oneOf(TXNS) nondet tm = oneOf(TEMPLATES) nondet home = oneOf(SHARDS) begin(tid, tm, home) },
    { nondet tid = oneOf(TXNS) nondet k = oneOf(KEYS) readKey(tid, k) },
    { nondet tid = oneOf(TXNS) readPred(tid) },
    { nondet tid = oneOf(TXNS) nondet p = oneOf(SHARDS) startReadRefresh(tid, p) },
    { nondet tid = oneOf(TXNS) nondet q = oneOf(SHARDS) readRefreshStep(tid, q) },
    { nondet tid = oneOf(TXNS) nondet k = oneOf(KEYS) dmlRequest(tid, k) },
    { nondet tid = oneOf(TXNS) dmlAcquire(tid) },
    { nondet tid = oneOf(TXNS) dmlRewait(tid) },
    { nondet tid = oneOf(TXNS) woundTake(tid) },
    { nondet tid = oneOf(TXNS) waiterLeave(tid) },
    { nondet k = oneOf(KEYS) lockExpire(k) },
    { nondet s = oneOf(SHARDS) restart(s) },
    { nondet tid = oneOf(TXNS) finishRO(tid) },
    { nondet tid = oneOf(TXNS) nondet a = oneOf(SHARDS) sendCommit(tid, a) },
    { nondet tid = oneOf(TXNS) nondet p = oneOf(SHARDS) prepare(tid, p) },
    { nondet tid = oneOf(TXNS) anchorPrepare(tid) },
    { nondet tid = oneOf(TXNS) nondet p = oneOf(SHARDS) refresh(tid, p) },
    { nondet tid = oneOf(TXNS) nondet p = oneOf(SHARDS) apply(tid, p) },
    { nondet s = oneOf(SHARDS) tick(s) }
  }

  // ---- 不変条件 -------------------------------------------------------------------------------
  def orderKey(tid: int): (int, int) =
    val t = txns.get(tid)
    (t.c, if (isRO(t)) NTXN + tid else tid)
  pure def lt(a: (int, int), b: (int, int)): bool = a._1 < b._1 or (a._1 == b._1 and a._2 < b._2)
  def committedWriters(k: int): Set[int] =
    TXNS.filter(u => txns.get(u).status == Committed and txns.get(u).tmpl.writes.contains(k) and not(txns.get(u).dropped.contains(shardOf(k))))
  def expectedWriter(k: int, tid: int): int =
    val before = committedWriters(k).filter(u => u != tid and lt(orderKey(u), orderKey(tid)))
    val top = before.filter(u => before.forall(v => not(lt(orderKey(u), orderKey(v)))))
    if (before == Set()) (if (BASE.contains(k)) 0 else -1) else top.fold(0, (acc, u) => u)
  def expectedG(k: int, tid: int): bool =
    val w = expectedWriter(k, tid)
    if (w == -1) false else if (w == 0) true else txns.get(w).tmpl.gval
  def expectedPred(p: int, tid: int): Set[int] = keysOn(p).filter(k => expectedG(k, tid))
  // 読み取り専用で検証した取引の直列化点は c (検証を通した時刻)。検証なしは T
  val serializable = TXNS.forall(tid =>
    val t = txns.get(tid)
    t.status != Committed or (
      t.readVals.keys().forall(k => t.readVals.get(k) == expectedWriter(k, tid))
      and (t.tmpl.pred == 0 or t.predSeen == expectedPred(t.tmpl.pred, tid))
      and (t.tmpl.dmlPred == 0 or t.dmlPredSeen == expectedPred(t.tmpl.dmlPred, tid))))
  def seenVer(r: Txn, k: int): int =
    val w = r.readVals.get(k)
    if (w == 0) 0 else txns.get(w).c
  val atomicVisibility = TXNS.forall(rid =>
    val r = txns.get(rid)
    not(isRO(r) and r.status == Committed) or TXNS.forall(wid =>
      val w = txns.get(wid)
      val ks = w.tmpl.writes.intersect(r.readVals.keys())
      w.status != Committed or isRO(w) or ks == Set() or ks.forall(k => (seenVer(r, k) >= w.c) == (w.c <= r.c))))
  def base(t: Txn, k: int): int = if (t.since.keys().contains(k)) t.since.get(k) else t.T
  val writeSerial = TXNS.forall(y => TXNS.forall(x =>
    val ty = txns.get(y)
    val tx = txns.get(x)
    x == y or ty.status != Committed or tx.status != Committed or
      ty.tmpl.writes.intersect(tx.tmpl.writes).forall(k => not(base(ty, k) < tx.c and tx.c < ty.c))))
  // 待ちグラフ: 待ち手が奪える相手 (若く、prepare 前) への辺は閉路に数えない
  def waitEdge(a: int): int =
    val t = txns.get(a)
    if (t.waitOn == NONE) NONE
    else if (older(a, t.waitOn) and not(prepared(txns.get(t.waitOn)))) NONE
    else t.waitOn
  val noDeadlock = TXNS.forall(a => TXNS.forall(b =>
    val wa = waitEdge(a)
    val wb = waitEdge(b)
    a == b or (wb != a or wa != b)
      and TXNS.forall(d => d == a or d == b or not(wa == b and wb == d and waitEdge(d) == a))))
  val noYoungDie = not(youngDied)
  val atomicWrites = TXNS.forall(tid => txns.get(tid).status != Committed or txns.get(tid).dropped == Set())
  // lost wakeup: ロックも intent も無いのに、待ち手が全員眠っている
  val noLostWakeup = KEYS.forall(k =>
    holderOf(k) != NONE or waiters.get(k) == Set() or waiters.get(k).exists(w => txns.get(w).awake))
  val protocolSafe = serializable and atomicVisibility and writeSerial and noDeadlock and atomicWrites

  // witness
  val witnessPessWaitedCommit = not(TXNS.exists(tid =>
    val t = txns.get(tid)
    t.tmpl.pess and t.waited and t.status == Committed and t.applied == writeShards(t)))
  val witnessWoundTaken = not(TXNS.exists(tid => TXNS.exists(h =>
    tid != h and txns.get(tid).tmpl.pess and txns.get(tid).waited and locks.get(1) == tid and txns.get(h).done.contains(1)
      and txns.get(h).status == Reading)))
  val witnessImmROValidated = not(TXNS.exists(tid =>
    val t = txns.get(tid)
    t.tmpl.imm and isRO(t) and t.status == Committed and t.since.keys() == Set(1, 3)))
  val witnessSecondDml = not(TXNS.exists(tid => txns.get(tid).tmpl.twice and txns.get(tid).second and txns.get(tid).status == Committed))
}

module m9_green {
  import m9_core(RED_SKIP_LOST = false, RED_F_IS_T = false, RED_WOUND_PREPARED = false, RED_WAIT_DIE = false, RED_NO_PRED = false,
                 RED_PREPARE_WAITS = false, RED_RO_SKIP = false, RED_SECOND_F_NEW = false, RED_IMM_READ_T = false,
                 EXPIRE_WAKES = true, LEAVE_WAKES = true, NTXN = 2, CLOCK_MAX = 1).*
  pure val A: Tmpl = { pess: true, imm: false, reads: Set(), dmlReads: Set(1), pred: 0, dmlPred: 0, writes: Set(1), gval: true, twice: false }
  // 若い 2 が先に x をロック。古い 1 が待ち、遅延の後に奪う。2 は検証で気づいて abort、1 は commit
  run woundTest =
    init.then(begin(1, A, 1)).then(tick(1)).then(begin(2, A, 1))
        .then(dmlRequest(2, 1)).then(dmlRequest(1, 1))
        .expect(txns.get(1).waitOn == 2 and locks.get(1) == 2)
        .then(woundTake(1))
        .expect(locks.get(1) == 1 and txns.get(1).since.get(1) == 1 and txns.get(2).status == Reading)
        .then(sendCommit(1, 1)).then(anchorPrepare(1)).then(apply(1, 1))
        .then(sendCommit(2, 1)).then(anchorPrepare(2))
        .expect(txns.get(1).status == Committed and txns.get(2).status == Aborted and protocolSafe)
}

// 3 取引の green。起こし損ねの反例 (m9_red_leave_silent) は 3 取引で出るので、修正の効果はここで確かめる
module m9_green3 {
  import m9_core(RED_SKIP_LOST = false, RED_F_IS_T = false, RED_WOUND_PREPARED = false, RED_WAIT_DIE = false, RED_NO_PRED = false,
                 RED_PREPARE_WAITS = false, RED_RO_SKIP = false, RED_SECOND_F_NEW = false, RED_IMM_READ_T = false,
                 EXPIRE_WAKES = true, LEAVE_WAKES = true, NTXN = 3, CLOCK_MAX = 1).*
}

// 実装どおりの起こし方: TTL 切れは遅延検出で起こさない → 待ち手が全員眠る
module m9_impl_wake {
  import m9_core(RED_SKIP_LOST = false, RED_F_IS_T = false, RED_WOUND_PREPARED = false, RED_WAIT_DIE = false, RED_NO_PRED = false,
                 RED_PREPARE_WAITS = false, RED_RO_SKIP = false, RED_SECOND_F_NEW = false, RED_IMM_READ_T = false,
                 EXPIRE_WAKES = false, LEAVE_WAKES = false, NTXN = 2, CLOCK_MAX = 1).*
  pure val A: Tmpl = { pess: true, imm: false, reads: Set(), dmlReads: Set(1), pred: 0, dmlPred: 0, writes: Set(1), gval: true, twice: false }
  // 古い 1 が x をロック。若い 2 が待つ (奪えない)。1 のロックが TTL で消える。誰も liveLock を呼ばないので 2 は起きない
  run lostWakeupTest =
    init.then(begin(1, A, 1)).then(tick(1)).then(begin(2, A, 1))
        .then(dmlRequest(1, 1)).then(dmlRequest(2, 1))
        .expect(txns.get(2).waitOn == 1 and not(txns.get(2).awake))
        .then(lockExpire(1))
        .expect(locks.get(1) == 0 and waiters.get(1) == Set(2) and not(txns.get(2).awake) and not(noLostWakeup))
}

module m9_red_ro_skip {
  import m9_core(RED_SKIP_LOST = false, RED_F_IS_T = false, RED_WOUND_PREPARED = false, RED_WAIT_DIE = false, RED_NO_PRED = false,
                 RED_PREPARE_WAITS = false, RED_RO_SKIP = true, RED_SECOND_F_NEW = false, RED_IMM_READ_T = false,
                 EXPIRE_WAKES = true, LEAVE_WAKES = true, NTXN = 2, CLOCK_MAX = 1).*
  pure val L: Tmpl = { pess: true, imm: true, reads: Set(1, 3), dmlReads: Set(), pred: 0, dmlPred: 0, writes: Set(), gval: true, twice: false }
  pure val B: Tmpl = { pess: true, imm: false, reads: Set(), dmlReads: Set(), pred: 0, dmlPred: 0, writes: Set(1, 3), gval: true, twice: false }
  // (a) IMMEDIATE の読み取り専用: x を F=0 でロック読み (writer 0)。ロックが TTL で消え、2 が x, y に c=1 で書く。
  // 1 が y を F=1 でロック読み (writer 2)。検証なしで終わると、x は 2 より前、y は 2 より後の値 → 一貫しない
  run counterexampleTest =
    init.then(begin(1, L, 1)).then(dmlRequest(1, 1))
        .expect(txns.get(1).readVals.get(1) == 0)
        .then(lockExpire(1))
        .then(begin(2, B, 1)).then(dmlRequest(2, 1)).then(dmlRequest(2, 3))
        .then(sendCommit(2, 1)).then(prepare(2, 2)).then(anchorPrepare(2)).then(apply(2, 1)).then(apply(2, 2))
        .then(dmlRequest(1, 3))
        .expect(txns.get(1).readVals.get(3) == 2)
        .then(finishRO(1))
        .expect(txns.get(1).status == Committed and not(atomicVisibility))
}

module m9_red_second_f {
  import m9_core(RED_SKIP_LOST = false, RED_F_IS_T = false, RED_WOUND_PREPARED = false, RED_WAIT_DIE = false, RED_NO_PRED = false,
                 RED_PREPARE_WAITS = false, RED_RO_SKIP = false, RED_SECOND_F_NEW = true, RED_IMM_READ_T = false,
                 EXPIRE_WAKES = true, LEAVE_WAKES = true, NTXN = 2, CLOCK_MAX = 1).*
  pure val A2: Tmpl = { pess: true, imm: false, reads: Set(), dmlReads: Set(1), pred: 0, dmlPred: 0, writes: Set(1), gval: true, twice: true }
  pure val J: Tmpl = { pess: true, imm: false, reads: Set(), dmlReads: Set(), pred: 0, dmlPred: 0, writes: Set(1), gval: false, twice: false }
  // (b) 1 の DML1 が x を F=0 で読む。ロックが消え、2 が x に c=1 で書く。1 の DML2 が F=1 でロックを取り直し since を 1 に上げる。
  // 検証 (1, c] に 2 の commit は入らず commit → 1 は 2 を見ずに上書き
  run counterexampleTest =
    init.then(begin(1, A2, 1)).then(dmlRequest(1, 1))
        .then(lockExpire(1))
        .then(begin(2, J, 1)).then(dmlRequest(2, 1)).then(sendCommit(2, 1)).then(anchorPrepare(2)).then(apply(2, 1))
        .then(dmlRequest(1, 1))
        .expect(txns.get(1).second and txns.get(1).since.get(1) == 1)
        .then(sendCommit(1, 1)).then(anchorPrepare(1)).then(apply(1, 1))
        .expect(txns.get(1).status == Committed and not(serializable))
}

module m9_red_imm_read_t {
  import m9_core(RED_SKIP_LOST = false, RED_F_IS_T = false, RED_WOUND_PREPARED = false, RED_WAIT_DIE = false, RED_NO_PRED = false,
                 RED_PREPARE_WAITS = false, RED_RO_SKIP = false, RED_SECOND_F_NEW = false, RED_IMM_READ_T = true,
                 EXPIRE_WAKES = true, LEAVE_WAKES = true, NTXN = 2, CLOCK_MAX = 1).*
  pure val K: Tmpl = { pess: true, imm: true, reads: Set(1), dmlReads: Set(), pred: 0, dmlPred: 0, writes: Set(1), gval: true, twice: false }
  pure val J: Tmpl = { pess: true, imm: false, reads: Set(), dmlReads: Set(), pred: 0, dmlPred: 0, writes: Set(1), gval: false, twice: false }
  // (c) 1 が T=0 で開始。2 が x に c=1 で commit。1 の IMMEDIATE 読みは x をロックするが T=0 の値を読み、since = F = 1。
  // 検証 (1, c] は 2 を見ない → 1 は古い x を読んだまま commit
  run counterexampleTest =
    init.then(begin(1, K, 1))
        .then(begin(2, J, 1)).then(dmlRequest(2, 1)).then(sendCommit(2, 1)).then(anchorPrepare(2)).then(apply(2, 1))
        .then(dmlRequest(1, 1))
        .expect(txns.get(1).readVals.get(1) == 0 and txns.get(1).since.get(1) == 1)
        .then(sendCommit(1, 1)).then(anchorPrepare(1)).then(apply(1, 1))
        .expect(txns.get(1).status == Committed and not(serializable))
}

module m9_red_skip_lost {
  import m9_core(RED_SKIP_LOST = true, RED_F_IS_T = false, RED_WOUND_PREPARED = false, RED_WAIT_DIE = false, RED_NO_PRED = false,
                 RED_PREPARE_WAITS = false, RED_RO_SKIP = false, RED_SECOND_F_NEW = false, RED_IMM_READ_T = false,
                 EXPIRE_WAKES = true, LEAVE_WAKES = true, NTXN = 2, CLOCK_MAX = 1).*
  pure val A: Tmpl = { pess: true, imm: false, reads: Set(), dmlReads: Set(1), pred: 0, dmlPred: 0, writes: Set(1), gval: true, twice: false }
  pure val J: Tmpl = { pess: true, imm: false, reads: Set(), dmlReads: Set(), pred: 0, dmlPred: 0, writes: Set(1), gval: false, twice: false }
  // trustLocks: since を持つ書きの検証を飛ばす。1 が x をロックして F=0 で読む。TTL でロックが消え、2 が x に c=1 で書く。
  // 1 の prepare はロックが消えているのに検証を飛ばし c=2 で commit → 失われた更新
  run counterexampleTest =
    init.then(begin(1, A, 1)).then(dmlRequest(1, 1))
        .then(lockExpire(1))
        .then(begin(2, J, 1)).then(dmlRequest(2, 1)).then(sendCommit(2, 1)).then(anchorPrepare(2)).then(apply(2, 1))
        .then(sendCommit(1, 1)).then(anchorPrepare(1)).then(apply(1, 1))
        .expect(txns.get(1).status == Committed and not(writeSerial) and not(serializable))
}

module m9_red_wound_prepared {
  import m9_core(RED_SKIP_LOST = false, RED_F_IS_T = false, RED_WOUND_PREPARED = true, RED_WAIT_DIE = false, RED_NO_PRED = false,
                 RED_PREPARE_WAITS = false, RED_RO_SKIP = false, RED_SECOND_F_NEW = false, RED_IMM_READ_T = false,
                 EXPIRE_WAKES = true, LEAVE_WAKES = true, NTXN = 2, CLOCK_MAX = 1).*
}
module m9_red_wait_die {
  import m9_core(RED_SKIP_LOST = false, RED_F_IS_T = false, RED_WOUND_PREPARED = false, RED_WAIT_DIE = true, RED_NO_PRED = false,
                 RED_PREPARE_WAITS = false, RED_RO_SKIP = false, RED_SECOND_F_NEW = false, RED_IMM_READ_T = false,
                 EXPIRE_WAKES = true, LEAVE_WAKES = true, NTXN = 2, CLOCK_MAX = 1).*
}
module m9_red_no_pred {
  import m9_core(RED_SKIP_LOST = false, RED_F_IS_T = false, RED_WOUND_PREPARED = false, RED_WAIT_DIE = false, RED_NO_PRED = true,
                 RED_PREPARE_WAITS = false, RED_RO_SKIP = false, RED_SECOND_F_NEW = false, RED_IMM_READ_T = false,
                 EXPIRE_WAKES = true, LEAVE_WAKES = true, NTXN = 2, CLOCK_MAX = 1).*
}
module m9_red_prepare_waits {
  import m9_core(RED_SKIP_LOST = false, RED_F_IS_T = false, RED_WOUND_PREPARED = false, RED_WAIT_DIE = false, RED_NO_PRED = false,
                 RED_PREPARE_WAITS = true, RED_RO_SKIP = false, RED_SECOND_F_NEW = false, RED_IMM_READ_T = false,
                 EXPIRE_WAKES = true, LEAVE_WAKES = true, NTXN = 2, CLOCK_MAX = 1).*
}
module m9_red_f_is_t {
  import m9_core(RED_SKIP_LOST = false, RED_F_IS_T = true, RED_WOUND_PREPARED = false, RED_WAIT_DIE = false, RED_NO_PRED = false,
                 RED_PREPARE_WAITS = false, RED_RO_SKIP = false, RED_SECOND_F_NEW = false, RED_IMM_READ_T = false,
                 EXPIRE_WAKES = true, LEAVE_WAKES = true, NTXN = 2, CLOCK_MAX = 1).*
}
module m9_red_leave_silent {
  import m9_core(RED_SKIP_LOST = false, RED_F_IS_T = false, RED_WOUND_PREPARED = false, RED_WAIT_DIE = false, RED_NO_PRED = false,
                 RED_PREPARE_WAITS = false, RED_RO_SKIP = false, RED_SECOND_F_NEW = false, RED_IMM_READ_T = false,
                 EXPIRE_WAKES = true, LEAVE_WAKES = false, NTXN = 3, CLOCK_MAX = 1).*
}
