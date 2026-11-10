// M6: 分析用 watermark (design.md「分析パス」: W_cand = now − MARGIN、dirty 報告、resolved ts)
//
// シャード 2 個。真の時刻 now に対して各シャードの物理時計は now + off[s] (|off| <= SKEW)。
// commit は c = max(HLC, phys) + 1 で HLC を進める。クロスシャード取引は prepare (intent, pts) → 後で anchor の決めた
// c (pts <= c、自分の HLC より小さいこともある) で適用される。
// シャードは flush で flush_ts 以下の commit を R2 へ書き、Meta に flush_ts を報告する。
// Meta は W = min(now − MARGIN, dirty なシャードの flush_ts) を公開する (単調増加)。
//
// invariant `watermarkSafe`: 公開済み W 以下の commit はすべて flush 済み。
// red: dirty 報告を intent 書き込み時だけにする / resolved ts を使わず HLC で flush する / SKEW + 報告遅延 > MARGIN。
module m6_core {
  const RED_DIRTY_INTENT_ONLY: bool   // 単一シャード commit では dirty を報告しない
  const RED_NO_RESOLVED_TS: bool      // flush_ts を min(pts) − 1 で抑えない
  const SKEW: int                     // 時計ずれの上限
  const MARGIN: int                   // W_cand = now − MARGIN
  const DELAY_MAX: int                // dirty 報告が届くまでに now が進める量の上限
  const T_MAX: int
  const WRITES_PER_SHARD: int

  pure val SHARDS = Set(1, 2)
  pure def max(a: int, b: int): int = if (a > b) a else b
  pure def min(a: int, b: int): int = if (a < b) a else b
  pure def minOf(s: Set[int], d: int): int = s.fold(d, (acc, x) => min(acc, x))

  var now: int
  var off: int -> int            // 時計のずれ (init で固定)
  var hlc: int -> int
  var commits: int -> Set[int]   // シャードで確定した commit_ts (ghost)
  var unflushed: int -> Set[int]
  var flushed: int -> Set[int]
  var intents: int -> Set[int]   // 未解決 intent の prepare_ts
  var nWrites: int -> int
  var dirtyPending: int -> int   // dirty 報告が送信中なら送信時の now、-1 なら無し
  var dirty: Set[int]            // Meta が dirty と知っているシャード
  var metaFlush: int -> int      // Meta が知る flush_ts (-1 = 未報告)
  var wPub: int                  // 公開済み W (-1 = 未公開)
  var lateDetected: Set[int]     // compactor が「W 以下なのに後から届いた」と検出した commit

  def phys(s: int): int = max(0, now + off.get(s))

  action init = {
    nondet o1 = oneOf((-SKEW).to(SKEW))
    nondet o2 = oneOf((-SKEW).to(SKEW))
    initWith(o1, o2)
  }
  // 決定的テスト用: 時計ずれを与えて初期化
  action initWith(o1: int, o2: int): bool = all {
    all {
      now' = 0,
      off' = Map(1 -> o1, 2 -> o2),
      hlc' = SHARDS.mapBy(_ => 0),
      commits' = SHARDS.mapBy(_ => Set()),
      unflushed' = SHARDS.mapBy(_ => Set()),
      flushed' = SHARDS.mapBy(_ => Set()),
      intents' = SHARDS.mapBy(_ => Set()),
      nWrites' = SHARDS.mapBy(_ => 0),
      dirtyPending' = SHARDS.mapBy(_ => -1),
      dirty' = Set(),
      metaFlush' = SHARDS.mapBy(_ => -1),
      wPub' = -1,
      lateDetected' = Set()
    }
  }

  action keepShard = all {
    hlc' = hlc, commits' = commits, unflushed' = unflushed, flushed' = flushed, intents' = intents, nWrites' = nWrites
  }
  action keepMeta = all { dirty' = dirty, metaFlush' = metaFlush, wPub' = wPub, lateDetected' = lateDetected }

  // 書き込み後、未報告なら dirty 報告を送り始める
  pure def startReport(dp: int -> int, s: int, t: int, isDirty: bool, suppress: bool): int -> int =
    if (suppress or isDirty or dp.get(s) >= 0) dp else dp.set(s, t)

  // 時刻が進む。送信中の dirty 報告は DELAY_MAX 以内に届く (届くまで now は進まない)
  action tick = all {
    now < T_MAX,
    SHARDS.forall(s => dirtyPending.get(s) < 0 or now + 1 - dirtyPending.get(s) <= DELAY_MAX),
    now' = now + 1,
    off' = off, dirtyPending' = dirtyPending, keepShard, keepMeta
  }

  // 単一シャード commit
  action commit(s: int): bool = all {
    nWrites.get(s) < WRITES_PER_SHARD,
    val c = max(hlc.get(s), phys(s)) + 1
    all {
      hlc' = hlc.set(s, c),
      commits' = commits.set(s, commits.get(s).union(Set(c))),
      unflushed' = unflushed.set(s, unflushed.get(s).union(Set(c))),
      nWrites' = nWrites.set(s, nWrites.get(s) + 1),
      dirtyPending' = startReport(dirtyPending, s, now, dirty.contains(s), RED_DIRTY_INTENT_ONLY),
      flushed' = flushed, intents' = intents, now' = now, off' = off, keepMeta
    }
  }

  // クロスシャード取引の prepare: intent を置く (pts = HLC + 1)。intent 書き込みは常に dirty 報告の対象
  action prepare(s: int): bool = all {
    nWrites.get(s) < WRITES_PER_SHARD,
    intents.get(s) == Set(),
    val pts = max(hlc.get(s), phys(s)) + 1
    all {
      hlc' = hlc.set(s, pts),
      intents' = intents.set(s, Set(pts)),
      nWrites' = nWrites.set(s, nWrites.get(s) + 1),
      dirtyPending' = startReport(dirtyPending, s, now, dirty.contains(s), false),
      commits' = commits, unflushed' = unflushed, flushed' = flushed, now' = now, off' = off, keepMeta
    }
  }

  // phase 2: anchor が決めた c (pts <= c、他参加者の pts 次第で自分の HLC 以下にもなる) で適用
  action applyIntent(s: int, c: int): bool = all {
    intents.get(s) != Set(),
    val pts = minOf(intents.get(s), hlc.get(s) + 1)
    all {
      c >= pts, c <= hlc.get(s) + 1,
      hlc' = hlc.set(s, max(hlc.get(s), c)),
      intents' = intents.set(s, Set()),
      commits' = commits.set(s, commits.get(s).union(Set(c))),
      unflushed' = unflushed.set(s, unflushed.get(s).union(Set(c))),
      nWrites' = nWrites, flushed' = flushed, now' = now, off' = off, dirtyPending' = dirtyPending, keepMeta
    }
  }

  // dirty 報告が Meta に届く
  action deliverDirty(s: int): bool = all {
    dirtyPending.get(s) >= 0,
    dirtyPending' = dirtyPending.set(s, -1),
    dirty' = dirty.union(Set(s)),
    metaFlush' = metaFlush, wPub' = wPub, lateDetected' = lateDetected,
    now' = now, off' = off, keepShard
  }

  // flush: flush_ts 以下の commit を R2 へ書き、Meta に報告する。
  // flush_ts = HLC、ただし未解決 intent があれば min(pts) − 1 (resolved ts)。red では HLC のまま。
  // すべて flush 済みで intent も無ければ Meta は dirty を解除する。
  // 公開済み W 以下の commit を今 flush したなら、compactor の遅延検出に記録する。
  action flush(s: int): bool = all {
    val fts = if (RED_NO_RESOLVED_TS or intents.get(s) == Set()) hlc.get(s) else minOf(intents.get(s), hlc.get(s)) - 1
    val moving = unflushed.get(s).filter(c => c <= fts)
    val rest = unflushed.get(s).exclude(moving)
    all {
      flushed' = flushed.set(s, flushed.get(s).union(moving)),
      unflushed' = unflushed.set(s, rest),
      metaFlush' = metaFlush.set(s, fts),
      dirty' = if (rest == Set() and intents.get(s) == Set()) dirty.exclude(Set(s)) else dirty,
      lateDetected' = lateDetected.union(moving.filter(c => c <= wPub)),
      wPub' = wPub,
      hlc' = hlc, commits' = commits, intents' = intents, nWrites' = nWrites,
      now' = now, off' = off, dirtyPending' = dirtyPending
    }
  }

  // Meta が W を公開する (単調増加)
  action publish = all {
    val cand = now - MARGIN
    val w = dirty.fold(cand, (acc, s) => min(acc, metaFlush.get(s)))
    all {
      w > wPub,
      wPub' = w,
      dirty' = dirty, metaFlush' = metaFlush, lateDetected' = lateDetected,
      now' = now, off' = off, dirtyPending' = dirtyPending, keepShard
    }
  }

  action step = any {
    tick,
    { nondet s = oneOf(SHARDS) commit(s) },
    { nondet s = oneOf(SHARDS) prepare(s) },
    { nondet s = oneOf(SHARDS) nondet c = oneOf(0.to(T_MAX + SKEW + 2 * WRITES_PER_SHARD + 1)) applyIntent(s, c) },
    { nondet s = oneOf(SHARDS) deliverDirty(s) },
    { nondet s = oneOf(SHARDS) flush(s) },
    publish
  }

  // ---- 不変条件 -------------------------------------------------------------
  val watermarkSafe = SHARDS.forall(s => commits.get(s).forall(c => c > wPub or flushed.get(s).contains(c)))
  // 遅延検出つき: W 以下の commit は flush 済みか、flush 時に検出される (flush されるまでは検出できない)
  val watermarkSafeOrDetected = SHARDS.forall(s =>
    commits.get(s).forall(c => c > wPub or flushed.get(s).contains(c) or unflushed.get(s).contains(c)))
  val witnessPublished = not(wPub >= 1 and SHARDS.exists(s => flushed.get(s) != Set()))
  val witnessIntentApplied = not(SHARDS.exists(s => commits.get(s).size() >= 2 and flushed.get(s) == commits.get(s)) and wPub >= 1)
}

module m6_green {
  import m6_core(RED_DIRTY_INTENT_ONLY = false, RED_NO_RESOLVED_TS = false,
                 SKEW = 1, MARGIN = 2, DELAY_MAX = 1, T_MAX = 6, WRITES_PER_SHARD = 2).*
  // shard 1 が commit して dirty になる。4 tick 進んでも flush 前は W が -1 のまま (publish は無効)。
  // flush すると W = now − MARGIN = 2 まで進み、commit 1 は flush 済み。
  run idleShardTest =
    initWith(0, 0).then(commit(1)).then(deliverDirty(1))
        .then(tick).then(tick).then(tick).then(tick)
        .expect(dirty == Set(1) and dirty.fold(now - MARGIN, (acc, s) => min(acc, metaFlush.get(s))) == -1)
        .then(flush(1)).then(publish)
        .expect(wPub == 2 and flushed.get(1) == Set(1) and watermarkSafe)
}

module m6_red_dirty {
  import m6_core(RED_DIRTY_INTENT_ONLY = true, RED_NO_RESOLVED_TS = false,
                 SKEW = 1, MARGIN = 2, DELAY_MAX = 1, T_MAX = 6, WRITES_PER_SHARD = 2).*
  // idle な shard 1 で単一シャード commit (c = 1)。dirty 報告なし。now が 3 まで進み W = 1 >= c。flush されていない。
  run counterexampleTest =
    initWith(0, 0).then(commit(1))
        .expect(dirtyPending.get(1) == -1)
        .then(tick).then(tick).then(tick)
        .then(publish)
        .expect(wPub >= 1 and not(watermarkSafe))
}

module m6_red_resolved {
  import m6_core(RED_DIRTY_INTENT_ONLY = false, RED_NO_RESOLVED_TS = true,
                 SKEW = 1, MARGIN = 2, DELAY_MAX = 1, T_MAX = 6, WRITES_PER_SHARD = 2).*
  // shard 1: prepare (pts 1)、commit (HLC 2)。flush_ts = HLC = 2 (resolved ts を使わない)。
  // dirty 解除は intent があるので起きないが、metaFlush = 2 なので W は 2 まで進める。
  // intent が c = 1 で適用される (anchor が他参加者の pts から決めた)。1 <= W だが flush されていない。
  run counterexampleTest =
    initWith(0, 0).then(prepare(1)).then(deliverDirty(1)).then(commit(1))
        .expect(intents.get(1) == Set(1) and hlc.get(1) == 2)
        .then(flush(1))
        .expect(metaFlush.get(1) == 2)
        .then(tick).then(tick).then(tick).then(tick)
        .then(publish)
        .expect(wPub == 2)
        .then(applyIntent(1, 1))
        .expect(not(watermarkSafe))
}

module m6_red_skew {
  // 時計ずれ + 報告遅延 が MARGIN を超える: SKEW = 2, DELAY_MAX = 1, MARGIN = 2
  import m6_core(RED_DIRTY_INTENT_ONLY = false, RED_NO_RESOLVED_TS = false,
                 SKEW = 2, MARGIN = 2, DELAY_MAX = 1, T_MAX = 6, WRITES_PER_SHARD = 2).*
}
