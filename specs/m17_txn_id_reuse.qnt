// M17: 同じ取引の ID を持つ 2 つの続きがあっても、確定と答えた書き込みは必ず適用される (不変条件 12)
//
// 対話的な取引の状態は baton で運ぶ。baton は署名されているが使い捨てではないので、同じ baton から 2 つの続きを作れる
// (HTTP の再送でも起き得る)。2 つの続きは同じ取引の ID を持ち、違う書き込みを持つ。
//
// 2026-11-12 までの実装では、anchor は ID だけで決着を覚え、2 つ目の COMMIT に 1 つ目の結果を返した。参加者は、同じ ID の
// prepare が 2 回来ると、後のほうの書き込みを捨てた (test/baton-reuse.test.ts)。2026-11-12 の修正は、確定の記録と intent に
// その続きの書き込みの指紋を持たせ、指紋の違う prepare と COMMIT を断った (CHECK_PREPARE と CHECK_COMMIT)。
//
// その後 (2026-11-13、Codex の指摘 C1)、断った続きの中止が、ID だけで参加者の intent を消すことが分かった。2 つの続きが同時に
// COMMIT すると、続き 2 は続き 1 の intent に当たって断られ、中止を決めて全部の参加者に abort(ID) を送る。参加者は、その ID の
// intent を、どちらの続きのものかを見ずに消す。続き 1 は確定と聞いたのに、phase 2 が届く前に intent が消えた参加者には、
// 書き込みが入らない。前のモデルは、断られた続きが intent に触れないとしていたので、これを見なかった。
//
// 決めた設計 (2026-11-13): 2PC を識別する ID を「取引の ID と、続きの中身の指紋」にする (BY_ATTEMPT)。2 つの続きは別々の
// 2PC になり、確定の記録も、intent も、abort も、続きごとに分かれる。同じ中身の再送は同じ ID なので、同じ答えになる。
// 2 つの続きが同じ行を書けば、片方の prepare は、ほかの取引の intent との普通の競合で断られる。
//
// モデルは、参加者 2 つ、続き 2 つ (それぞれ両方の参加者に、続きごとに違う値を書く)。COMMIT は、記録を確かめて始める段、
// 参加者ごとの prepare、確定か中止を決める段に分け、2 つの続きの段が自由に混ざる。中止は、送る abort が参加者に届いた
// 後の状態に、すぐに進める (phase 2 より先に届く、いちばん悪い順序)。
//
// invariant:
//   noLostAck: 確定と答えた続きの書き込みは、intent が残っていなければ、全部の参加者で適用されている
//   noForeignApply: 参加者に適用された値は、確定した続きのものだけである
module m17_core {
  const BY_ATTEMPT: bool      // 2PC の ID が、続きごとに違う (取引の ID と中身の指紋)
  const CHECK_PREPARE: bool   // 参加者が、同じ ID で指紋の違う prepare を断る (BY_ATTEMPT では、ほかの取引の intent との競合として断る)
  const CHECK_COMMIT: bool    // anchor が、同じ ID で指紋の違う COMMIT を断る

  pure val PARTS = Set(1, 2)
  pure val CONTS = Set(1, 2)       // 続き。続き k は、どの参加者にも値 k を書く

  /** 確定の記録の鍵。BY_ATTEMPT なら続きごと、そうでなければ取引の ID に 1 つ (0)。 */
  pure def keyOf(k: int): int = if (BY_ATTEMPT) k else 0
  pure val KEYS = if (BY_ATTEMPT) CONTS else Set(0)

  var intent: int -> int           // 参加者 -> intent を置いた続き (0 はない)
  var rec: int -> int              // 記録の鍵 -> 決着 (0 はまだ、k > 0 は続き k が確定、-1 は中止)
  var started: int -> bool         // 続き -> COMMIT を始めた (記録がなかった)
  var told: int -> str             // 続き -> クライアントに返した答え ("" | "committed" | "refused" | "error")
  var applied: int -> int          // 参加者 -> 適用した値 (0 はまだ)

  action init = all {
    intent' = PARTS.mapBy(_ => 0), rec' = KEYS.mapBy(_ => 0), started' = CONTS.mapBy(_ => false),
    told' = CONTS.mapBy(_ => ""), applied' = PARTS.mapBy(_ => 0),
  }

  /** 続き k の COMMIT が anchor に届く。記録があれば、prepare を送らずに答える (CHECK_COMMIT なら、指紋の違う続きを断る)。 */
  action begin(k: int): bool = all {
    told.get(k) == "", not(started.get(k)),
    val r = rec.get(keyOf(k))
    if (r == 0) all { started' = started.set(k, true), told' = told }
    else all {
      started' = started,
      told' = told.set(k, if (r > 0 and (r == k or not(CHECK_COMMIT))) "committed" else "refused"),
    },
    intent' = intent, rec' = rec, applied' = applied,
  }

  /** 続き k の prepare が参加者 p に届く。別の続きの intent があれば、CHECK_PREPARE なら断る (何もしない)、なければ ok と答える。 */
  action prepare(k: int, p: int): bool = all {
    started.get(k), told.get(k) == "", applied.get(p) == 0, intent.get(p) == 0,
    intent' = intent.set(p, k),
    rec' = rec, started' = started, told' = told, applied' = applied,
  }

  /** 参加者 p が、続き k の prepare に ok と答えたか。 */
  def acked(k: int, p: int): bool = intent.get(p) == k or (not(CHECK_PREPARE) and not(BY_ATTEMPT) and intent.get(p) != 0)
  /** 参加者 p が、続き k の prepare を断ったか (別の続きの intent がある)。 */
  def refused(k: int, p: int): bool = intent.get(p) != 0 and not(acked(k, p))

  /** 全部の参加者が ok と答えたので、確定を記録する。記録がもうあれば (別の続きの決着)、記録の INSERT が失敗して誤りを返す。 */
  action decideCommit(k: int): bool = all {
    started.get(k), told.get(k) == "", PARTS.forall(p => acked(k, p)),
    val key = keyOf(k)
    if (rec.get(key) == 0) all { rec' = rec.set(key, k), told' = told.set(k, "committed") }
    else all { rec' = rec, told' = told.set(k, "error") },
    intent' = intent, started' = started, applied' = applied,
  }

  /**
   * 断った参加者があるので、中止を決める (decideAbort)。記録は INSERT OR IGNORE なので、別の続きの確定があれば残る。
   * そのうえで、全部の参加者に abort(ID) を送る。参加者は、その ID の intent を消す。BY_ATTEMPT でなければ、ID は続きに
   * よらないので、別の続きの intent も消える。
   */
  action decideAbort(k: int): bool = all {
    started.get(k), told.get(k) == "", PARTS.exists(p => refused(k, p)),
    val key = keyOf(k)
    rec' = if (rec.get(key) == 0) rec.set(key, -1) else rec,
    told' = told.set(k, "refused"),
    intent' = PARTS.mapBy(p => if (intent.get(p) != 0 and (not(BY_ATTEMPT) or intent.get(p) == k)) 0 else intent.get(p)),
    started' = started, applied' = applied,
  }

  /** 参加者 p が、intent の決着を anchor に照会し、確定なら適用し、中止なら消す (phase 2 と redrive)。 */
  action resolve(p: int): bool = all {
    val j = intent.get(p)
    val r = rec.get(keyOf(j))
    all {
      j != 0, applied.get(p) == 0, r != 0,
      if (r > 0) all { applied' = applied.set(p, j), intent' = intent.set(p, 0) }
      else all { applied' = applied, intent' = intent.set(p, 0) },
    },
    rec' = rec, started' = started, told' = told,
  }

  action step = {
    nondet k = CONTS.oneOf()
    nondet p = PARTS.oneOf()
    any { begin(k), prepare(k, p), decideCommit(k), decideAbort(k), resolve(p) }
  }

  def quiet: bool = PARTS.forall(p => intent.get(p) == 0)
  val noLostAck = quiet implies CONTS.forall(k => told.get(k) == "committed" implies PARTS.forall(p => applied.get(p) == k))
  val noForeignApply = PARTS.forall(p => applied.get(p) == 0 or rec.get(keyOf(applied.get(p))) == applied.get(p))
  val safe = noLostAck and noForeignApply
  /** 到達できることの確かめ: 1 つの続きが確定し、もう 1 つは断られ、全部の参加者が適用した。 */
  val witnessOneCommittedOneRefused = not(quiet and PARTS.forall(p => applied.get(p) != 0)
    and CONTS.exists(k => told.get(k) == "committed") and CONTS.exists(k => told.get(k) == "refused"))
  /** 到達できることの確かめ: 2 つの続きが同時に COMMIT を始め、片方が確定した。 */
  val witnessConcurrent = not(CONTS.forall(k => started.get(k)) and CONTS.exists(k => told.get(k) == "committed"))
}

module m17_green {
  // 決めた設計: 2PC の ID は続きごとに違う。anchor と参加者の指紋の確かめは要らない。
  import m17_core(BY_ATTEMPT = true, CHECK_PREPARE = true, CHECK_COMMIT = false).*
}
module m17_red_abort {
  // 2026-11-12 の修正: 指紋を両方で確かめるが、ID は取引の ID のまま。断られた続きの中止が、確定した続きの intent を消す。
  import m17_core(BY_ATTEMPT = false, CHECK_PREPARE = true, CHECK_COMMIT = true).*
  run counterexampleTest =
    init.then(begin(1)).then(begin(2)).then(prepare(1, 1)).then(prepare(1, 2))
        .then(decideCommit(1)).then(decideAbort(2))
        .expect(told.get(1) == "committed" and quiet and not(noLostAck))
}
module m17_red_impl {
  // 2026-11-12 より前の実装: どちらも確かめない。
  import m17_core(BY_ATTEMPT = false, CHECK_PREPARE = false, CHECK_COMMIT = false).*
}
module m17_red_prepare_only {
  // 参加者は確かめるが、anchor は確かめない。続き 2 の COMMIT は、prepare を経ずに続き 1 の結果 (確定) を返される。
  import m17_core(BY_ATTEMPT = false, CHECK_PREPARE = true, CHECK_COMMIT = false).*
}
module m17_red_commit_only {
  // anchor は確かめるが、参加者は確かめない。続き 2 の intent が先に参加者に置かれると、続き 1 の確定がそれを適用する。
  import m17_core(BY_ATTEMPT = false, CHECK_PREPARE = false, CHECK_COMMIT = true).*
}
