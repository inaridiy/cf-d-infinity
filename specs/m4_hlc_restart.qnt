// M4: 再起動を跨ぐ HLC (design.md「時刻と分離レベル」: 再起動後は永続化した上限から再開する)
//
// 1 シャード。読み手は T を持ち込み HLC を進める。commit は HLC を厳密に進めて c を発行する。
// 再起動すると in-memory の HLC は失われ、永続化した上限と (別ホストかもしれない) 物理時計の max から再開する。
//
// invariant `commitAfterRead`: 読み手が T を持ち込んだ後の commit は c > T。
// red: commit 時刻だけ永続化する。green: 読み手が HLC を進めたときも上限 (+LEASE の先取り) を永続化する。
module m4_core {
  const PERSIST_ON_READ: bool  // green = true
  const LEASE: int             // 先取り幅。0 なら進めた値そのまま、>0 なら persisted = hlc + LEASE を書いて書き込み回数を減らす
  const CLOCK_MAX: int         // 物理時計の上限
  const T_MAX: int             // 読み手が持ち込む T の上限
  const COMMIT_MAX: int        // commit 回数の上限 (状態空間を有限にする)

  var hlc: int           // in-memory HLC
  var persisted: int     // 永続化した HLC 上限
  var phys: int          // 物理時計 (再起動で別の値になり得る)
  var maxReadT: int      // ghost: 受理した読みの T の最大
  var badCommit: bool    // ghost: c <= maxReadT の commit が起きた
  var nCommits: int      // witness 用

  pure def max(a: int, b: int): int = if (a > b) a else b

  action init = all {
    hlc' = 0, persisted' = 0, phys' = 0, maxReadT' = -1, badCommit' = false, nCommits' = 0
  }

  action tick = all {
    phys < CLOCK_MAX,
    phys' = phys + 1,
    hlc' = hlc, persisted' = persisted, maxReadT' = maxReadT, badCommit' = badCommit, nCommits' = nCommits
  }

  // 読み手が T を持ち込む: HLC = max(HLC, T)。green では進んだ分を永続化する
  action readArrive(t: int): bool = all {
    val newH = max(hlc, t)
    all {
      hlc' = newH,
      persisted' = if (PERSIST_ON_READ and newH > persisted) max(persisted, newH + LEASE) else persisted,
      maxReadT' = max(maxReadT, t),
      phys' = phys, badCommit' = badCommit, nCommits' = nCommits
    }
  }

  // commit: c = max(HLC, phys) + 1。commit は常に永続化される
  action commit = all {
    nCommits < COMMIT_MAX,
    val c = max(hlc, phys) + 1
    all {
      hlc' = c,
      persisted' = max(persisted, c),
      badCommit' = (badCommit or c <= maxReadT),
      nCommits' = nCommits + 1,
      phys' = phys, maxReadT' = maxReadT
    }
  }

  // 再起動: in-memory HLC を失い、persisted と新しい物理時計の max から再開
  action restart(newPhys: int): bool = all {
    phys' = newPhys,
    hlc' = max(persisted, newPhys),
    persisted' = persisted, maxReadT' = maxReadT, badCommit' = badCommit, nCommits' = nCommits
  }

  action step = any {
    tick,
    { nondet t = oneOf(0.to(T_MAX)) readArrive(t) },
    commit,
    { nondet p = oneOf(0.to(CLOCK_MAX)) restart(p) }
  }

  val commitAfterRead = not(badCommit)
  // 帰納的不変条件 (green, LEASE = 0 用)。本質は「HLC も永続化上限も、受理した T 以上」。
  // Apalache は全変数の範囲を `in` で与える必要があるので、到達可能な範囲も一緒に書く。
  // 範囲は定数から導ける: HLC <= max(T_MAX, CLOCK_MAX) + nCommits, persisted <= HLC。
  pure val BASE_MAX = max(T_MAX, CLOCK_MAX)
  val inductive = and {
    phys.in(0.to(CLOCK_MAX)),
    maxReadT.in((-1).to(T_MAX)),
    nCommits.in(0.to(COMMIT_MAX)),
    hlc.in(0.to(BASE_MAX + COMMIT_MAX)),
    persisted.in(0.to(BASE_MAX + COMMIT_MAX)),
    badCommit == false,
    hlc <= BASE_MAX + nCommits,
    persisted <= hlc,
    hlc >= maxReadT,
    persisted >= maxReadT
  }
  val witnessCommitAfterRestartRead = not(nCommits >= 1 and maxReadT >= 1)
}

module m4_green {
  import m4_core(PERSIST_ON_READ = true, LEASE = 0, CLOCK_MAX = 3, T_MAX = 3, COMMIT_MAX = 2).*
  run readRestartCommitTest =
    init.then(readArrive(3)).then(restart(0))
        .expect(hlc == 3)
        .then(commit)
        .expect(nCommits == 1 and commitAfterRead)
}

module m4_green_lease {
  import m4_core(PERSIST_ON_READ = true, LEASE = 2, CLOCK_MAX = 3, T_MAX = 3, COMMIT_MAX = 2).*
}

module m4_red {
  import m4_core(PERSIST_ON_READ = false, LEASE = 0, CLOCK_MAX = 3, T_MAX = 3, COMMIT_MAX = 2).*
  // 読み手が T = 3 を持ち込む (HLC 3、persisted 0)。再起動で別ホスト (phys 0) → HLC = 0。commit c = 1 <= 3。
  run counterexampleTest =
    init.then(readArrive(3))
        .expect(hlc == 3 and persisted == 0)
        .then(restart(0))
        .expect(hlc == 0)
        .then(commit)
        .expect(not(commitAfterRead))
}
