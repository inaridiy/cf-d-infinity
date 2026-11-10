// M8: __ver 列を廃止し、first-committer-wins を「直近 write 索引」だけで判定する (実装の recent / changedSince)
//
// 1 シャード、キー 2 個。索引はメモリ上の key -> 最新 commit 時刻。
//   - 索引が膨らんだら捨てて recentLowWater = HLC (メモリ)。
//   - flush 後に __log の世代を DROP し、logLowWater (永続) を上げる。
//   - 再起動で索引と recentLowWater は消え、__log (残っている世代) から索引を作り直す。
//   - 検証: T < logLowWater または T < recentLowWater なら abort。そうでなければ 索引[key] > T なら競合。
// invariant fcw: 検証を通った書き込みは、そのキーに T より新しい commit を持たない (全履歴に対して)。
module m8_core {
  const RED_DROP_NO_LOWWATER: bool   // 世代 DROP で logLowWater を上げない
  const RED_REBUILD_LATEST_ONLY: bool // 再起動時に最新世代だけから索引を作る
  const COMMIT_MAX: int

  pure val KEYS = Set(1, 2)
  pure def max(a: int, b: int): int = if (a > b) a else b
  type Entry = { ts: int, key: int, gen: int }

  var hlc: int
  var log: Set[Entry]          // 残っている __log の行 (世代付き)
  var gen: int                 // 現在の世代
  var history: Set[Entry]      // ghost: 全 commit
  var index: int -> int        // key -> 最新 commit (メモリ)。-1 = 無し
  var recentLow: int           // メモリ
  var logLow: int              // 永続
  var badAdmit: bool           // ghost: FCW を破って検証を通した
  var nCommits: int

  action init = all {
    hlc' = 0, log' = Set(), gen' = 0, history' = Set(), index' = KEYS.mapBy(_ => -1), recentLow' = 0, logLow' = 0,
    badAdmit' = false, nCommits' = 0
  }
  action keepIdx = all { index' = index, recentLow' = recentLow }
  action keepLog = all { log' = log, gen' = gen, logLow' = logLow }

  // commit: HLC を進め、__log に書き、索引を更新
  action commit(k: int): bool = all {
    nCommits < COMMIT_MAX,
    val c = hlc + 1
    all {
      hlc' = c, nCommits' = nCommits + 1,
      log' = log.union(Set({ ts: c, key: k, gen: gen })),
      history' = history.union(Set({ ts: c, key: k, gen: gen })),
      index' = index.set(k, c), recentLow' = recentLow,
      gen' = gen, logLow' = logLow, badAdmit' = badAdmit
    }
  }
  // 索引が膨らんだので捨てる (recentLowWater = HLC)
  action prune = all {
    index' = KEYS.mapBy(_ => -1), recentLow' = hlc,
    hlc' = hlc, history' = history, badAdmit' = badAdmit, nCommits' = nCommits, keepLog
  }
  // flush 後に現世代を DROP。green は logLowWater = HLC (この世代の commit はすべて HLC 以下)
  action dropGen = all {
    log.exists(e => e.gen == gen),
    log' = log.filter(e => e.gen != gen),
    gen' = gen + 1,
    logLow' = if (RED_DROP_NO_LOWWATER) logLow else hlc,
    hlc' = hlc, history' = history, badAdmit' = badAdmit, nCommits' = nCommits, keepIdx
  }
  // 再起動: 索引と recentLowWater を失い、__log から作り直す。HLC は永続化した上限 (= 最大 commit) から再開
  action restart = all {
    val src = if (RED_REBUILD_LATEST_ONLY) log.filter(e => e.gen == gen) else log
    all {
      index' = KEYS.mapBy(k => src.filter(e => e.key == k).fold(-1, (acc, e) => max(acc, e.ts))),
      recentLow' = 0,
      hlc' = hlc, history' = history, badAdmit' = badAdmit, nCommits' = nCommits, keepLog
    }
  }
  // 読み時刻 T の書き込みの検証。admit なら FCW を全履歴で確かめる (ghost)
  action validate(k: int, t: int): bool = all {
    t <= hlc,
    val admit = t >= logLow and t >= recentLow and index.get(k) <= t
    val truthOk = not(history.exists(e => e.key == k and e.ts > t))
    all {
      badAdmit' = (badAdmit or (admit and not(truthOk))),
      hlc' = hlc, history' = history, nCommits' = nCommits, keepIdx, keepLog
    }
  }

  action step = any {
    { nondet k = oneOf(KEYS) commit(k) },
    prune,
    dropGen,
    restart,
    { nondet k = oneOf(KEYS) nondet t = oneOf(0.to(COMMIT_MAX)) validate(k, t) }
  }

  val fcw = not(badAdmit)
  val witnessAdmitAfterRestart = not(nCommits >= 2 and log == Set() and index.get(1) == -1 and recentLow == 0)
}

module m8_green {
  import m8_core(RED_DROP_NO_LOWWATER = false, RED_REBUILD_LATEST_ONLY = false, COMMIT_MAX = 3).*
  run rebuildTest =
    init.then(commit(1)).then(prune).then(restart)
        .expect(index.get(1) == 1 and recentLow == 0)
        .then(validate(1, 0))
        .expect(fcw)
}
module m8_red_drop {
  import m8_core(RED_DROP_NO_LOWWATER = true, RED_REBUILD_LATEST_ONLY = false, COMMIT_MAX = 3).*
  // key 1 に c = 1 で commit → 世代 DROP (logLowWater を上げない) → 再起動で索引が空 → T = 0 の書き込みが通る
  run counterexampleTest =
    init.then(commit(1)).then(dropGen).then(restart)
        .expect(index.get(1) == -1 and logLow == 0)
        .then(validate(1, 0))
        .expect(not(fcw))
}
module m8_red_latest {
  import m8_core(RED_DROP_NO_LOWWATER = false, RED_REBUILD_LATEST_ONLY = true, COMMIT_MAX = 3).*
  // key 1 に c = 1 (世代 0) → DROP せず世代だけ進める操作は無いので、c = 1 の世代 0 を DROP する前に世代 1 で key 2 を書く必要がある。
  // dropGen は現世代を捨てるので、世代 0 を残して世代 1 を作るには: commit(1) [gen 0] → dropGen は gen 0 を捨ててしまう。
  // そこで: commit(1) [gen 0]、dropGen [gen 0 を捨て logLow = 1、gen 1]、commit(2) [gen 1、c = 2]、restart (最新世代だけ) …
  // 索引は key 2 = 2、key 1 = -1。validate(1, 1): logLow = 1 なので T = 1 は通る。真の key 1 の最新は 1 <= 1 → 違反なし。
  // つまり DROP が logLow を上げるなら「最新世代だけ」でも破れない。TLC で確認する。
  run reachTest = init.then(commit(1)).then(dropGen).then(commit(2)).then(restart).expect(index.get(1) == -1 and logLow == 1)
}
