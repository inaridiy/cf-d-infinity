// M17: 同じ取引の ID を持つ 2 つの続きがあっても、確定と答えた書き込みは必ず適用される (不変条件 12)
//
// 対話的な取引の状態は baton で運ぶ。baton は署名されているが使い捨てではないので、同じ baton から 2 つの続きを作れる
// (HTTP の再送でも起き得る)。2 つの続きは同じ取引の ID を持ち、違う書き込みを持つ。2026-11 までの実装では、anchor は ID だけで
// 決着を覚え、2 つ目の COMMIT に 1 つ目の結果を返した。参加者は、同じ ID の prepare が 2 回来ると、後のほうの書き込みを捨てた。
// 2 つ目の続きは「確定した」と聞くが、その書き込みは入らない (test/open/baton-reuse.test.ts)。
//
// 決めた設計 (2026-11-13): 確定の記録と intent に、その続きの書き込みの指紋を持たせる。
//   - 参加者は、同じ ID の intent があり、指紋が違う prepare を断る。
//   - anchor は、同じ ID の決着があり、指紋が違う COMMIT を断る (競合として返す)。指紋が同じ COMMIT は、同じ結果を返す (再送)。
//
// モデルは、参加者 2 つ、続き 2 つ (それぞれ両方の参加者に、続きごとに違う値を書く)。prepare、決着、適用は自由な順に起きる。
//
// invariant:
//   noLostAck: 確定と答えた続きの書き込みは、全部の参加者で適用されている (適用が済んだ後)
//   noForeignApply: 参加者に適用された値は、確定した続きのものだけである
module m17_core {
  const CHECK_PREPARE: bool   // 参加者が、同じ ID で指紋の違う prepare を断る
  const CHECK_COMMIT: bool    // anchor が、同じ ID で指紋の違う COMMIT を断る

  pure val PARTS = Set(1, 2)
  pure val CONTS = Set(1, 2)       // 続き。続き k は、どの参加者にも値 k を書く

  var intent: int -> int           // 参加者 -> intent を置いた続き (0 はない)
  var decided: int                 // anchor が確定と決めた続き (0 はまだ、-1 は中止)
  var told: int -> str             // 続き -> クライアントに返した答え ("" | "committed" | "refused")
  var applied: int -> int          // 参加者 -> 適用した値 (0 はまだ)

  action init = all {
    intent' = PARTS.mapBy(_ => 0), decided' = 0, told' = CONTS.mapBy(_ => ""), applied' = PARTS.mapBy(_ => 0),
  }

  /** 続き k の prepare が参加者 p に届く。 */
  action prepare(k: int, p: int): bool = all {
    told.get(k) == "",
    applied.get(p) == 0,
    if (intent.get(p) == 0) intent' = intent.set(p, k)
    else if (intent.get(p) == k) intent' = intent
    // 同じ ID の intent がもうある。指紋を確かめなければ、前の intent を残して ok と答える (後の書き込みを捨てる)。
    else if (CHECK_PREPARE) all { false, intent' = intent }
    else intent' = intent,
    decided' = decided, told' = told, applied' = applied,
  }

  /** prepare が断られて、続き k が断られたと聞く。 */
  action refusedAtPrepare(k: int, p: int): bool = all {
    CHECK_PREPARE, told.get(k) == "", intent.get(p) != 0, intent.get(p) != k,
    told' = told.set(k, "refused"), intent' = intent, decided' = decided, applied' = applied,
  }

  /**
   * 続き k の COMMIT が anchor に届く。同じ ID の決着がもうあれば、実装の anchor は参加者に prepare を送らずに、覚えている結果を返す
   * (指紋を確かめるなら、違う続きの COMMIT を断る)。決着がまだなら、全部の参加者が、この続きの prepare に ok と答えたときに確定する。
   */
  action commit(k: int): bool = all {
    told.get(k) == "",
    if (decided != 0) all {
      decided' = decided,
      told' = told.set(k, if (decided == k or not(CHECK_COMMIT)) "committed" else "refused"),
    } else all {
      PARTS.forall(p => intent.get(p) != 0),
      // 指紋を確かめない参加者は、別の続きの intent でも ok と答えている。確かめる参加者は、この続きの intent のときだけ ok と答える。
      CHECK_PREPARE implies PARTS.forall(p => intent.get(p) == k),
      decided' = k, told' = told.set(k, "committed"),
    },
    intent' = intent, applied' = applied,
  }

  /** 参加者 p が、決着した取引の intent を適用する。 */
  action apply(p: int): bool = all {
    decided > 0, intent.get(p) != 0, applied.get(p) == 0,
    applied' = applied.set(p, intent.get(p)),
    intent' = intent, decided' = decided, told' = told,
  }

  action step = {
    nondet k = CONTS.oneOf()
    nondet p = PARTS.oneOf()
    any { prepare(k, p), refusedAtPrepare(k, p), commit(k), apply(p) }
  }

  def settled: bool = PARTS.forall(p => applied.get(p) != 0)
  val noLostAck = settled implies CONTS.forall(k => told.get(k) == "committed" implies PARTS.forall(p => applied.get(p) == k))
  val noForeignApply = PARTS.forall(p => applied.get(p) == 0 or (decided > 0 and applied.get(p) == decided))
  val safe = noLostAck and noForeignApply
  /** 到達できることの確かめ: 1 つの続きが確定し、もう 1 つは断られ、全部の参加者が適用した。 */
  val witnessOneCommittedOneRefused = not(settled and CONTS.exists(k => told.get(k) == "committed") and CONTS.exists(k => told.get(k) == "refused"))
}

module m17_green {
  import m17_core(CHECK_PREPARE = true, CHECK_COMMIT = true).*
}
module m17_red_impl {
  // 2026-11 までの実装: どちらも確かめない。
  import m17_core(CHECK_PREPARE = false, CHECK_COMMIT = false).*
  // 続き 1 が両方の参加者に prepare し、確定する。続き 2 の prepare は前の intent を残して ok と答えられ、COMMIT も確定と聞く。
  run counterexampleTest =
    init.then(prepare(1, 1)).then(prepare(1, 2)).then(commit(1))
        .then(prepare(2, 1)).then(prepare(2, 2)).then(commit(2))
        .then(apply(1)).then(apply(2))
        .expect(told.get(2) == "committed" and not(noLostAck))
}
module m17_red_prepare_only {
  // 参加者は確かめるが、anchor は確かめない。続き 2 の COMMIT は、prepare を経ずに続き 1 の結果 (確定) を返される。
  import m17_core(CHECK_PREPARE = true, CHECK_COMMIT = false).*
}
module m17_red_commit_only {
  // anchor は確かめるが、参加者は確かめない。続き 2 の intent が先に参加者に置かれると、続き 1 の確定がそれを適用する。
  import m17_core(CHECK_PREPARE = false, CHECK_COMMIT = true).*
}
