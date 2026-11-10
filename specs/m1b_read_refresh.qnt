// M1b: 実装で変えた 3 点を M1 に反映した検査
//   1. read-time refresh: fresh な取引の読みで、span に T より新しい commit があればシャードは ReadTooOld(to = HLC) を返す。
//      Worker はそれまでに読んだ全 span を (T, to] で refresh し、全部通れば T を to に進めて読み直す。
//      通らなければ fresh を捨て、T のまま rollback-read で読み続ける (書き込みがあれば commit 時の検証で競合)。
//   2. __ver 列の廃止: 書き込みの first-committer-wins は「そのキーの最新 commit 時刻 > T」で判定 (モデルでは hist の最新 = 索引)。
//   3. 複数シャードの読み (autocommit と取引の最初の読み) の T は、対象シャードの HLC の最大。
//      主張「読みの開始前に確定 (応答済み) の書き込みは必ず見える」を invariant freshRead* で検査する。
//
// 2PC 部分は M1 の green (fold / refresh bump / intent 照合 / push は c 未決定時のみ) を固定している。
module m1b_core {
  const RED_RA: bool      // (a) read-time refresh がシャードの HLC を to まで進めない
  const RED_RB: bool      // (b) T を進めた後も、進める前に読んだ span の検証窓を旧 T から取る
  const RED_RC: bool      // (c) refresh が通らなくても T を to に進める
  const PICK_MAX: bool    // (3) 複数シャードの読みの T を対象シャードの HLC の最大にする (false なら最初のシャードの HLC)
  const BUMP_FIRST: bool  // 修正案: 最初の読みで「committed だが c > T の intent」に当たったら T を c に上げる
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

  // seq: 読みを 1 文ずつ別シャードへ出す (取引の 2 文目以降)。false なら 1 文で複数シャードを読む (pickT の対象)
  type Tmpl = { reads: Set[int], pred: int, writes: Set[int], seq: bool }
  pure val TEMPLATES: Set[Tmpl] = Set(
    { reads: Set(1), pred: 0, writes: Set(3), seq: true },        // RW: x を読み y を書く
    { reads: Set(3), pred: 0, writes: Set(1), seq: true },        // RW: y を読み x を書く
    { reads: Set(1), pred: 0, writes: Set(1, 3), seq: true },     // RMW x + y 書き
    { reads: Set(), pred: 1, writes: Set(1, 3), seq: true },      // 述語読み S1 → x, y 書き
    { reads: Set(), pred: 0, writes: Set(2), seq: true },         // insert xi
    { reads: Set(), pred: 0, writes: Set(1), seq: true },         // blind x
    { reads: Set(), pred: 0, writes: Set(3), seq: true },         // blind y
    { reads: Set(), pred: 0, writes: Set(1, 3), seq: true },      // blind x, y (クロスシャード)
    { reads: Set(1, 3), pred: 0, writes: Set(), seq: false },     // 読み取り専用 1 文 (pickT)
    { reads: Set(3), pred: 0, writes: Set(), seq: false },        // 読み取り専用 1 文 1 シャード (autocommit の点読み)
    { reads: Set(1, 3), pred: 0, writes: Set(), seq: true },      // 読み取り専用 2 文 (取引の 2 文目)
    { reads: Set(1, 3), pred: 0, writes: Set(1), seq: true }      // x, y を読み x を書く (2 文目で refresh が要る)
  )

  type Status = Idle | Reading | Preparing | Refreshing | Committed | Aborted
  type Txn = {
    status: Status,
    tmpl: Tmpl,
    fresh: bool,              // 取引 (true) か autocommit の読み (false)。書き手は常に true
    T: int,
    spanT: int -> int,        // shard -> その shard で読んだ span の検証窓の下限 (通常は T)
    readVals: int -> int,
    predSeen: Set[int],
    predDone: bool,
    rTo: int,                 // read-time refresh 中の to (0 = なし)
    rRem: Set[int],           // refresh 未完のシャード
    anchor: int,
    pts: int -> int,
    c: int,
    pushed: int,
    toRefresh: Set[int],
    applied: Set[int],
    startSeq: int,            // 開始時の commitSeq (claim 3 用)
    decSeq: int               // commit 決定時の commitSeq
  }
  type Ver = { ver: int, writer: int }
  type Intent = { txn: int, pts: int }

  var txns: int -> Txn
  var hlc: int -> int
  var hist: int -> Set[Ver]
  var intents: int -> Intent
  var commitSeq: int

  pure def max(a: int, b: int): int = if (a > b) a else b
  pure def maxOf(s: Set[int], d: int): int = s.fold(d, (acc, x) => max(acc, x))
  pure val noVer: Ver = { ver: -1, writer: -1 }
  def versionAt(k: int, t: int): Ver =
    hist.get(k).filter(e => e.ver <= t).fold(noVer, (acc, e) => if (e.ver > acc.ver) e else acc)
  def latestVer(k: int): int = hist.get(k).fold(-1, (acc, e) => max(acc, e.ver))

  pure def writeShards(t: Txn): Set[int] = t.tmpl.writes.map(k => shardOf(k))
  pure def readShards(t: Txn): Set[int] =
    t.tmpl.reads.map(k => shardOf(k)).union(if (t.tmpl.pred == 0) Set() else Set(t.tmpl.pred))
  pure def participants(t: Txn): Set[int] = writeShards(t).union(readShards(t))
  pure def isRO(t: Txn): bool = t.tmpl.writes == Set()
  pure def inflight(t: Txn): bool = t.status == Preparing or t.status == Refreshing
  pure def readsDone(t: Txn): bool = t.readVals.keys() == t.tmpl.reads and (t.tmpl.pred == 0 or t.predDone)
  // これまでに読んだシャード (read-time refresh の対象)
  pure def readSoFar(t: Txn): Set[int] =
    t.readVals.keys().map(k => shardOf(k)).union(if (t.predDone) Set(t.tmpl.pred) else Set())
  pure def hasRead(t: Txn): bool = t.readVals.keys() != Set() or t.predDone
  pure def lo(t: Txn, p: int): int = if (t.spanT.keys().contains(p)) t.spanT.get(p) else t.T

  pure def unprotectedPoint(t: Txn, p: int): Set[int] =
    t.tmpl.reads.filter(k => shardOf(k) == p and not(t.tmpl.writes.contains(k)))
  pure def hasUnprotected(t: Txn, p: int): bool = unprotectedPoint(t, p) != Set() or t.tmpl.pred == p

  def otherIntent(k: int, tid: int): bool = intents.get(k).txn != NONE and intents.get(k).txn != tid
  def readConflict(tid: int, k: int, from: int, hi: int): bool =
    hist.get(k).exists(e => e.ver > from and e.ver <= hi and e.writer != tid) or otherIntent(k, tid)
  // 書きの first-committer-wins: そのキーの最新 commit (索引) > T、または他の intent
  def writeConflict(tid: int, t: Txn, p: int): bool =
    t.tmpl.writes.filter(k => shardOf(k) == p).exists(k => otherIntent(k, tid) or latestVer(k) > t.T)
  def spanConflict(tid: int, t: Txn, p: int, from: int, hi: int): bool =
    unprotectedPoint(t, p).exists(k => readConflict(tid, k, from, hi))
    or (t.tmpl.pred == p and keysOn(p).exists(k => readConflict(tid, k, from, hi)))
  def prepareConflict(tid: int, t: Txn, p: int): bool =
    writeConflict(tid, t, p) or spanConflict(tid, t, p, lo(t, p), BIG)
  // read-time refresh で q の既読 span を (T, ∞) で照合 (実装の changedSince は上限を切らない)
  def readSpansConflict(tid: int, t: Txn, q: int): bool =
    t.readVals.keys().filter(k => shardOf(k) == q).exists(k => readConflict(tid, k, t.T, BIG))
    or (t.predDone and t.tmpl.pred == q and keysOn(q).exists(k => readConflict(tid, k, t.T, BIG)))

  def intentsWithout(tid: int): int -> Intent =
    KEYS.mapBy(k => if (intents.get(k).txn == tid) { txn: NONE, pts: 0 } else intents.get(k))
  def placeIntents(tid: int, t: Txn, p: int, pts: int): int -> Intent =
    KEYS.mapBy(k => if (t.tmpl.writes.contains(k) and shardOf(k) == p) { txn: tid, pts: pts } else intents.get(k))

  // 読み手の intent の扱い (実装の settleIntents): committed なら c に関わらず finalize (= apply を待つ)、
  // c 決定済み未確定 (Refreshing) で c <= T なら待つ、c 未決定なら push。
  pure def pushable(u: Txn): bool = u.status == Preparing
  def blockedBy(k: int, tid: int, t: int): bool =
    val it = intents.get(k)
    if (it.txn == NONE or it.txn == tid or it.pts > t) false
    else
      val u = txns.get(it.txn)
      u.status == Committed or (u.status == Refreshing and u.c <= t)
  def pushTargets(ks: Set[int], tid: int, t: int): Set[int] =
    ks.filter(k =>
      val it = intents.get(k)
      if (it.txn == NONE or it.txn == tid or it.pts > t) false else pushable(txns.get(it.txn))
    ).map(k => intents.get(k).txn)
  def withPushes(m: int -> Txn, targets: Set[int], t: int): int -> Txn =
    targets.fold(m, (acc, u) => acc.set(u, acc.get(u).with("pushed", max(acc.get(u).pushed, t))))
  // fresh な読みで span に T より新しい commit がある (実装の changedSince(span, T))
  def newerThanT(ks: Set[int], t: int): bool = ks.exists(k => latestVer(k) > t)

  pure val idleTxn: Txn = {
    status: Idle, tmpl: { reads: Set(), pred: 0, writes: Set(), seq: true }, fresh: true, T: 0, spanT: Map(),
    readVals: Map(), predSeen: Set(), predDone: false, rTo: 0, rRem: Set(), anchor: NONE,
    pts: Map(), c: 0, pushed: 0, toRefresh: Set(), applied: Set(), startSeq: 0, decSeq: 0
  }
  action init = all {
    txns' = TXNS.mapBy(_ => idleTxn),
    hlc' = SHARDS.mapBy(_ => 0),
    hist' = KEYS.mapBy(k => if (BASE.contains(k)) Set({ ver: 0, writer: 0 }) else Set()),
    intents' = KEYS.mapBy(_ => { txn: NONE, pts: 0 }),
    commitSeq' = 0
  }
  action keepEnv = all { hlc' = hlc, hist' = hist, intents' = intents, commitSeq' = commitSeq }

  // ---- 開始 ------------------------------------------------------------------
  // T: seq な取引は home の HLC。1 文で複数シャードを読むなら PICK_MAX のとき対象 HLC の最大。fresh は RO だけ選べる
  action begin(tid: int, tm: Tmpl, home: int, fr: bool): bool = all {
    txns.get(tid).status == Idle,
    tm.reads.map(k => shardOf(k)).union(tm.writes.map(k => shardOf(k)))
      .union(if (tm.pred == 0) Set() else Set(tm.pred)).contains(home),
    fr or tm.writes == Set(),
    val multi = tm.reads.map(k => shardOf(k)).size() >= 2
    val t0 = if (PICK_MAX and multi and not(tm.seq)) maxOf(SHARDS.map(s => hlc.get(s)), 0) else hlc.get(home)
    txns' = txns.set(tid, idleTxn.with("status", Reading).with("tmpl", tm).with("T", t0).with("fresh", fr)
                                .with("startSeq", commitSeq)),
    keepEnv
  }

  // 修正案 BUMP_FIRST: 最初の読み (まだ何も読んでいない) では、intent を決着させた後の HLC で T を発行し直す。
  // 実装では exec() が settleIntents の前に T を issue しているので、finalize した c > T の書き込みを読み落とす。
  pure def effT(t: Txn, p: int, h: int): int = if (BUMP_FIRST and not(hasRead(t))) max(t.T, h) else t.T

  // ---- 読み ------------------------------------------------------------------
  action readKey(tid: int, k: int): bool = all {
    val t = txns.get(tid)
    all {
      t.status == Reading, t.rTo == 0,
      t.tmpl.reads.contains(k), not(t.readVals.keys().contains(k)),
      val p = shardOf(k)
      val tt = effT(t, p, hlc.get(p))
      all {
        not(blockedBy(k, tid, tt)),
        not(t.fresh and newerThanT(Set(k), tt)),      // fresh なら ReadTooOld (startReadRefresh へ)
        val t1 = t.with("T", tt).with("readVals", t.readVals.put(k, versionAt(k, tt).writer))
                  .with("spanT", if (t.spanT.keys().contains(p)) t.spanT else t.spanT.put(p, tt))
        all {
          hlc' = hlc.set(p, max(hlc.get(p), tt)),
          txns' = withPushes(txns.set(tid, t1), pushTargets(Set(k), tid, tt), tt),
          hist' = hist, intents' = intents, commitSeq' = commitSeq
        }
      }
    }
  }
  action readPredX = all { false, txns' = txns, keepEnv }
  action readKeyEnd = all { false, txns' = txns, keepEnv }
  action readKeyUnused(tid: int): bool = all {
    val t = txns.get(tid)
    all {
      false,
      val p = 1
      val t1 = t
      all {
        hlc' = hlc,
        txns' = txns,
        hist' = hist, intents' = intents, commitSeq' = commitSeq
      }
    }
  }
  action readPred(tid: int): bool = all {
    val t = txns.get(tid)
    all {
      t.status == Reading, t.rTo == 0, t.tmpl.pred != 0, not(t.predDone),
      val p = t.tmpl.pred
      val tt = effT(t, p, hlc.get(p))
      all {
        not(keysOn(p).exists(k => blockedBy(k, tid, tt))),
        not(t.fresh and newerThanT(keysOn(p), tt)),
        val seen = keysOn(p).filter(k => versionAt(k, tt).ver >= 0)
        val t1 = t.with("T", tt).with("predSeen", seen).with("predDone", true)
                  .with("spanT", if (t.spanT.keys().contains(p)) t.spanT else t.spanT.put(p, tt))
        all {
          hlc' = hlc.set(p, max(hlc.get(p), tt)),
          txns' = withPushes(txns.set(tid, t1), pushTargets(keysOn(p), tid, tt), tt),
          hist' = hist, intents' = intents, commitSeq' = commitSeq
        }
      }
    }
  }

  // read-time refresh の開始: シャード p が ReadTooOld(to = HLC_p) を返す。既読シャードが無ければ即 T = to
  action startReadRefresh(tid: int, p: int): bool = all {
    val t = txns.get(tid)
    all {
      t.status == Reading, t.fresh, t.rTo == 0,
      val ks = (if (t.tmpl.pred == p and not(t.predDone)) keysOn(p) else Set())
                 .union(t.tmpl.reads.filter(k => shardOf(k) == p and not(t.readVals.keys().contains(k))))
      val tt = effT(t, p, hlc.get(p))
      all {
        ks != Set(),
        not(ks.exists(k => blockedBy(k, tid, tt))),
        newerThanT(ks, tt),
        val upTo = hlc.get(p)
        val rem = readSoFar(t)
        txns' = txns.set(tid,
          if (rem == Set()) t.with("T", upTo).with("spanT", Map())
          else t.with("T", tt).with("rTo", upTo).with("rRem", rem)),
        keepEnv
      }
    }
  }
  // 既読シャード q の refresh (T, to]。green は HLC を to に進めてから照合
  action readRefreshStep(tid: int, q: int): bool = all {
    val t = txns.get(tid)
    all {
      t.status == Reading, t.rTo != 0, t.rRem.contains(q),
      val newH = if (RED_RA) hlc.get(q) else max(hlc.get(q), t.rTo)
      val ok = not(readSpansConflict(tid, t, q))
      val rem = t.rRem.exclude(Set(q))
      val advanced = t.with("T", t.rTo).with("rTo", 0).with("rRem", Set())
                      .with("spanT", if (RED_RB) t.spanT else Map())
      all {
        hlc' = hlc.set(q, newH),
        txns' = txns.set(tid,
          if (ok and rem != Set()) t.with("rRem", rem)
          else if (ok) advanced
          else if (RED_RC) advanced.with("fresh", false)
          else t.with("fresh", false).with("rTo", 0).with("rRem", Set())),
        hist' = hist, intents' = intents, commitSeq' = commitSeq
      }
    }
  }

  action finishRO(tid: int): bool = all {
    val t = txns.get(tid)
    all {
      t.status == Reading, t.rTo == 0, readsDone(t), isRO(t),
      txns' = txns.set(tid, t.with("status", Committed).with("c", t.T).with("decSeq", commitSeq)),
      keepEnv
    }
  }

  // ---- 2PC (M1 green と同じ) --------------------------------------------------
  action sendCommit(tid: int, a: int): bool = all {
    val t = txns.get(tid)
    all {
      t.status == Reading, t.rTo == 0, readsDone(t), not(isRO(t)), participants(t).contains(a),
      txns' = txns.set(tid, t.with("status", Preparing).with("anchor", a)),
      keepEnv
    }
  }
  action prepare(tid: int, p: int): bool = all {
    val t = txns.get(tid)
    all {
      t.status == Preparing, p != t.anchor, participants(t).contains(p), not(t.pts.keys().contains(p)),
      val ok = not(prepareConflict(tid, t, p))
      val newPts = hlc.get(p) + 1
      all {
        hlc' = if (ok) hlc.set(p, newPts) else hlc,
        intents' = if (ok) placeIntents(tid, t, p, newPts) else intentsWithout(tid),
        txns' = if (ok) txns.set(tid, t.with("pts", t.pts.put(p, newPts))) else txns.set(tid, t.with("status", Aborted)),
        hist' = hist, commitSeq' = commitSeq
      }
    }
  }
  action anchorPrepare(tid: int): bool = all {
    val t = txns.get(tid)
    all {
      t.status == Preparing,
      participants(t).exclude(Set(t.anchor)) == t.pts.keys(),
      val a = t.anchor
      val others = maxOf(t.pts.keys().map(p => t.pts.get(p)), 0)
      val ptsA = max(hlc.get(a), max(others, t.pushed)) + 1
      val ok = not(prepareConflict(tid, t, a))
      val c = max(max(ptsA, others), t.pushed + 1)
      val toRef = participants(t).filter(p => p != a and t.pts.get(p) < c and hasUnprotected(t, p))
      val done = toRef == Set()
      all {
        hlc' = if (ok) hlc.set(a, ptsA) else hlc,
        intents' = if (ok) placeIntents(tid, t, a, ptsA) else intentsWithout(tid),
        txns' = if (ok)
                  txns.set(tid, t.with("pts", t.pts.put(a, ptsA)).with("c", c).with("toRefresh", toRef)
                                 .with("status", if (done) Committed else Refreshing)
                                 .with("decSeq", if (done) commitSeq + 1 else 0))
                else txns.set(tid, t.with("status", Aborted)),
        commitSeq' = if (ok and done) commitSeq + 1 else commitSeq,
        hist' = hist
      }
    }
  }
  action refresh(tid: int, p: int): bool = all {
    val t = txns.get(tid)
    all {
      t.status == Refreshing, t.toRefresh.contains(p),
      val ok = not(spanConflict(tid, t, p, t.pts.get(p), t.c))
      val rest = t.toRefresh.exclude(Set(p))
      val done = ok and rest == Set()
      all {
        hlc' = hlc.set(p, max(hlc.get(p), t.c)),
        intents' = if (ok) intents else intentsWithout(tid),
        txns' = if (ok)
                  txns.set(tid, t.with("toRefresh", rest).with("status", if (done) Committed else Refreshing)
                                 .with("decSeq", if (done) commitSeq + 1 else 0))
                else txns.set(tid, t.with("status", Aborted)),
        commitSeq' = if (done) commitSeq + 1 else commitSeq,
        hist' = hist
      }
    }
  }
  action apply(tid: int, p: int): bool = all {
    val t = txns.get(tid)
    all {
      t.status == Committed, writeShards(t).contains(p), not(t.applied.contains(p)),
      hlc' = hlc.set(p, max(hlc.get(p), t.c)),
      hist' = KEYS.mapBy(k =>
        if (t.tmpl.writes.contains(k) and shardOf(k) == p) hist.get(k).union(Set({ ver: t.c, writer: tid })) else hist.get(k)),
      intents' = KEYS.mapBy(k => if (t.tmpl.writes.contains(k) and shardOf(k) == p) { txn: NONE, pts: 0 } else intents.get(k)),
      txns' = txns.set(tid, t.with("applied", t.applied.union(Set(p)))),
      commitSeq' = commitSeq
    }
  }
  action tick(s: int): bool = all {
    hlc.get(s) < CLOCK_MAX,
    hlc' = hlc.set(s, hlc.get(s) + 1),
    txns' = txns, hist' = hist, intents' = intents, commitSeq' = commitSeq
  }

  action step = any {
    { nondet tid = oneOf(TXNS) nondet tm = oneOf(TEMPLATES) nondet home = oneOf(SHARDS) nondet fr = oneOf(Set(true, false)) begin(tid, tm, home, fr) },
    { nondet tid = oneOf(TXNS) nondet k = oneOf(KEYS) readKey(tid, k) },
    { nondet tid = oneOf(TXNS) readPred(tid) },
    { nondet tid = oneOf(TXNS) nondet p = oneOf(SHARDS) startReadRefresh(tid, p) },
    { nondet tid = oneOf(TXNS) nondet q = oneOf(SHARDS) readRefreshStep(tid, q) },
    { nondet tid = oneOf(TXNS) finishRO(tid) },
    { nondet tid = oneOf(TXNS) nondet a = oneOf(SHARDS) sendCommit(tid, a) },
    { nondet tid = oneOf(TXNS) nondet p = oneOf(SHARDS) prepare(tid, p) },
    { nondet tid = oneOf(TXNS) anchorPrepare(tid) },
    { nondet tid = oneOf(TXNS) nondet p = oneOf(SHARDS) refresh(tid, p) },
    { nondet tid = oneOf(TXNS) nondet p = oneOf(SHARDS) apply(tid, p) },
    { nondet s = oneOf(SHARDS) tick(s) }
  }

  // ---- 不変条件 (M1 と同じ serializable / atomicVisibility) ---------------------------
  def orderKey(tid: int): (int, int) =
    val t = txns.get(tid)
    (t.c, if (isRO(t)) NTXN + tid else tid)
  pure def lt(a: (int, int), b: (int, int)): bool = a._1 < b._1 or (a._1 == b._1 and a._2 < b._2)
  def committedWriters(k: int): Set[int] =
    TXNS.filter(u => txns.get(u).status == Committed and txns.get(u).tmpl.writes.contains(k))
  def expectedWriter(k: int, tid: int): int =
    val before = committedWriters(k).filter(u => u != tid and lt(orderKey(u), orderKey(tid)))
    val top = before.filter(u => before.forall(v => not(lt(orderKey(u), orderKey(v)))))
    if (before == Set()) (if (BASE.contains(k)) 0 else -1) else top.fold(0, (acc, u) => u)
  val serializable = TXNS.forall(tid =>
    val t = txns.get(tid)
    t.status != Committed or (
      t.readVals.keys().forall(k => t.readVals.get(k) == expectedWriter(k, tid))
      and (t.tmpl.pred == 0 or t.predSeen == keysOn(t.tmpl.pred).filter(k => expectedWriter(k, tid) != -1))))
  def seenVer(r: Txn, k: int): int =
    val w = r.readVals.get(k)
    if (w == 0) 0 else txns.get(w).c
  val atomicVisibility = TXNS.forall(rid =>
    val r = txns.get(rid)
    not(isRO(r) and r.status == Committed) or TXNS.forall(wid =>
      val w = txns.get(wid)
      val ks = w.tmpl.writes.intersect(r.readVals.keys())
      w.status != Committed or isRO(w) or ks == Set() or ks.forall(k => (seenVer(r, k) >= w.c) == (w.c <= r.T))))

  // ---- claim 3: 読みの開始 (begin) 前に決定 (応答) 済みの書き手は見える ------------------------
  def freshReadFor(seqOnly: bool): bool = TXNS.forall(rid =>
    val r = txns.get(rid)
    not(isRO(r) and r.status == Committed and r.tmpl.seq == seqOnly) or TXNS.forall(wid =>
      val w = txns.get(wid)
      val ks = w.tmpl.writes.intersect(r.readVals.keys())
      w.status != Committed or isRO(w) or ks == Set() or w.decSeq == 0 or w.decSeq > r.startSeq
        or ks.forall(k => seenVer(r, k) >= w.c)))
  val freshReadPicked = freshReadFor(false)   // 1 文で複数シャード (pickT) の読み
  val freshReadSeq = freshReadFor(true)       // 1 文ずつ別シャード (取引の 2 文目)

  // red (a) の反例シナリオの終状態に TLC が到達できるか (翻訳の食い違いの切り分け用)
  val witnessRaScenario = not(TXNS.exists(r => TXNS.exists(w =>
    val rt = txns.get(r)
    val wt = txns.get(w)
    isRO(rt) and rt.status == Committed and rt.T == 1 and rt.readVals == Map(1 -> 0, 3 -> 2)
      and not(isRO(wt)) and wt.status == Committed and wt.c == 1 and wt.tmpl.writes == Set(1) and wt.applied == Set(1))))
  val witnessReadRefreshAdvanced = not(TXNS.exists(tid =>
    val t = txns.get(tid)
    t.status == Committed and isRO(t) and t.fresh and t.T > 0 and t.readVals.keys().size() == 2
      and t.readVals.keys().exists(k => versionAt(k, t.T).ver > 0)))
}

module m1b_green {
  import m1b_core(RED_RA = false, RED_RB = false, RED_RC = false, PICK_MAX = true, BUMP_FIRST = false, NTXN = 2, CLOCK_MAX = 2).*
  // read-time refresh で T を進めた読み取り専用取引が、両方の読みを新しい snapshot で揃える
  run readRefreshAdvancesTest =
    init.then(begin(1, { reads: Set(1, 3), pred: 0, writes: Set(), seq: true }, 1, true))
        .then(readKey(1, 1))                              // x@S1 を T = 0 で読む
        .then(begin(2, { reads: Set(), pred: 0, writes: Set(3), seq: true }, 2, true))
        .then(sendCommit(2, 2)).then(anchorPrepare(2)).then(apply(2, 2))   // y = W2 (c = 1)
        .then(startReadRefresh(1, 2))                     // y の読みで ReadTooOld(to = 1)
        .expect(txns.get(1).rTo == 1 and txns.get(1).rRem == Set(1))
        .then(readRefreshStep(1, 1))                      // S1 の既読 span は変わっていない → T = 1、HLC_1 = 1
        .expect(txns.get(1).T == 1 and hlc.get(1) == 1)
        .then(readKey(1, 3)).then(finishRO(1))
        .expect(txns.get(1).readVals.get(3) == 2 and serializable and atomicVisibility)
}

module m1b_red_ra {
  import m1b_core(RED_RA = true, RED_RB = false, RED_RC = false, PICK_MAX = true, BUMP_FIRST = false, NTXN = 3, CLOCK_MAX = 0).*
  // R: x@S1 を T=0 で読む。W2 が y@S2 に c=1 で commit。R の y 読みで ReadTooOld(to=1) → S1 を refresh するが HLC を進めない。
  // T=1 に進んで y を読み終わる。W3 が x@S1 に blind write: pts = 1 → c = 1 <= T。R は T=1 の snapshot のはずなのに x は旧値。
  run counterexampleTest =
    init.then(begin(1, { reads: Set(1, 3), pred: 0, writes: Set(), seq: true }, 1, true))
        .then(readKey(1, 1))
        .then(begin(2, { reads: Set(), pred: 0, writes: Set(3), seq: true }, 2, true))
        .then(sendCommit(2, 2)).then(anchorPrepare(2)).then(apply(2, 2))
        .then(startReadRefresh(1, 2)).then(readRefreshStep(1, 1))
        .expect(txns.get(1).T == 1 and hlc.get(1) == 0)
        .then(readKey(1, 3)).then(finishRO(1))
        .then(begin(3, { reads: Set(), pred: 0, writes: Set(1), seq: true }, 1, true))
        .then(sendCommit(3, 1)).then(anchorPrepare(3)).then(apply(3, 1))
        .expect(txns.get(3).c == 1 and txns.get(1).readVals.get(1) == 0 and not(serializable))
        .expect(not(witnessRaScenario))
}

module m1b_red_rb {
  import m1b_core(RED_RA = false, RED_RB = true, RED_RC = false, PICK_MAX = true, BUMP_FIRST = false, NTXN = 2, CLOCK_MAX = 2).*
}

module m1b_red_rc {
  import m1b_core(RED_RA = false, RED_RB = false, RED_RC = true, PICK_MAX = true, BUMP_FIRST = false, NTXN = 2, CLOCK_MAX = 2).*
  // R: x@S1 を T=0 で読む。W2 が x に c=1 で commit (R の既読 span が変わる)。S2 の時計を進めて W3 相当… 2 取引なので:
  // W2 は x と y に書く (c = 2 以上)。R が y で ReadTooOld → S1 の refresh は x の変更で失敗 → RED_RC は T を進める →
  // R は x を旧値 (T=0 時点)、y を新値で読む → atomicVisibility / serializable 違反。
  run counterexampleTest =
    init.then(begin(1, { reads: Set(1, 3), pred: 0, writes: Set(), seq: true }, 1, true))
        .then(readKey(1, 1))
        .then(begin(2, { reads: Set(), pred: 0, writes: Set(1, 3), seq: true }, 1, true))
        .then(sendCommit(2, 1)).then(prepare(2, 2)).then(anchorPrepare(2))
        .then(apply(2, 1)).then(apply(2, 2))
        .expect(txns.get(2).status == Committed)
        .then(startReadRefresh(1, 2))
        .then(readRefreshStep(1, 1))
        .expect(txns.get(1).T == txns.get(2).c and not(txns.get(1).fresh))
        .then(readKey(1, 3)).then(finishRO(1))
        .expect(not(atomicVisibility) and not(serializable))
}

// claim 3 の修正案: 最初の読みで committed (c > T) の intent に当たったら T を c に上げる
module m1b_green_bump {
  import m1b_core(RED_RA = false, RED_RB = false, RED_RC = false, PICK_MAX = true, BUMP_FIRST = true, NTXN = 2, CLOCK_MAX = 2).*
}

// claim 3 の反例 (green のまま): cross-shard の書き込みの phase 2 が読むシャードに未到着
module m1b_claim3 {
  import m1b_core(RED_RA = false, RED_RB = false, RED_RC = false, PICK_MAX = true, BUMP_FIRST = false, NTXN = 2, CLOCK_MAX = 2).*
  // W1: x@S1, y@S2 に blind write。S2 で pts 1。S1 の時計を 2 に進める。anchor S1: pts = c = 3。応答済み (Committed)。
  // phase 2 は未到着。R (autocommit、1 文で x,y) が開始: T = max(HLC) = 3 >= c なので x,y とも見える … これは成立。
  // 成立しない例は S1 の時計が進んでいない場合: anchor S1 の pts = max(0, 1)+1 = 2 = c。R の T = max(2, 1) = 2 >= c。成立。
  // T = max(HLC) は常に anchor の HLC 以上なので pickT では成立し、seq (2 文目) で破れる。TLC に任せる。
  run reachTest = init.expect(true)
}
