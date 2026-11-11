// M15: 表定義の変更とシャードの分割の順序 (不変条件 4)
//
// 分割の間、親と子は DDL を適用しない (運ぶ行と intent の形が、受け取る側の表と合わなくなるからである)。だから、分割の途中に
// 新しい版が記録されると、その版で計画した要求を、親と子が分割の終わりまで断り続ける (test/open/ddl-vs-split-race.test.ts)。
// 子は、行のグループが届いたときにだけ親の版へ追いつく。ところが要求は、グループを取りに行く前に版を確かめる。だから、子が
// 親より古い版で受け取り始めると、子へ移った行を、背景の運び出しが届くまで読めない (test/open/child-behind-parent.test.ts)。
//
// 決めた設計 (2026-11-11): Meta が「保守の操作の枠」を持つ。
//   - 分割は、全シャードが最新の版を適用した後で、Meta から枠を取る (basedOn)。枠は分割どうしでは共有でき、DDL とは排他である。
//   - 分割は、枠を取ったときに Meta が返す版を使う (子が受け取り始める版、親が fence の前に追いつく版)。
//   - DDL (index の作成と DROP の前の禁止を含む) は、分割が枠を持つ間は記録しない。
//   - 枠は、子が範囲を受け取り終えた後で返す。
//
// モデルは、親 P、子 C、分割に関わらないシャード T。T は最新の版の適用に失敗することがあり、そのときは取り消しの版を記録する
// (実装の schemaFailed と revokeDdl)。要求は、いつでも Meta の最新の版で計画され、行の持ち主へ送られる。
//
// invariant:
//   servable: 分割の間も、Meta の最新の版で計画した要求を、行の持ち主が版の理由で断らない
module m15_core {
  const SLOT: bool            // DDL は、分割が枠を持つ間は記録しない
  const FRESH_BEGIN: bool     // 分割は、枠を取ったときの Meta の版を使う (false なら、その前に読んだ版)
  const RELEASE_AT_END: bool  // 枠は、子が受け取り終えた後で返す (false なら、範囲表を切り替えた直後に返す)
  const BASED_ON: bool        // 枠は、全シャードが最新の版を適用した後でだけ取れる

  pure val MAXV = 3

  var meta: int
  var failing: bool       // 最新の版が、T での適用に失敗する
  var pv: int
  var cv: int
  var tv: int
  // 0 分割の前、1 枠を取った、2 子が受け取り始めた、3 親が fence した、4 範囲表を切り替えた、5 子が受け取り終えた
  var phase: int
  var sv: int             // 分割の版
  var readV: int          // 分割を進める側が、枠を取る前に読んだ版
  var arrived: bool       // グループが子に届いた
  var refused: bool       // ghost

  action init = all {
    meta' = 0, failing' = false, pv' = 0, cv' = 0, tv' = 0, phase' = 0, sv' = 0, readV' = -1, arrived' = false, refused' = false,
  }

  /** 枠を、分割が持っているか。 */
  def held: bool = if (RELEASE_AT_END) (phase >= 1 and phase <= 4) else (phase >= 1 and phase <= 3)
  def parentMoving: bool = phase >= 3 and phase <= 4
  def childMoving: bool = phase >= 2 and phase <= 4

  /** DDL を記録する。最新の版を、全シャードが適用した後でだけ (Db.record の basedOn)。 */
  action record = all {
    // 範囲表にあるシャードが、最新の版を全部適用している。子が範囲表に入るのは、分割が終わった後である。
    meta < MAXV, pv == meta, tv == meta, (phase == 5) implies (cv == meta),
    not(SLOT) or not(held),
    nondet f = oneOf(Set(true, false))
    all {
      meta' = meta + 1, failing' = f,
      pv' = pv, cv' = cv, tv' = tv, phase' = phase, sv' = sv, readV' = readV, arrived' = arrived, refused' = refused,
    }
  }

  /** 親が次の版を適用する。移動の途中は適用しない。 */
  action applyP = all {
    pv < meta, not(parentMoving),
    pv' = pv + 1,
    meta' = meta, failing' = failing, cv' = cv, tv' = tv, phase' = phase, sv' = sv, readV' = readV, arrived' = arrived, refused' = refused,
  }
  /** 子が次の版を適用する。受け取りの途中は、グループが届いたとき (arrive) にだけ追いつく。 */
  action applyC = all {
    cv < meta, not(childMoving), phase != 1,
    cv' = cv + 1,
    meta' = meta, failing' = failing, pv' = pv, tv' = tv, phase' = phase, sv' = sv, readV' = readV, arrived' = arrived, refused' = refused,
  }
  /** T が次の版を適用する。最新の版に失敗すると、取り消しの版を記録する (枠を確かめない)。 */
  action applyT = all {
    tv < meta,
    if (failing and tv == meta - 1 and meta < MAXV) all {
      meta' = meta + 1, failing' = false, tv' = tv,
      pv' = pv, cv' = cv, phase' = phase, sv' = sv, readV' = readV, arrived' = arrived, refused' = refused,
    } else all {
      tv' = tv + 1,
      meta' = meta, failing' = failing, pv' = pv, cv' = cv, phase' = phase, sv' = sv, readV' = readV, arrived' = arrived, refused' = refused,
    },
  }

  // ---- 分割 ----
  /** 分割を進める側が、表定義を読む (枠を取る前)。 */
  action readCatalog = all {
    phase == 0, readV < 0,
    readV' = meta,
    meta' = meta, failing' = failing, pv' = pv, cv' = cv, tv' = tv, phase' = phase, sv' = sv, arrived' = arrived, refused' = refused,
  }
  /** Meta から枠を取る。 */
  action reserve = all {
    phase == 0, readV >= 0,
    not(BASED_ON) or (pv == meta and tv == meta),
    phase' = 1, sv' = if (FRESH_BEGIN) meta else readV,
    meta' = meta, failing' = failing, pv' = pv, cv' = cv, tv' = tv, readV' = readV, arrived' = arrived, refused' = refused,
  }
  /** 子が、分割の版で受け取り始める (子はその版まで進む)。 */
  action beginIncoming = all {
    phase == 1, sv <= meta,
    cv' = if (cv > sv) cv else sv, phase' = 2,
    meta' = meta, failing' = failing, pv' = pv, tv' = tv, sv' = sv, readV' = readV, arrived' = arrived, refused' = refused,
  }
  /** 親が、子の版まで追いついてから fence する。 */
  action fence = all {
    phase == 2,
    pv' = if (pv > cv) pv else cv, phase' = 3,
    meta' = meta, failing' = failing, cv' = cv, tv' = tv, sv' = sv, readV' = readV, arrived' = arrived, refused' = refused,
  }
  action switchRange = all {
    phase == 3,
    phase' = 4,
    meta' = meta, failing' = failing, pv' = pv, cv' = cv, tv' = tv, sv' = sv, readV' = readV, arrived' = arrived, refused' = refused,
  }
  /** グループが子に届く (取りに行った要求か、背景の運び出し)。子は、親の版まで追いつく。 */
  action arrive = all {
    phase == 4, not(arrived),
    arrived' = true, cv' = if (pv > cv) pv else cv,
    meta' = meta, failing' = failing, pv' = pv, tv' = tv, phase' = phase, sv' = sv, readV' = readV, refused' = refused,
  }
  /** 子が受け取り終え、枠を返す。 */
  action finish = all {
    phase == 4, arrived,
    phase' = 5,
    meta' = meta, failing' = failing, pv' = pv, cv' = cv, tv' = tv, sv' = sv, readV' = readV, arrived' = arrived, refused' = refused,
  }

  /**
   * Meta の最新の版で計画した要求が、行の持ち主に届く。持ち主は、先に版を確かめる (グループを取りに行くのは、その後)。
   * 持ち主が自分より新しい版を求められたとき、移動の途中でなければ適用して答える。移動の途中なら断る。
   */
  action request = all {
    phase >= 1 and phase <= 4,
    val ownerV = if (phase >= 4) cv else pv
    val moving = if (phase >= 4) childMoving else parentMoving
    all {
      refused' = (refused or (ownerV < meta and moving)),
      meta' = meta, failing' = failing, pv' = pv, cv' = cv, tv' = tv, phase' = phase, sv' = sv, readV' = readV, arrived' = arrived,
    },
  }

  action step = any { record, applyP, applyC, applyT, readCatalog, reserve, beginIncoming, fence, switchRange, arrive, finish, request }

  val servable = not(refused)
  val witnessSplitDone = not(phase == 5 and meta > 0)
  val witnessRecordedBeforeAndServed = not(phase == 5 and sv > 0 and arrived)
}

module m15_green {
  import m15_core(SLOT = true, FRESH_BEGIN = true, RELEASE_AT_END = true, BASED_ON = true).*
}
// 2026-11 までの実装。分割の途中かを確かめてから記録するが、確かめと記録が原子的でない (枠がない)。
module m15_red_no_slot {
  import m15_core(SLOT = false, FRESH_BEGIN = true, RELEASE_AT_END = true, BASED_ON = true).*
}
// 分割が、枠を取る前に読んだ版を使う。間に記録された版を親が先に適用し、子は古い版のまま受け取る。
module m15_red_stale_begin {
  import m15_core(SLOT = true, FRESH_BEGIN = false, RELEASE_AT_END = true, BASED_ON = true).*
}
// 枠を、範囲表の切り替えの直後に返す。子が受け取り終える前に、新しい版が記録される。
module m15_red_early_release {
  import m15_core(SLOT = true, FRESH_BEGIN = true, RELEASE_AT_END = false, BASED_ON = true).*
}
// 全シャードが最新の版を適用する前に枠を取る。分割の途中に、別のシャードが失敗した版を取り消す。
module m15_red_no_based_on {
  import m15_core(SLOT = true, FRESH_BEGIN = true, RELEASE_AT_END = true, BASED_ON = false).*
}
