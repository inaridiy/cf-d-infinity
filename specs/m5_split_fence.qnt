// M5: split の cutover (design.md「パーティショニングと split」手順 1〜6)
//
// 親 P (=1) と子 C (=2)、右半分のキー 2 個、書き込み 3 件、経路キャッシュを持つ Worker 2 個。
// フェーズ: Copying → Fenced → Handed (子が最終ログと intent を受け取り active) → Switched (Meta 切替) → Done (親が削除)。
// Worker は Meta の経路をキャッシュし、NotOwner を受けたときだけ更新する (stale routing)。
//
// invariants:
//   singleOwner:       右半分の write を親と子が同時に受理しない
//   noLostWrite:       Handed 以降、各キーの子の値は実時間で最後に受理された write と一致する (親で受理した write を失わない)
//   latestConsistent:  Handed 以降、親で受理された write は子に入ったか、同じキーの後続 write に上書きされた
//   intentNotLost:     親に置かれた intent は、解決されるか現オーナーに存在する
// red: Meta の切替と子の active 化を fence の前に行う / handoff で intent を運ばない
module m5_core {
  const RED_EARLY_SWITCH: bool   // fence 前に Meta を切り替え、子を active にする
  const RED_DROP_INTENTS: bool   // handoff で未解決 intent を子へ運ばない

  pure val P = 1
  pure val C = 2
  pure val KEYS = Set(1, 2)
  pure val WRITES = Set(1, 2, 3)
  pure val INTENTS = Set(11, 12)
  pure val WORKERS = Set(1, 2)
  pure def keyOf(id: int): int = if (id == 3 or id == 12) 2 else 1

  type Phase = Copying | Fenced | Handed | Switched | Done

  var phase: Phase
  var route: int                 // Meta の現オーナー
  var cache: int -> int          // Worker のキャッシュ
  var parentData: int -> int     // key -> 最新 writer (0 初期、-1 削除済み)
  var childData: int -> int
  var childActive: bool
  var childApplied: Set[int]     // 子に (copy / handoff / 直接受理で) 入った write
  var pending: Set[int]          // 未実行の write
  var acceptedBy: int -> int     // write -> 受理した DO (0 = 未)
  var lastAccepted: int -> int   // key -> 実時間で最後に受理された write (ghost)
  var parentIntents: Set[int]
  var childIntents: Set[int]
  var placed: Set[int]           // 置かれた intent (ghost)
  var resolved: Set[int]

  action init = all {
    phase' = Copying, route' = P, cache' = WORKERS.mapBy(_ => P),
    parentData' = KEYS.mapBy(_ => 0), childData' = KEYS.mapBy(_ => 0),
    childActive' = false, childApplied' = Set(),
    pending' = WRITES, acceptedBy' = WRITES.mapBy(_ => 0), lastAccepted' = KEYS.mapBy(_ => 0),
    parentIntents' = Set(), childIntents' = Set(), placed' = Set(), resolved' = Set()
  }

  action keepSplit = all { phase' = phase, route' = route, childActive' = childActive }
  action keepIntents = all { parentIntents' = parentIntents, childIntents' = childIntents, placed' = placed, resolved' = resolved }
  action keepWrites = all {
    parentData' = parentData, childData' = childData, childApplied' = childApplied,
    pending' = pending, acceptedBy' = acceptedBy, lastAccepted' = lastAccepted
  }

  def parentAccepts: bool = phase == Copying
  def childAccepts: bool = childActive

  // Worker w が write id を、キャッシュした経路へ送る
  action workerWrite(w: int, id: int): bool = all {
    pending.contains(id),
    val target = cache.get(w)
    val k = keyOf(id)
    any {
      // 親が受理
      all {
        target == P, parentAccepts,
        parentData' = parentData.set(k, id),
        pending' = pending.exclude(Set(id)),
        acceptedBy' = acceptedBy.set(id, P),
        lastAccepted' = lastAccepted.set(k, id),
        childData' = childData, childApplied' = childApplied, cache' = cache
      },
      // 親が NotOwner を返し、Worker がキャッシュを更新 (write は再送待ち)
      all {
        target == P, phase == Handed or phase == Switched or phase == Done,
        cache' = cache.set(w, C),
        keepWrites
      },
      // 子が受理
      all {
        target == C, childAccepts,
        childData' = childData.set(k, id),
        childApplied' = childApplied.union(Set(id)),
        pending' = pending.exclude(Set(id)),
        acceptedBy' = acceptedBy.set(id, C),
        lastAccepted' = lastAccepted.set(k, id),
        parentData' = parentData, cache' = cache
      }
      // Fenced の親、未 active の子は retry 指示 (状態変化なし) なので省く
    },
    keepSplit, keepIntents
  }

  // Worker が Meta を読み直す
  action refreshCache(w: int): bool = all {
    cache' = cache.set(w, route),
    keepSplit, keepIntents, keepWrites
  }

  // コピー中: 親の現在値を子へチャンク転送
  action copyKey(k: int): bool = all {
    phase == Copying,
    childData' = childData.set(k, parentData.get(k)),
    childApplied' = childApplied.union(if (parentData.get(k) == 0) Set() else Set(parentData.get(k))),
    parentData' = parentData, pending' = pending, acceptedBy' = acceptedBy, lastAccepted' = lastAccepted,
    cache' = cache, keepSplit, keepIntents
  }

  // クロスシャード取引の prepare が親に intent を置く (fence 前)
  action placeIntent(id: int): bool = all {
    INTENTS.contains(id), not(placed.contains(id)),
    phase == Copying or phase == Fenced,
    parentIntents' = parentIntents.union(Set(id)),
    placed' = placed.union(Set(id)),
    childIntents' = childIntents, resolved' = resolved,
    cache' = cache, keepSplit, keepWrites
  }

  // 現オーナーで intent を解決 (anchor 照会で committed → 本体へ適用)
  action resolveIntent(id: int): bool = all {
    val k = keyOf(id)
    any {
      all {
        parentIntents.contains(id), phase == Copying or phase == Fenced,
        parentIntents' = parentIntents.exclude(Set(id)),
        parentData' = parentData.set(k, id),
        lastAccepted' = lastAccepted.set(k, id),
        acceptedBy' = acceptedBy, childData' = childData, childApplied' = childApplied, pending' = pending,
        childIntents' = childIntents
      },
      all {
        childIntents.contains(id), phase == Handed or phase == Switched or phase == Done,
        childIntents' = childIntents.exclude(Set(id)),
        childData' = childData.set(k, id),
        childApplied' = childApplied.union(Set(id)),
        lastAccepted' = lastAccepted.set(k, id),
        acceptedBy' = acceptedBy, parentData' = parentData, pending' = pending,
        parentIntents' = parentIntents
      }
    },
    resolved' = resolved.union(Set(id)), placed' = placed,
    cache' = cache, keepSplit
  }

  // 親が右半分への要求を止める
  action fence = all {
    phase == Copying,
    phase' = Fenced, route' = route, childActive' = childActive,
    cache' = cache, keepIntents, keepWrites
  }

  // 残りのログと intent を子へ送り、子を active にする
  action handoff = all {
    phase == Fenced,
    phase' = Handed, route' = route, childActive' = true,
    childData' = parentData,
    childApplied' = childApplied.union(KEYS.map(k => parentData.get(k)).exclude(Set(0))),
    childIntents' = if (RED_DROP_INTENTS) childIntents else childIntents.union(parentIntents),
    parentIntents' = Set(),
    placed' = placed, resolved' = resolved,
    parentData' = parentData, pending' = pending, acceptedBy' = acceptedBy, lastAccepted' = lastAccepted,
    cache' = cache
  }

  // Meta の経路を子へ切り替える。red では fence 前でも切り替え、子を active にする
  action metaSwitch = all {
    any {
      all { phase == Handed, phase' = Switched, childActive' = childActive },
      all { RED_EARLY_SWITCH, phase == Copying or phase == Fenced, phase' = phase, childActive' = true }
    },
    route' = C,
    cache' = cache, keepIntents, keepWrites
  }

  // 親が右半分を削除
  action parentDelete = all {
    phase == Switched,
    phase' = Done, route' = route, childActive' = childActive,
    parentData' = KEYS.mapBy(_ => -1),
    childData' = childData, childApplied' = childApplied, pending' = pending,
    acceptedBy' = acceptedBy, lastAccepted' = lastAccepted,
    cache' = cache, keepIntents
  }

  action step = any {
    { nondet w = oneOf(WORKERS) nondet id = oneOf(WRITES) workerWrite(w, id) },
    { nondet w = oneOf(WORKERS) refreshCache(w) },
    { nondet k = oneOf(KEYS) copyKey(k) },
    { nondet id = oneOf(INTENTS) placeIntent(id) },
    { nondet id = oneOf(INTENTS) resolveIntent(id) },
    fence, handoff, metaSwitch, parentDelete
  }

  // ---- 不変条件 -------------------------------------------------------------
  val singleOwner = not(parentAccepts and childAccepts)
  def afterHandoff: bool = phase == Handed or phase == Switched or phase == Done
  // Handed 以降、各キーの子の値は実時間で最後に受理された write (親で受理されたものを含む) と一致する。
  // 親で受理された write が子に無いなら、ここで食い違う。
  val noLostWrite = not(afterHandoff) or KEYS.forall(k => childData.get(k) == lastAccepted.get(k))
  // 親で受理された write は、子に入ったか、同じキーへの後続 write に上書きされたか
  val latestConsistent = not(afterHandoff) or WRITES.forall(id =>
    acceptedBy.get(id) != P or childApplied.contains(id) or lastAccepted.get(keyOf(id)) != id)
  val intentNotLost = placed.forall(id =>
    resolved.contains(id)
    or (not(afterHandoff) and parentIntents.contains(id))
    or (afterHandoff and childIntents.contains(id)))
  val splitSafe = singleOwner and noLostWrite and latestConsistent and intentNotLost

  // witness: 親と子の両方で write が受理され、Done に到達し、stale な Worker が NotOwner で直った
  val witnessDoneWithBoth = not(phase == Done and WRITES.exists(id => acceptedBy.get(id) == P)
                                and WRITES.exists(id => acceptedBy.get(id) == C) and pending == Set())
  val witnessIntentResolvedAtChild = not(afterHandoff and resolved != Set() and placed != Set()
                                         and INTENTS.exists(id => placed.contains(id) and resolved.contains(id) and childApplied.contains(id)))
}

module m5_green {
  import m5_core(RED_EARLY_SWITCH = false, RED_DROP_INTENTS = false).*
  run cutoverTest =
    init.then(workerWrite(1, 1)).then(copyKey(1)).then(placeIntent(11))
        .then(workerWrite(2, 3))
        .then(fence).then(handoff)
        .expect(childIntents == Set(11) and childApplied == Set(1, 3))
        .then(workerWrite(1, 2))      // stale cache: NotOwner → cache 更新
        .expect(cache.get(1) == C and pending.contains(2))
        .then(workerWrite(1, 2))
        .then(metaSwitch).then(resolveIntent(11)).then(parentDelete)
        .expect(phase == Done and childData.get(1) == 11 and childData.get(2) == 3 and splitSafe)
}

module m5_red_switch {
  import m5_core(RED_EARLY_SWITCH = true, RED_DROP_INTENTS = false).*
  // コピー中に Meta が切り替わり子が active になる。Worker 2 は Meta を読み直して子へ、Worker 1 は stale で親へ。
  // 両方受理される (singleOwner 違反)。その後 fence / handoff で親の状態が子を上書きし、子で受理した write が消える。
  run counterexampleTest =
    init.then(metaSwitch)
        .expect(childActive and parentAccepts and not(singleOwner))
        .then(refreshCache(2))
        .then(workerWrite(1, 2))      // stale な Worker 1: 親が key 1 に write 2 を受理
        .then(workerWrite(2, 1))      // Worker 2: 子が key 1 に write 1 を受理 (実時間で後)
        .expect(childData.get(1) == 1 and parentData.get(1) == 2)
        .then(fence).then(handoff)    // 親の状態で子を上書き: childData[1] = 2、write 1 が消える
        .expect(childData.get(1) == 2 and lastAccepted.get(1) == 1 and not(noLostWrite) and not(splitSafe))
}

module m5_red_intents {
  import m5_core(RED_EARLY_SWITCH = false, RED_DROP_INTENTS = true).*
  run counterexampleTest =
    init.then(placeIntent(11)).then(fence).then(handoff)
        .expect(childIntents == Set() and not(intentNotLost))
}
