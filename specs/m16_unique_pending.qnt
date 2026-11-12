// M16: 未確定の書き込みがあっても、確定した取引は UNIQUE を守って必ず適用できる (不変条件 2 の UNIQUE の部分)
//
// シャードの書き込みは、prepare で intent になり、決着した後に本体の表へ適用する。intent は本体にないので、SQLite の UNIQUE は
// ほかの取引の未確定の値を知らない。prepare で見逃すと、確定済みの取引が、適用のときに UNIQUE に違反し、永久に適用できない。
//
// 実装 (src/shard/core.ts の uniquePending と、prepare の試適用): prepare は、この取引の書き込みが、次の 2 つの状態のどちらでも
// UNIQUE を破らないことを SQLite に確かめさせる。
//   (a) 本体の行だけの状態
//   (b) ほかの取引の intent を、すべて適用した状態
// 論法: この取引の行と衝突し得るのは、ほかの行の最後の値である。ほかの行の値は、本体の版か、その行の intent の版 (行ごとに 1 つ)
// のどちらかになる。両方の状態で通れば、どの intent が確定しても、どれが中止されても衝突しない。
// 片方だけでは足りない。(a) だけだと、ほかの取引が同じ値を書く intent を見逃す。(b) だけだと、ほかの取引が消す予定の行の値を
// 空いていると見なし、その取引が中止されると衝突する。
//
// モデルは、行 3 つ、値 2 種類 (0 は行がない)、取引 2 つ。取引は 1 行か 2 行に値を書く (0 は消す)。
// 行ごとに intent は 1 つまで (行ロック)。決着と適用は別の段で、適用の前にほかの取引が prepare できる。
//
// invariant:
//   committedApplies: 確定した取引の適用が、UNIQUE を破らない
module m16_core {
  const CHECK_BODY: bool       // (a) を確かめる
  const CHECK_INTENTS: bool    // (b) を確かめる

  pure val ROWS = Set(1, 2, 3)
  pure val VALS = Set(0, 1, 2)
  pure val TXNS = Set(1, 2)

  var body: int -> int              // 行 -> 値 (0 は行がない)
  var intents: int -> (int -> int)  // 取引 -> (行 -> 書いた後の値)
  var status: int -> str            // "idle" | "pending" | "committed" | "aborted" | "applied"
  var broken: bool                  // ghost: 適用で UNIQUE を破った

  pure def unique(m: int -> int): bool =
    ROWS.forall(a => ROWS.forall(b => a == b or m.get(a) == 0 or m.get(a) != m.get(b)))
  pure def overlay(base: int -> int, w: int -> int): int -> int =
    ROWS.mapBy(r => if (w.keys().contains(r)) w.get(r) else base.get(r))

  /** 本体にまだ入っていない intent を持つ取引 (未決着と、確定したが未適用)。 */
  def holders(t: int): Set[int] = TXNS.filter(u => u != t and Set("pending", "committed").contains(status.get(u)))
  def othersApplied(t: int): int -> int = holders(t).fold(body, (m, u) => overlay(m, intents.get(u)))
  def lockedRows(t: int): Set[int] = holders(t).map(u => intents.get(u).keys()).flatten()

  pure val WRITES: Set[int -> int] =
    ROWS.powerset().filter(s => s.size() >= 1 and s.size() <= 2).map(s => s.setOfMaps(VALS)).flatten()

  action init = {
    nondet b = ROWS.setOfMaps(VALS).filter(m => unique(m)).oneOf()
    all { body' = b, intents' = TXNS.mapBy(_ => Map()), status' = TXNS.mapBy(_ => "idle"), broken' = false }
  }

  action prepare(t: int, w: int -> int): bool = all {
    status.get(t) == "idle",
    w.keys().intersect(lockedRows(t)) == Set(),
    not(CHECK_BODY) or unique(overlay(body, w)),
    not(CHECK_INTENTS) or unique(overlay(othersApplied(t), w)),
    intents' = intents.set(t, w), status' = status.set(t, "pending"), body' = body, broken' = broken,
  }

  action decide(t: int, commit: bool): bool = all {
    status.get(t) == "pending",
    status' = status.set(t, if (commit) "committed" else "aborted"),
    intents' = if (commit) intents else intents.set(t, Map()),
    body' = body, broken' = broken,
  }

  action apply(t: int): bool = all {
    status.get(t) == "committed",
    val after = overlay(body, intents.get(t))
    all {
      body' = after, broken' = (broken or not(unique(after))),
      status' = status.set(t, "applied"), intents' = intents.set(t, Map()),
    },
  }

  action step = {
    nondet t = TXNS.oneOf()
    nondet w = WRITES.oneOf()
    nondet c = Set(true, false).oneOf()
    any { prepare(t, w), decide(t, c), apply(t) }
  }

  val committedApplies = not(broken)
  /** 到達できることの確かめ: 2 つの取引がどちらも確定して適用された。 */
  val witnessBothApplied = not(TXNS.forall(t => status.get(t) == "applied"))
}

module m16_green {
  import m16_core(CHECK_BODY = true, CHECK_INTENTS = true).*
}
module m16_red_body_only {
  import m16_core(CHECK_BODY = true, CHECK_INTENTS = false).*
  // 取引 1 が行 1 に値 1 を書く intent を置く。取引 2 は本体だけを見て、行 2 に値 1 を書く。両方が確定する。
  run counterexampleTest =
    init.then(all { body' = Map(1 -> 0, 2 -> 0, 3 -> 0), intents' = intents, status' = status, broken' = broken })
        .then(prepare(1, Map(1 -> 1))).then(prepare(2, Map(2 -> 1)))
        .then(decide(1, true)).then(decide(2, true)).then(apply(1)).then(apply(2))
        .expect(broken)
}
module m16_red_intents_only {
  import m16_core(CHECK_BODY = false, CHECK_INTENTS = true).*
  // 本体の行 1 が値 1 を持つ。取引 1 が行 1 を消す intent を置く。取引 2 は、取引 1 が確定した状態だけを見て、行 2 に値 1 を書く。
  // 取引 1 が中止され、取引 2 が確定する。
  run counterexampleTest =
    init.then(all { body' = Map(1 -> 1, 2 -> 0, 3 -> 0), intents' = intents, status' = status, broken' = broken })
        .then(prepare(1, Map(1 -> 0))).then(prepare(2, Map(2 -> 1)))
        .then(decide(1, false)).then(decide(2, true)).then(apply(2))
        .expect(broken)
}
