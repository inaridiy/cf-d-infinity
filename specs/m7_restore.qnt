// M7: 全シャード同時点 (W) への復元 (S6)
//
// シャード 2 個。commit は c = max(HLC, now) + 1 (時計ずれ無し)。flush は flush_ts 以下の commit を R2 へ書き、
// その後に __log の世代を DROP する (before-image が消える)。W = min(now − MARGIN, min flush_ts)。
// 復元は PITR の bookmark で各シャードを時刻 b の状態に戻す。bookmark は概算なので b は目標 ± APPROX。
//   S6 (REDO = false): 目標 W。b の状態から c > W の commit を __log の before-image で undo する。
//                      b < W なら (b, W] の commit が欠け、c ∈ (W, b] の世代が b 以前に DROP されていれば undo できない。
//   修正版 (REDO = true): 目標 W − APPROX で b <= W を保証し、(b, W] の commit を R2 の after-image で redo する。
//
// invariant restoreCorrect: 復元したシャードの状態 = そのシャードの c <= W の commit 全体。
module m7_core {
  const REDO: bool
  const APPROX: int
  const MARGIN: int
  const T_MAX: int
  const WRITES_PER_SHARD: int

  pure val SHARDS = Set(1, 2)
  pure def max(a: int, b: int): int = if (a > b) a else b
  pure def min(a: int, b: int): int = if (a < b) a else b
  type Flush = { at: int, ts: int }

  var now: int
  var hlc: int -> int
  var commits: int -> Set[int]
  var flushTs: int -> int
  var flushes: int -> Set[Flush]
  var r2: int -> Set[int]
  var wPub: int
  var restored: int -> Set[int]
  var restoredDone: Set[int]
  var restoreFailed: Set[int]
  var recovering: bool            // 復元を始めたら通常運転 (commit / flush / publish / tick) は止まる

  action init = all {
    now' = 0, hlc' = SHARDS.mapBy(_ => 0), commits' = SHARDS.mapBy(_ => Set()),
    flushTs' = SHARDS.mapBy(_ => -1), flushes' = SHARDS.mapBy(_ => Set()), r2' = SHARDS.mapBy(_ => Set()),
    wPub' = -1, restored' = SHARDS.mapBy(_ => Set()), restoredDone' = Set(), restoreFailed' = Set(),
    recovering' = false
  }
  action keepRestore = all { restored' = restored, restoredDone' = restoredDone, restoreFailed' = restoreFailed, recovering' = recovering }
  action keepData = all { hlc' = hlc, commits' = commits, flushTs' = flushTs, flushes' = flushes, r2' = r2 }

  action tick = all {
    not(recovering), now < T_MAX, now' = now + 1, wPub' = wPub, keepData, keepRestore
  }
  action commit(s: int): bool = all {
    not(recovering), commits.get(s).size() < WRITES_PER_SHARD,
    val c = max(hlc.get(s), now) + 1
    all {
      hlc' = hlc.set(s, c), commits' = commits.set(s, commits.get(s).union(Set(c))),
      flushTs' = flushTs, flushes' = flushes, r2' = r2, now' = now, wPub' = wPub, keepRestore
    }
  }
  // flush: flush_ts = HLC。R2 へ書き、世代を DROP (before-image が消える)
  action flush(s: int): bool = all {
    not(recovering),
    val ts = hlc.get(s)
    all {
      flushTs' = flushTs.set(s, ts),
      flushes' = flushes.set(s, flushes.get(s).union(Set({ at: now, ts: ts }))),
      r2' = r2.set(s, r2.get(s).union(commits.get(s).filter(c => c <= ts))),
      hlc' = hlc, commits' = commits, now' = now, wPub' = wPub, keepRestore
    }
  }
  action publish = all {
    val w = SHARDS.fold(now - MARGIN, (acc, s) => min(acc, flushTs.get(s)))
    all { not(recovering), w > wPub, wPub' = w, now' = now, keepData, keepRestore }
  }

  // 時刻 b の bookmark に戻したときの __log: c の before-image は、b 以前に行われた flush_ts >= c の flush で DROP 済み
  def droppedAt(s: int, c: int, b: int): bool = flushes.get(s).exists(f => f.at <= b and f.ts >= c)
  def stateAt(s: int, b: int): Set[int] = commits.get(s).filter(c => c <= b)
  def target(s: int): Set[int] = commits.get(s).filter(c => c <= wPub)

  // 復元。b は目標 ± APPROX の範囲から選ばれる (bookmark の概算)
  action restore(s: int, b: int): bool = all {
    wPub >= 0,
    not(restoredDone.contains(s)),
    val goal = if (REDO) wPub - APPROX else wPub
    all {
      b >= goal - APPROX, b <= goal + APPROX, b >= -1,
      val base = stateAt(s, b)
      // S6: c > W を undo。欠けた (b, W] は補えない。undo は before-image が残っていることが必要
      val undoOk = b >= wPub and base.filter(c => c > wPub).forall(c => not(droppedAt(s, c, b)))
      val redoOk = b <= wPub and target(s).filter(c => c > b).subseteq(r2.get(s))
      val ok = if (REDO) redoOk else undoOk
      val result = if (REDO) base.union(r2.get(s).filter(c => c <= wPub)) else base.filter(c => c <= wPub)
      all {
        restored' = restored.set(s, if (ok) result else base),
        restoredDone' = restoredDone.union(Set(s)),
        restoreFailed' = if (ok) restoreFailed else restoreFailed.union(Set(s)),
        recovering' = true,
        now' = now, wPub' = wPub, keepData
      }
    }
  }

  action step = any {
    tick,
    { nondet s = oneOf(SHARDS) commit(s) },
    { nondet s = oneOf(SHARDS) flush(s) },
    publish,
    { nondet s = oneOf(SHARDS) nondet b = oneOf((-1).to(T_MAX + WRITES_PER_SHARD + 1)) restore(s, b) }
  }

  val restoreCorrect = restoredDone.forall(s => not(restoreFailed.contains(s)) and restored.get(s) == target(s))
  val witnessRestoredNonEmpty = not(restoredDone == SHARDS and SHARDS.exists(s => restored.get(s) != Set()))
}

module m7_green {
  import m7_core(REDO = true, APPROX = 1, MARGIN = 1, T_MAX = 4, WRITES_PER_SHARD = 2).*
  run redoTest =
    init.then(commit(1)).then(tick).then(commit(2)).then(flush(1)).then(flush(2)).then(tick).then(tick)
        .then(publish)                             // W = min(3 − 1, 1, 2) = 1
        .expect(wPub == 1)
        .then(restore(1, -1))                      // bookmark が W より前に落ちても R2 から redo
        .expect(restored.get(1) == Set(1) and restoreCorrect)
}

module m7_red {
  import m7_core(REDO = false, APPROX = 1, MARGIN = 1, T_MAX = 4, WRITES_PER_SHARD = 2).*
  // shard 1: commit c = 1 → flush (flush_ts 1、c = 1 の世代を DROP)。shard 2 は flush_ts 0 のまま。
  // W = min(now − 1, 1, 0) = 0。bookmark が W + 1 = 1 に外れると状態は {1} で、c = 1 > W を undo したいが
  // before-image は既に DROP されている。
  run undoCounterexampleTest =
    init.then(commit(1))                          // c = 1
        .then(tick).then(flush(1)).then(flush(2))  // flush_ts 1 / 0、now = 1
        .then(tick).then(commit(1))                // c = 3
        .then(tick).then(flush(1))                 // flush_ts 3、now = 3
        .then(publish)                             // W = min(3 − 1, 3, 0) = 0
        .expect(wPub == 0)
        .then(restore(1, 1))                      // bookmark が W + 1 に外れる
        .expect(restoreFailed.contains(1) and not(restoreCorrect))
}
