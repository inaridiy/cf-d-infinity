// M14: 取引の中で表を作り直すとき、別の接続の書き込みを失わない
//
// 表を作り直す移行は、新しい表を作り、古い表の行を写し (copy)、古い表を消し (DROP)、名前を変える。DDL の前に取引を確定するので
// (M13)、copy の確定と DROP の間に、古い表を守るものがない。その間に別の接続が古い表へ書いた行は、写されないまま消える。
//
// 決めた設計 (2026-11-11): 取引が読んだ表を DROP するとき、
//   1. copy の区切りは、いままでどおり確定する。
//   2. Meta が、古い表を書き込み禁止にする版を記録する (index の作成と同じ枠。期限つき)。
//   3. 各シャードは、その版を適用した後で (intent を決着させ、以後の書き込みを断る)、copy が読んだ範囲に、copy の読んだ時刻より
//      後の変更がないかを確かめる。
//   4. 全シャードで変更がなければ、Meta が DROP を、書き込み禁止の唯一の終わり方として記録する。変更があれば、禁止を取り消し、
//      DDL を競合として失敗させる (行は失われない。移行は失敗する)。
//
// copy の確定の時刻ではなく、読んだ時刻と比べる。copy が読んだシャードは、どれも読んだ時刻を見ている (読みの要求が時刻を運ぶ) ので、
// その後の書き込みは、どのシャードでも、それより大きい時刻になる。確定の時刻は、参加していないシャードが見ていないことがある
// (不変条件 8 と同じ種類の穴)。
//
// モデルは、古い表の行を持つシャード 2 つ、別の接続の書き込み (prepare と確定の 2 段) 2 回まで、copy の区切り、Meta の禁止と期限切れ。
//
// invariant (guardSafe はこれらの連言):
//   noLostWrite:  DROP が起きたなら、copy が読んだ後に確定した、古い表への書き込みはない
//   oneExit:      禁止の終わり方は、DROP か取り消しのどちらか 1 回だけである
module m14_core {
  const SHARD_LOCK: bool          // 禁止の版を適用したシャードは、古い表への書き込みを断る
  const CHECK: bool               // DROP の前に、copy が読んだ後の変更を確かめる
  const CHECK_AFTER_APPLY: bool   // 確かめるのは、そのシャードが禁止の版を適用した後である
  const DRAIN: bool               // シャードは、禁止の版を適用する前に、intent を決着させる
  const TIED: bool                // DROP は、禁止が生きているときだけ記録できる (禁止の唯一の終わり方)
  const CHECK_FROM_READ: bool     // copy の読んだ時刻と比べる (false なら確定の時刻と比べる)

  pure val SHARDS = Set(1, 2)
  pure val MAXC = 5

  // phase: 0 copy の前、1 copy を確定した、2 禁止を記録した、3 DROP した、4 禁止を取り消した、9 copy が失敗した
  var phase: int
  var clock: int -> int
  var T: int                    // copy の読んだ時刻 (-1 はまだ読んでいない)
  var c: int                    // copy の確定の時刻
  var applied: int -> bool      // シャードが禁止の版を適用した
  var checked: int -> bool      // シャードが確かめて、変更がなかった
  var writes: int -> Set[int]   // シャード -> 確定した書き込みの時刻
  var pend: int -> bool         // シャードに、別の接続の書き込みの intent がある
  var left: int                 // 残りの書き込みの回数
  var late: int                 // ghost: copy が読んだ後に確定した書き込みの数
  var exits: int                // ghost

  pure def max(a: int, b: int): int = if (a > b) a else b

  action init = all {
    phase' = 0, clock' = SHARDS.mapBy(_ => 0), T' = -1, c' = -1,
    applied' = SHARDS.mapBy(_ => false), checked' = SHARDS.mapBy(_ => false),
    writes' = SHARDS.mapBy(_ => Set()), pend' = SHARDS.mapBy(_ => false), left' = 2, late' = 0, exits' = 0,
  }

  /** 禁止が効いているか。禁止の版を適用していて、禁止がまだ終わっていない。DROP の後は表がない。 */
  def locked(s: int): bool = SHARD_LOCK and applied.get(s) and phase == 2
  def gone: bool = phase == 3

  // ---- 別の接続の書き込み ----
  action otherPrepare(s: int): bool = all {
    left > 0, not(pend.get(s)), not(locked(s)), not(gone),
    pend' = pend.set(s, true), left' = left - 1,
    phase' = phase, clock' = clock, T' = T, c' = c, applied' = applied, checked' = checked, writes' = writes, late' = late, exits' = exits,
  }
  action otherCommit(s: int): bool = all {
    pend.get(s), not(gone),
    val ts = clock.get(s) + 1
    all {
      ts <= MAXC,
      clock' = clock.set(s, ts), writes' = writes.set(s, writes.get(s).union(Set(ts))), pend' = pend.set(s, false),
      late' = if (T >= 0) late + 1 else late,
      phase' = phase, T' = T, c' = c, applied' = applied, checked' = checked, left' = left, exits' = exits,
    }
  }
  /** 時計が進む (ほかの表の書き込み)。 */
  action tick(s: int): bool = all {
    clock.get(s) < MAXC,
    clock' = clock.set(s, clock.get(s) + 1),
    phase' = phase, T' = T, c' = c, applied' = applied, checked' = checked, writes' = writes, pend' = pend, left' = left, late' = late, exits' = exits,
  }

  // ---- 移行の取引 ----
  /** copy が古い表を全シャードで読む。読みの要求が時刻を運ぶので、どのシャードも T を見る。 */
  action copyRead = all {
    phase == 0, T < 0,
    val t = SHARDS.fold(0, (m, s) => max(m, clock.get(s)))
    all { T' = t, clock' = SHARDS.mapBy(s => max(clock.get(s), t)),
      phase' = phase, c' = c, applied' = applied, checked' = checked, writes' = writes, pend' = pend, left' = left, late' = late, exits' = exits },
  }
  /** copy の区切りを確定する。読んだ後に変更か intent があれば、検証が断る。確定の時刻は anchor (シャード 1) だけが見る。 */
  action copyCommit = all {
    phase == 0, T >= 0,
    val stale = SHARDS.exists(s => writes.get(s).exists(w => w > T) or pend.get(s))
    val ts = max(clock.get(1), T) + 1
    all {
      ts <= MAXC,
      phase' = if (stale) 9 else 1,
      c' = if (stale) c else ts,
      clock' = if (stale) clock else clock.set(1, ts),
      T' = T, applied' = applied, checked' = checked, writes' = writes, pend' = pend, left' = left, late' = late, exits' = exits,
    }
  }
  /** Meta が、古い表を書き込み禁止にする版を記録する。 */
  action lockRecord = all {
    phase == 1,
    phase' = 2,
    clock' = clock, T' = T, c' = c, applied' = applied, checked' = checked, writes' = writes, pend' = pend, left' = left, late' = late, exits' = exits,
  }
  /** シャードが禁止の版を適用する。DRAIN なら、intent が残っている間は適用しない (決着を待つ)。 */
  action applyLock(s: int): bool = all {
    phase >= 2, not(applied.get(s)),
    not(DRAIN) or not(pend.get(s)),
    applied' = applied.set(s, true),
    phase' = phase, clock' = clock, T' = T, c' = c, checked' = checked, writes' = writes, pend' = pend, left' = left, late' = late, exits' = exits,
  }
  /** シャードが、copy の後の変更を確かめる。変更があれば、禁止を取り消す。 */
  action check(s: int): bool = all {
    CHECK, phase == 2, not(checked.get(s)),
    not(CHECK_AFTER_APPLY) or applied.get(s),
    val since = if (CHECK_FROM_READ) T else c
    val changed = writes.get(s).exists(w => w > since)
    all {
      checked' = if (changed) checked else checked.set(s, true),
      phase' = if (changed) 4 else phase,
      exits' = if (changed) exits + 1 else exits,
      clock' = clock, T' = T, c' = c, applied' = applied, writes' = writes, pend' = pend, left' = left, late' = late,
    }
  }
  /** Meta が DROP を記録する。TIED なら、禁止が生きているときだけ。 */
  action drop = all {
    if (TIED) phase == 2 else (phase == 2 or phase == 4),
    not(CHECK) or SHARDS.forall(s => checked.get(s)),
    phase' = 3, exits' = if (phase == 2) exits + 1 else exits,
    clock' = clock, T' = T, c' = c, applied' = applied, checked' = checked, writes' = writes, pend' = pend, left' = left, late' = late,
  }
  /** 禁止の期限切れ。移行の取引が止まっても、禁止は解ける。 */
  action expire = all {
    phase == 2,
    phase' = 4, exits' = exits + 1,
    clock' = clock, T' = T, c' = c, applied' = applied, checked' = checked, writes' = writes, pend' = pend, left' = left, late' = late,
  }

  action step = any {
    { nondet s = oneOf(SHARDS) otherPrepare(s) },
    { nondet s = oneOf(SHARDS) otherCommit(s) },
    { nondet s = oneOf(SHARDS) tick(s) },
    copyRead, copyCommit, lockRecord,
    { nondet s = oneOf(SHARDS) applyLock(s) },
    { nondet s = oneOf(SHARDS) check(s) },
    drop, expire,
  }

  val noLostWrite = not(phase == 3 and late > 0)
  val oneExit = exits <= 1
  val guardSafe = noLostWrite and oneExit

  // witness
  val witnessDropped = not(phase == 3)
  val witnessDroppedAfterWrites = not(phase == 3 and SHARDS.exists(s => writes.get(s) != Set()))
  val witnessRefusedByCheck = not(phase == 4 and SHARDS.exists(s => checked.get(s) == false and applied.get(s)) and exits == 1 and late > 0)
}

module m14_green {
  import m14_core(SHARD_LOCK = true, CHECK = true, CHECK_AFTER_APPLY = true, DRAIN = true, TIED = true, CHECK_FROM_READ = true).*
}
// 確かめるが、禁止しない。確かめた後、DROP までの間の書き込みが消える。
module m14_red_no_lock {
  import m14_core(SHARD_LOCK = false, CHECK = true, CHECK_AFTER_APPLY = true, DRAIN = true, TIED = true, CHECK_FROM_READ = true).*
}
// 禁止するが、確かめない。copy の確定から禁止までの間の書き込みが消える。
module m14_red_no_check {
  import m14_core(SHARD_LOCK = true, CHECK = false, CHECK_AFTER_APPLY = true, DRAIN = true, TIED = true, CHECK_FROM_READ = true).*
}
// 禁止の版を適用する前に確かめる。確かめた後、適用までの間の書き込みが消える。
module m14_red_check_early {
  import m14_core(SHARD_LOCK = true, CHECK = true, CHECK_AFTER_APPLY = false, DRAIN = true, TIED = true, CHECK_FROM_READ = true).*
}
// intent を決着させずに禁止の版を適用する。確かめた後で、禁止の前の intent が確定する。
module m14_red_no_drain {
  import m14_core(SHARD_LOCK = true, CHECK = true, CHECK_AFTER_APPLY = true, DRAIN = false, TIED = true, CHECK_FROM_READ = true).*
}
// DROP が禁止と結び付いていない。期限切れで禁止が解けた後に DROP が通る。
module m14_red_untied {
  import m14_core(SHARD_LOCK = true, CHECK = true, CHECK_AFTER_APPLY = true, DRAIN = true, TIED = false, CHECK_FROM_READ = true).*
}
// copy の確定の時刻と比べる。確定の時刻を見ていないシャードで、それより小さい時刻の書き込みを見逃す。
module m14_red_commit_ts {
  import m14_core(SHARD_LOCK = true, CHECK = true, CHECK_AFTER_APPLY = true, DRAIN = true, TIED = true, CHECK_FROM_READ = false).*
}
