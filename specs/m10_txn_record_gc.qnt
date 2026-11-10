// M10: anchor の取引記録 (committed と tombstone) の GC と、古い COMMIT の拒否
//
// anchor は決着した取引の記録を、保持時間 R が過ぎたら消す (core.ts の gc)。
// tombstone は「この取引は中止」の印で、読み手はこれを見て intent を無視する。
// tombstone を消した後に同じ取引の COMMIT が届いて確定すると、読み手が無視した書き込みが確定し、
// Serializable が崩れる。
// 実装は、開始 (T) から G を過ぎた取引の COMMIT を anchor が拒否する (G < R)。
//
// 時刻は整数の時計で表す。取引 2 件、参加者 1 個。メッセージの遅延と重複は「COMMIT がいつでも何度でも届く」で表す。
// anchor の再起動で in-flight の登録が消える。
//
// invariant:
//   noCommitAfterIgnored: 読み手が中止と判断して無視した取引は、決して確定しない
//   noLostCommit:         確定した取引の intent は、本体へ適用されるまで記録が残る
// red:
//   m10_red_no_guard:  COMMIT の年齢を確かめない → tombstone を消した後に確定する
//   m10_red_gc_undone: 全参加者への適用前の committed 記録を消す → 参加者が中止と誤判定する
module m10_core {
  const GUARD: bool          // 開始から G を過ぎた COMMIT を拒否する
  const GC_UNDONE: bool      // 適用が終わっていない committed 記録も消す (red)
  const R: int               // 記録の保持時間
  const G: int               // COMMIT を受け付ける取引の年齢の上限
  const MAX_CLOCK: int

  pure val TXNS = Set(1, 2)

  type RecSt = NoRec | Committed | Aborted
  type PSt = PNone | Intent | Applied | Dropped

  var clock: int
  var started: int -> bool
  var startAt: int -> int
  var inflight: Set[int]
  var rec: int -> RecSt
  var recAt: int -> int
  var done: int -> bool        // 全参加者へ決着を届けた
  var part: int -> PSt
  var ignored: Set[int]        // 読み手が中止と判断して intent を無視した
  var everCommitted: Set[int]
  var gcCount: int             // witness 用

  action init = all {
    clock' = 0,
    started' = TXNS.mapBy(_ => false), startAt' = TXNS.mapBy(_ => 0),
    inflight' = Set(), rec' = TXNS.mapBy(_ => NoRec), recAt' = TXNS.mapBy(_ => 0),
    done' = TXNS.mapBy(_ => false), part' = TXNS.mapBy(_ => PNone),
    ignored' = Set(), everCommitted' = Set(), gcCount' = 0,
  }

  action keepAll = all {
    clock' = clock, started' = started, startAt' = startAt, inflight' = inflight, rec' = rec, recAt' = recAt,
    done' = done, part' = part, ignored' = ignored, everCommitted' = everCommitted, gcCount' = gcCount,
  }

  action tick = all {
    clock < MAX_CLOCK,
    clock' = clock + 1,
    started' = started, startAt' = startAt, inflight' = inflight, rec' = rec, recAt' = recAt,
    done' = done, part' = part, ignored' = ignored, everCommitted' = everCommitted, gcCount' = gcCount,
  }

  // 取引の最初の読み取り。T が決まる
  action begin(x: int): bool = all {
    not(started.get(x)),
    started' = started.set(x, true), startAt' = startAt.set(x, clock),
    clock' = clock, inflight' = inflight, rec' = rec, recAt' = recAt,
    done' = done, part' = part, ignored' = ignored, everCommitted' = everCommitted, gcCount' = gcCount,
  }

  // COMMIT が anchor に届く。初回でも、再配送でも、何時間後でもよい。
  // 記録があればそれを返すだけ。in-flight でも記録もなく、年齢の検査を通れば prepare を送る (intent が置かれる)
  action commitArrives(x: int): bool = all {
    started.get(x), not(inflight.contains(x)), rec.get(x) == NoRec,
    not(GUARD) or clock - startAt.get(x) <= G,
    inflight' = inflight.union(Set(x)),
    part' = if (part.get(x) == PNone) part.set(x, Intent) else part,
    clock' = clock, started' = started, startAt' = startAt, rec' = rec, recAt' = recAt,
    done' = done, ignored' = ignored, everCommitted' = everCommitted, gcCount' = gcCount,
  }

  action decideCommit(x: int): bool = all {
    inflight.contains(x), part.get(x) == Intent,
    rec' = rec.set(x, Committed), recAt' = recAt.set(x, clock),
    inflight' = inflight.exclude(Set(x)), everCommitted' = everCommitted.union(Set(x)),
    clock' = clock, started' = started, startAt' = startAt, done' = done, part' = part,
    ignored' = ignored, gcCount' = gcCount,
  }

  action decideAbort(x: int): bool = all {
    inflight.contains(x),
    rec' = rec.set(x, Aborted), recAt' = recAt.set(x, clock), done' = done.set(x, true),
    inflight' = inflight.exclude(Set(x)),
    clock' = clock, started' = started, startAt' = startAt, part' = part,
    ignored' = ignored, everCommitted' = everCommitted, gcCount' = gcCount,
  }

  // anchor の再起動。in-flight の登録が消え、COMMIT の呼び出し元は失敗を受け取る
  action restart = all {
    inflight.size() > 0,
    inflight' = Set(),
    clock' = clock, started' = started, startAt' = startAt, rec' = rec, recAt' = recAt,
    done' = done, part' = part, ignored' = ignored, everCommitted' = everCommitted, gcCount' = gcCount,
  }

  // 読み手 (または redrive) が intent を見て anchor に問い合わせる。
  // 記録がなく in-flight でもなければ tombstone を書き、読み手は intent を無視する
  action query(x: int): bool = all {
    part.get(x) == Intent, not(inflight.contains(x)),
    if (rec.get(x) == Committed) all {
      part' = part.set(x, Applied), done' = done.set(x, true),
      rec' = rec, recAt' = recAt, ignored' = ignored,
    } else all {
      rec' = rec.set(x, Aborted),
      recAt' = if (rec.get(x) == NoRec) recAt.set(x, clock) else recAt,
      done' = done.set(x, true),
      part' = part.set(x, Dropped),
      ignored' = ignored.union(Set(x)),
    },
    clock' = clock, started' = started, startAt' = startAt, inflight' = inflight,
    everCommitted' = everCommitted, gcCount' = gcCount,
  }

  // 遅れて届いた prepare の重複が、中止後の参加者にもう一度 intent を置く。
  // 適用済みの参加者への重複は、自分の commit (c > T) が検証で競合になるので intent を置かない (仮定)
  action latePrepare(x: int): bool = all {
    started.get(x), part.get(x) == Dropped,
    part' = part.set(x, Intent),
    clock' = clock, started' = started, startAt' = startAt, inflight' = inflight, rec' = rec, recAt' = recAt,
    done' = done, ignored' = ignored, everCommitted' = everCommitted, gcCount' = gcCount,
  }

  // 記録の GC。決着を届け終えた記録だけを、保持時間の後に消す (red は未完了の committed も消す)
  action gc(x: int): bool = all {
    rec.get(x) != NoRec, done.get(x) or GC_UNDONE, clock - recAt.get(x) >= R,
    rec' = rec.set(x, NoRec), gcCount' = gcCount + 1,
    clock' = clock, started' = started, startAt' = startAt, inflight' = inflight, recAt' = recAt,
    done' = done, part' = part, ignored' = ignored, everCommitted' = everCommitted,
  }

  action step = any {
    tick, restart,
    nondet x = TXNS.oneOf()
    any { begin(x), commitArrives(x), decideCommit(x), decideAbort(x), query(x), latePrepare(x), gc(x) },
  }

  // 読み手が無視した書き込みが確定すると、その読み手の結果は確定した履歴と矛盾する
  val noCommitAfterIgnored = TXNS.forall(x => not(ignored.contains(x) and everCommitted.contains(x)))
  // 確定した取引の intent を、参加者が中止として捨ててはならない
  val noLostCommit = TXNS.forall(x => not(everCommitted.contains(x) and ignored.contains(x)))
    and TXNS.forall(x => everCommitted.contains(x) and not(done.get(x)) implies rec.get(x) == Committed)
  val safe = noCommitAfterIgnored and noLostCommit

  // witness: tombstone を消した後に、同じ取引への COMMIT が届く状況に到達できる
  val witnessGcThenLateCommit = not(TXNS.exists(x => ignored.contains(x) and rec.get(x) == NoRec and inflight.contains(x)))
  val witnessGc = gcCount < 2
}

module m10_green {
  import m10_core(GUARD = true, GC_UNDONE = false, R = 3, G = 1, MAX_CLOCK = 6).*
}
module m10_red_no_guard {
  import m10_core(GUARD = false, GC_UNDONE = false, R = 3, G = 1, MAX_CLOCK = 6).*
}
module m10_red_gc_undone {
  import m10_core(GUARD = true, GC_UNDONE = true, R = 3, G = 1, MAX_CLOCK = 6).*
}
module m10_red_guard_too_long {
  // G >= R だと、GC の後でも年齢の検査を通る
  import m10_core(GUARD = true, GC_UNDONE = false, R = 3, G = 3, MAX_CLOCK = 6).*
}
