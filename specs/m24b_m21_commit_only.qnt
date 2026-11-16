// M24b: 決めたこと 6 の確かめ直し。M21 の場面と赤を、表定義の epoch を commit だけで進める形で流す
//
// M24 (specs/m24_table_epochs.qnt) の一部である。M21 の本体を読み込むので、M24 の検査のたびに M21 を読まないよう、ファイルを分けた。
//
// ---- 決めたこと 6 の確かめ直し: M21 の場面と赤を、epoch を commit だけで進める形で ------------------
//
// M21 の本体 (m21_core) を、M21 のインスタンスと同じ定数で、SCHEMA_ON_PREPARE だけを false にして使う。M21 のファイルは
// 変えない (test/catalog-m21.test.ts が、その sha256 を確かめている)。表は 1 つなので、表ごとの epoch は、表定義全体の epoch と同じである。
// 緑は epochSafeCommitOnly (noServeBelowAck を除く M21 の不変条件) を、赤は M21 の赤と同じ不変条件 (noServeBelowAck を除く) を確かめる。
// index の作成と行で失敗し得る DDL の場面は、M21 の m21_alt_commit_only_build と _check がある。
// run の試験は写していない (M21 の run は、どの記録でも進む形の期待を書いている)。
module m24_m21_green_ddl2 {
  import m21_core(HAS_BUILD = true, HAS_CHECK = true, HAS_DROP = false, HAS_SPLIT = false, NTXN = 1, FIXED_INIT = false,
    REJECT_STALE = true, RECHECK = true, FENCE = true, DRAIN = true, CHECK_AT_EPOCH = true, GUARD_CHECK = true,
    ALL_ACKS = true, ONE_EXIT = true, ONE_OPEN = true, PIN = true, BUILD_VISIBLE = false,
    DDL_WAITS_MOVE = true, MOVE_WAITS_DDL = true, END_AFTER_DRAIN = true, PULL_AT_EPOCH = true, FENCE_IS_EPOCH = true, OWNER_CHECK = 0,
    SCHEMA_ON_PREPARE = false).* from "./m21_catalog_epoch"
}
module m24_m21_green_drop {
  import m21_core(HAS_BUILD = false, HAS_CHECK = false, HAS_DROP = true, HAS_SPLIT = false, NTXN = 2, FIXED_INIT = false,
    REJECT_STALE = true, RECHECK = true, FENCE = true, DRAIN = true, CHECK_AT_EPOCH = true, GUARD_CHECK = true,
    ALL_ACKS = true, ONE_EXIT = true, ONE_OPEN = true, PIN = true, BUILD_VISIBLE = false,
    DDL_WAITS_MOVE = true, MOVE_WAITS_DDL = true, END_AFTER_DRAIN = true, PULL_AT_EPOCH = true, FENCE_IS_EPOCH = true, OWNER_CHECK = 0,
    SCHEMA_ON_PREPARE = false).* from "./m21_catalog_epoch"
}
module m24_m21_green_split {
  import m21_core(HAS_BUILD = false, HAS_CHECK = true, HAS_DROP = false, HAS_SPLIT = true, NTXN = 1, FIXED_INIT = true,
    REJECT_STALE = true, RECHECK = true, FENCE = true, DRAIN = true, CHECK_AT_EPOCH = true, GUARD_CHECK = true,
    ALL_ACKS = true, ONE_EXIT = true, ONE_OPEN = true, PIN = true, BUILD_VISIBLE = false,
    DDL_WAITS_MOVE = true, MOVE_WAITS_DDL = true, END_AFTER_DRAIN = true, PULL_AT_EPOCH = true, FENCE_IS_EPOCH = true, OWNER_CHECK = 0,
    SCHEMA_ON_PREPARE = false).* from "./m21_catalog_epoch"
}
module m24_m21_green_split_txns {
  import m21_core(HAS_BUILD = false, HAS_CHECK = false, HAS_DROP = false, HAS_SPLIT = true, NTXN = 2, FIXED_INIT = true,
    REJECT_STALE = true, RECHECK = true, FENCE = true, DRAIN = true, CHECK_AT_EPOCH = true, GUARD_CHECK = true,
    ALL_ACKS = true, ONE_EXIT = true, ONE_OPEN = true, PIN = true, BUILD_VISIBLE = false,
    DDL_WAITS_MOVE = true, MOVE_WAITS_DDL = true, END_AFTER_DRAIN = true, PULL_AT_EPOCH = true, FENCE_IS_EPOCH = true, OWNER_CHECK = 0,
    SCHEMA_ON_PREPARE = false).* from "./m21_catalog_epoch"
}
module m24_m21_green_split_build {
  import m21_core(HAS_BUILD = true, HAS_CHECK = false, HAS_DROP = false, HAS_SPLIT = true, NTXN = 1, FIXED_INIT = false,
    REJECT_STALE = true, RECHECK = true, FENCE = true, DRAIN = true, CHECK_AT_EPOCH = true, GUARD_CHECK = true,
    ALL_ACKS = true, ONE_EXIT = true, ONE_OPEN = true, PIN = true, BUILD_VISIBLE = false,
    DDL_WAITS_MOVE = true, MOVE_WAITS_DDL = true, END_AFTER_DRAIN = true, PULL_AT_EPOCH = true, FENCE_IS_EPOCH = true, OWNER_CHECK = 0,
    SCHEMA_ON_PREPARE = false).* from "./m21_catalog_epoch"
}
module m24_m21_red_online {
  import m21_core(HAS_BUILD = true, HAS_CHECK = false, HAS_DROP = false, HAS_SPLIT = false, NTXN = 2, FIXED_INIT = false,
    REJECT_STALE = true, RECHECK = true, FENCE = false, DRAIN = true, CHECK_AT_EPOCH = true, GUARD_CHECK = true,
    ALL_ACKS = true, ONE_EXIT = true, ONE_OPEN = true, PIN = true, BUILD_VISIBLE = true,
    DDL_WAITS_MOVE = true, MOVE_WAITS_DDL = true, END_AFTER_DRAIN = true, PULL_AT_EPOCH = true, FENCE_IS_EPOCH = true, OWNER_CHECK = 0,
    SCHEMA_ON_PREPARE = false).* from "./m21_catalog_epoch"
}
module m24_m21_red_no_fence {
  import m21_core(HAS_BUILD = true, HAS_CHECK = false, HAS_DROP = false, HAS_SPLIT = false, NTXN = 2, FIXED_INIT = false,
    REJECT_STALE = true, RECHECK = true, FENCE = false, DRAIN = true, CHECK_AT_EPOCH = true, GUARD_CHECK = true,
    ALL_ACKS = true, ONE_EXIT = true, ONE_OPEN = true, PIN = true, BUILD_VISIBLE = false,
    DDL_WAITS_MOVE = true, MOVE_WAITS_DDL = true, END_AFTER_DRAIN = true, PULL_AT_EPOCH = true, FENCE_IS_EPOCH = true, OWNER_CHECK = 0,
    SCHEMA_ON_PREPARE = false).* from "./m21_catalog_epoch"
}
module m24_m21_red_visible {
  import m21_core(HAS_BUILD = true, HAS_CHECK = false, HAS_DROP = false, HAS_SPLIT = false, NTXN = 2, FIXED_INIT = false,
    REJECT_STALE = true, RECHECK = true, FENCE = true, DRAIN = true, CHECK_AT_EPOCH = true, GUARD_CHECK = true,
    ALL_ACKS = true, ONE_EXIT = true, ONE_OPEN = true, PIN = true, BUILD_VISIBLE = true,
    DDL_WAITS_MOVE = true, MOVE_WAITS_DDL = true, END_AFTER_DRAIN = true, PULL_AT_EPOCH = true, FENCE_IS_EPOCH = true, OWNER_CHECK = 0,
    SCHEMA_ON_PREPARE = false).* from "./m21_catalog_epoch"
}
module m24_m21_red_no_drain {
  import m21_core(HAS_BUILD = true, HAS_CHECK = false, HAS_DROP = false, HAS_SPLIT = false, NTXN = 2, FIXED_INIT = false,
    REJECT_STALE = true, RECHECK = true, FENCE = true, DRAIN = false, CHECK_AT_EPOCH = true, GUARD_CHECK = true,
    ALL_ACKS = true, ONE_EXIT = true, ONE_OPEN = true, PIN = true, BUILD_VISIBLE = false,
    DDL_WAITS_MOVE = true, MOVE_WAITS_DDL = true, END_AFTER_DRAIN = true, PULL_AT_EPOCH = true, FENCE_IS_EPOCH = true, OWNER_CHECK = 0,
    SCHEMA_ON_PREPARE = false).* from "./m21_catalog_epoch"
}
module m24_m21_red_stale {
  import m21_core(HAS_BUILD = true, HAS_CHECK = false, HAS_DROP = false, HAS_SPLIT = false, NTXN = 2, FIXED_INIT = false,
    REJECT_STALE = false, RECHECK = true, FENCE = true, DRAIN = true, CHECK_AT_EPOCH = true, GUARD_CHECK = true,
    ALL_ACKS = true, ONE_EXIT = true, ONE_OPEN = true, PIN = true, BUILD_VISIBLE = false,
    DDL_WAITS_MOVE = true, MOVE_WAITS_DDL = true, END_AFTER_DRAIN = true, PULL_AT_EPOCH = true, FENCE_IS_EPOCH = true, OWNER_CHECK = 0,
    SCHEMA_ON_PREPARE = false).* from "./m21_catalog_epoch"
}
module m24_m21_red_two_exits {
  import m21_core(HAS_BUILD = true, HAS_CHECK = false, HAS_DROP = false, HAS_SPLIT = false, NTXN = 2, FIXED_INIT = false,
    REJECT_STALE = true, RECHECK = true, FENCE = true, DRAIN = true, CHECK_AT_EPOCH = true, GUARD_CHECK = true,
    ALL_ACKS = true, ONE_EXIT = false, ONE_OPEN = true, PIN = true, BUILD_VISIBLE = false,
    DDL_WAITS_MOVE = true, MOVE_WAITS_DDL = true, END_AFTER_DRAIN = true, PULL_AT_EPOCH = true, FENCE_IS_EPOCH = true, OWNER_CHECK = 0,
    SCHEMA_ON_PREPARE = false).* from "./m21_catalog_epoch"
}
module m24_m21_red_repin {
  import m21_core(HAS_BUILD = true, HAS_CHECK = false, HAS_DROP = false, HAS_SPLIT = false, NTXN = 2, FIXED_INIT = false,
    REJECT_STALE = true, RECHECK = true, FENCE = true, DRAIN = true, CHECK_AT_EPOCH = true, GUARD_CHECK = true,
    ALL_ACKS = true, ONE_EXIT = true, ONE_OPEN = true, PIN = false, BUILD_VISIBLE = false,
    DDL_WAITS_MOVE = true, MOVE_WAITS_DDL = true, END_AFTER_DRAIN = true, PULL_AT_EPOCH = true, FENCE_IS_EPOCH = true, OWNER_CHECK = 0,
    SCHEMA_ON_PREPARE = false).* from "./m21_catalog_epoch"
}
module m24_m21_red_scan_early {
  import m21_core(HAS_BUILD = true, HAS_CHECK = false, HAS_DROP = false, HAS_SPLIT = false, NTXN = 2, FIXED_INIT = false,
    REJECT_STALE = true, RECHECK = true, FENCE = true, DRAIN = true, CHECK_AT_EPOCH = false, GUARD_CHECK = true,
    ALL_ACKS = true, ONE_EXIT = true, ONE_OPEN = true, PIN = true, BUILD_VISIBLE = false,
    DDL_WAITS_MOVE = true, MOVE_WAITS_DDL = true, END_AFTER_DRAIN = true, PULL_AT_EPOCH = true, FENCE_IS_EPOCH = true, OWNER_CHECK = 0,
    SCHEMA_ON_PREPARE = false).* from "./m21_catalog_epoch"
}
module m24_m21_red_no_recheck {
  import m21_core(HAS_BUILD = true, HAS_CHECK = false, HAS_DROP = false, HAS_SPLIT = false, NTXN = 2, FIXED_INIT = false,
    REJECT_STALE = true, RECHECK = false, FENCE = true, DRAIN = true, CHECK_AT_EPOCH = true, GUARD_CHECK = true,
    ALL_ACKS = true, ONE_EXIT = true, ONE_OPEN = true, PIN = true, BUILD_VISIBLE = false,
    DDL_WAITS_MOVE = true, MOVE_WAITS_DDL = true, END_AFTER_DRAIN = true, PULL_AT_EPOCH = true, FENCE_IS_EPOCH = true, OWNER_CHECK = 0,
    SCHEMA_ON_PREPARE = false).* from "./m21_catalog_epoch"
}
module m24_m21_red_early_commit {
  import m21_core(HAS_BUILD = true, HAS_CHECK = false, HAS_DROP = false, HAS_SPLIT = false, NTXN = 2, FIXED_INIT = false,
    REJECT_STALE = true, RECHECK = true, FENCE = true, DRAIN = true, CHECK_AT_EPOCH = true, GUARD_CHECK = true,
    ALL_ACKS = false, ONE_EXIT = true, ONE_OPEN = true, PIN = true, BUILD_VISIBLE = false,
    DDL_WAITS_MOVE = true, MOVE_WAITS_DDL = true, END_AFTER_DRAIN = true, PULL_AT_EPOCH = true, FENCE_IS_EPOCH = true, OWNER_CHECK = 0,
    SCHEMA_ON_PREPARE = false).* from "./m21_catalog_epoch"
}
module m24_m21_red_trial_no_fence {
  import m21_core(HAS_BUILD = false, HAS_CHECK = true, HAS_DROP = false, HAS_SPLIT = false, NTXN = 2, FIXED_INIT = false,
    REJECT_STALE = true, RECHECK = true, FENCE = false, DRAIN = true, CHECK_AT_EPOCH = true, GUARD_CHECK = true,
    ALL_ACKS = true, ONE_EXIT = true, ONE_OPEN = true, PIN = true, BUILD_VISIBLE = false,
    DDL_WAITS_MOVE = true, MOVE_WAITS_DDL = true, END_AFTER_DRAIN = true, PULL_AT_EPOCH = true, FENCE_IS_EPOCH = true, OWNER_CHECK = 0,
    SCHEMA_ON_PREPARE = false).* from "./m21_catalog_epoch"
}
module m24_m21_red_trial_missing_ack {
  import m21_core(HAS_BUILD = false, HAS_CHECK = true, HAS_DROP = false, HAS_SPLIT = false, NTXN = 2, FIXED_INIT = false,
    REJECT_STALE = true, RECHECK = true, FENCE = true, DRAIN = true, CHECK_AT_EPOCH = true, GUARD_CHECK = true,
    ALL_ACKS = false, ONE_EXIT = true, ONE_OPEN = true, PIN = true, BUILD_VISIBLE = false,
    DDL_WAITS_MOVE = true, MOVE_WAITS_DDL = true, END_AFTER_DRAIN = true, PULL_AT_EPOCH = true, FENCE_IS_EPOCH = true, OWNER_CHECK = 0,
    SCHEMA_ON_PREPARE = false).* from "./m21_catalog_epoch"
}
module m24_m21_red_trial_early {
  import m21_core(HAS_BUILD = false, HAS_CHECK = true, HAS_DROP = false, HAS_SPLIT = false, NTXN = 2, FIXED_INIT = false,
    REJECT_STALE = true, RECHECK = true, FENCE = true, DRAIN = true, CHECK_AT_EPOCH = false, GUARD_CHECK = true,
    ALL_ACKS = true, ONE_EXIT = true, ONE_OPEN = true, PIN = true, BUILD_VISIBLE = false,
    DDL_WAITS_MOVE = true, MOVE_WAITS_DDL = true, END_AFTER_DRAIN = true, PULL_AT_EPOCH = true, FENCE_IS_EPOCH = true, OWNER_CHECK = 0,
    SCHEMA_ON_PREPARE = false).* from "./m21_catalog_epoch"
}
module m24_m21_red_trial_no_drain {
  import m21_core(HAS_BUILD = false, HAS_CHECK = true, HAS_DROP = false, HAS_SPLIT = false, NTXN = 2, FIXED_INIT = false,
    REJECT_STALE = true, RECHECK = true, FENCE = true, DRAIN = false, CHECK_AT_EPOCH = true, GUARD_CHECK = true,
    ALL_ACKS = true, ONE_EXIT = true, ONE_OPEN = true, PIN = true, BUILD_VISIBLE = false,
    DDL_WAITS_MOVE = true, MOVE_WAITS_DDL = true, END_AFTER_DRAIN = true, PULL_AT_EPOCH = true, FENCE_IS_EPOCH = true, OWNER_CHECK = 0,
    SCHEMA_ON_PREPARE = false).* from "./m21_catalog_epoch"
}
module m24_m21_red_drop_no_fence {
  import m21_core(HAS_BUILD = false, HAS_CHECK = false, HAS_DROP = true, HAS_SPLIT = false, NTXN = 2, FIXED_INIT = true,
    REJECT_STALE = true, RECHECK = true, FENCE = false, DRAIN = true, CHECK_AT_EPOCH = true, GUARD_CHECK = true,
    ALL_ACKS = true, ONE_EXIT = true, ONE_OPEN = true, PIN = true, BUILD_VISIBLE = false,
    DDL_WAITS_MOVE = true, MOVE_WAITS_DDL = true, END_AFTER_DRAIN = true, PULL_AT_EPOCH = true, FENCE_IS_EPOCH = true, OWNER_CHECK = 0,
    SCHEMA_ON_PREPARE = false).* from "./m21_catalog_epoch"
}
module m24_m21_red_drop_no_check {
  import m21_core(HAS_BUILD = false, HAS_CHECK = false, HAS_DROP = true, HAS_SPLIT = false, NTXN = 2, FIXED_INIT = true,
    REJECT_STALE = true, RECHECK = true, FENCE = true, DRAIN = true, CHECK_AT_EPOCH = true, GUARD_CHECK = false,
    ALL_ACKS = true, ONE_EXIT = true, ONE_OPEN = true, PIN = true, BUILD_VISIBLE = false,
    DDL_WAITS_MOVE = true, MOVE_WAITS_DDL = true, END_AFTER_DRAIN = true, PULL_AT_EPOCH = true, FENCE_IS_EPOCH = true, OWNER_CHECK = 0,
    SCHEMA_ON_PREPARE = false).* from "./m21_catalog_epoch"
}
module m24_m21_red_drop_check_early {
  import m21_core(HAS_BUILD = false, HAS_CHECK = false, HAS_DROP = true, HAS_SPLIT = false, NTXN = 2, FIXED_INIT = true,
    REJECT_STALE = true, RECHECK = true, FENCE = true, DRAIN = true, CHECK_AT_EPOCH = false, GUARD_CHECK = true,
    ALL_ACKS = true, ONE_EXIT = true, ONE_OPEN = true, PIN = true, BUILD_VISIBLE = false,
    DDL_WAITS_MOVE = true, MOVE_WAITS_DDL = true, END_AFTER_DRAIN = true, PULL_AT_EPOCH = true, FENCE_IS_EPOCH = true, OWNER_CHECK = 0,
    SCHEMA_ON_PREPARE = false).* from "./m21_catalog_epoch"
}
module m24_m21_red_drop_no_drain {
  import m21_core(HAS_BUILD = false, HAS_CHECK = false, HAS_DROP = true, HAS_SPLIT = false, NTXN = 2, FIXED_INIT = true,
    REJECT_STALE = true, RECHECK = true, FENCE = true, DRAIN = false, CHECK_AT_EPOCH = true, GUARD_CHECK = true,
    ALL_ACKS = true, ONE_EXIT = true, ONE_OPEN = true, PIN = true, BUILD_VISIBLE = false,
    DDL_WAITS_MOVE = true, MOVE_WAITS_DDL = true, END_AFTER_DRAIN = true, PULL_AT_EPOCH = true, FENCE_IS_EPOCH = true, OWNER_CHECK = 0,
    SCHEMA_ON_PREPARE = false).* from "./m21_catalog_epoch"
}
module m24_m21_red_drop_untied {
  import m21_core(HAS_BUILD = false, HAS_CHECK = false, HAS_DROP = true, HAS_SPLIT = false, NTXN = 2, FIXED_INIT = true,
    REJECT_STALE = true, RECHECK = true, FENCE = true, DRAIN = true, CHECK_AT_EPOCH = true, GUARD_CHECK = true,
    ALL_ACKS = true, ONE_EXIT = false, ONE_OPEN = true, PIN = true, BUILD_VISIBLE = false,
    DDL_WAITS_MOVE = true, MOVE_WAITS_DDL = true, END_AFTER_DRAIN = true, PULL_AT_EPOCH = true, FENCE_IS_EPOCH = true, OWNER_CHECK = 0,
    SCHEMA_ON_PREPARE = false).* from "./m21_catalog_epoch"
}
module m24_m21_red_drop_missing_ack {
  import m21_core(HAS_BUILD = false, HAS_CHECK = false, HAS_DROP = true, HAS_SPLIT = false, NTXN = 2, FIXED_INIT = true,
    REJECT_STALE = true, RECHECK = true, FENCE = true, DRAIN = true, CHECK_AT_EPOCH = true, GUARD_CHECK = true,
    ALL_ACKS = false, ONE_EXIT = true, ONE_OPEN = true, PIN = true, BUILD_VISIBLE = false,
    DDL_WAITS_MOVE = true, MOVE_WAITS_DDL = true, END_AFTER_DRAIN = true, PULL_AT_EPOCH = true, FENCE_IS_EPOCH = true, OWNER_CHECK = 0,
    SCHEMA_ON_PREPARE = false).* from "./m21_catalog_epoch"
}
module m24_m21_red_two_open {
  import m21_core(HAS_BUILD = true, HAS_CHECK = false, HAS_DROP = true, HAS_SPLIT = false, NTXN = 0, FIXED_INIT = false,
    REJECT_STALE = true, RECHECK = true, FENCE = true, DRAIN = true, CHECK_AT_EPOCH = true, GUARD_CHECK = true,
    ALL_ACKS = true, ONE_EXIT = true, ONE_OPEN = false, PIN = true, BUILD_VISIBLE = false,
    DDL_WAITS_MOVE = true, MOVE_WAITS_DDL = true, END_AFTER_DRAIN = true, PULL_AT_EPOCH = true, FENCE_IS_EPOCH = true, OWNER_CHECK = 0,
    SCHEMA_ON_PREPARE = false).* from "./m21_catalog_epoch"
}
module m24_m21_red_ddl_during_move {
  import m21_core(HAS_BUILD = false, HAS_CHECK = true, HAS_DROP = false, HAS_SPLIT = true, NTXN = 1, FIXED_INIT = true,
    REJECT_STALE = true, RECHECK = true, FENCE = true, DRAIN = true, CHECK_AT_EPOCH = true, GUARD_CHECK = true,
    ALL_ACKS = true, ONE_EXIT = true, ONE_OPEN = true, PIN = true, BUILD_VISIBLE = false,
    DDL_WAITS_MOVE = false, MOVE_WAITS_DDL = true, END_AFTER_DRAIN = true, PULL_AT_EPOCH = true, FENCE_IS_EPOCH = true, OWNER_CHECK = 0,
    SCHEMA_ON_PREPARE = false).* from "./m21_catalog_epoch"
}
module m24_m21_red_move_during_ddl {
  import m21_core(HAS_BUILD = false, HAS_CHECK = true, HAS_DROP = false, HAS_SPLIT = true, NTXN = 1, FIXED_INIT = true,
    REJECT_STALE = true, RECHECK = true, FENCE = true, DRAIN = true, CHECK_AT_EPOCH = true, GUARD_CHECK = true,
    ALL_ACKS = true, ONE_EXIT = true, ONE_OPEN = true, PIN = true, BUILD_VISIBLE = false,
    DDL_WAITS_MOVE = true, MOVE_WAITS_DDL = false, END_AFTER_DRAIN = true, PULL_AT_EPOCH = true, FENCE_IS_EPOCH = true, OWNER_CHECK = 0,
    SCHEMA_ON_PREPARE = false).* from "./m21_catalog_epoch"
}
module m24_m21_red_end_early {
  import m21_core(HAS_BUILD = false, HAS_CHECK = true, HAS_DROP = false, HAS_SPLIT = true, NTXN = 1, FIXED_INIT = true,
    REJECT_STALE = true, RECHECK = true, FENCE = true, DRAIN = true, CHECK_AT_EPOCH = true, GUARD_CHECK = true,
    ALL_ACKS = true, ONE_EXIT = true, ONE_OPEN = true, PIN = true, BUILD_VISIBLE = false,
    DDL_WAITS_MOVE = true, MOVE_WAITS_DDL = true, END_AFTER_DRAIN = false, PULL_AT_EPOCH = true, FENCE_IS_EPOCH = true, OWNER_CHECK = 0,
    SCHEMA_ON_PREPARE = false).* from "./m21_catalog_epoch"
}
module m24_m21_red_pull_unfenced {
  import m21_core(HAS_BUILD = false, HAS_CHECK = true, HAS_DROP = false, HAS_SPLIT = true, NTXN = 1, FIXED_INIT = true,
    REJECT_STALE = true, RECHECK = true, FENCE = true, DRAIN = true, CHECK_AT_EPOCH = true, GUARD_CHECK = true,
    ALL_ACKS = true, ONE_EXIT = true, ONE_OPEN = true, PIN = true, BUILD_VISIBLE = false,
    DDL_WAITS_MOVE = true, MOVE_WAITS_DDL = true, END_AFTER_DRAIN = true, PULL_AT_EPOCH = false, FENCE_IS_EPOCH = true, OWNER_CHECK = 0,
    SCHEMA_ON_PREPARE = false).* from "./m21_catalog_epoch"
}
module m24_m21_red_fence_first {
  import m21_core(HAS_BUILD = false, HAS_CHECK = true, HAS_DROP = false, HAS_SPLIT = true, NTXN = 1, FIXED_INIT = true,
    REJECT_STALE = true, RECHECK = true, FENCE = true, DRAIN = true, CHECK_AT_EPOCH = true, GUARD_CHECK = true,
    ALL_ACKS = true, ONE_EXIT = true, ONE_OPEN = true, PIN = true, BUILD_VISIBLE = false,
    DDL_WAITS_MOVE = true, MOVE_WAITS_DDL = true, END_AFTER_DRAIN = true, PULL_AT_EPOCH = true, FENCE_IS_EPOCH = false, OWNER_CHECK = 0,
    SCHEMA_ON_PREPARE = false).* from "./m21_catalog_epoch"
}
module m24_m21_red_owner_unchecked {
  import m21_core(HAS_BUILD = false, HAS_CHECK = true, HAS_DROP = false, HAS_SPLIT = true, NTXN = 1, FIXED_INIT = true,
    REJECT_STALE = true, RECHECK = true, FENCE = true, DRAIN = true, CHECK_AT_EPOCH = true, GUARD_CHECK = true,
    ALL_ACKS = true, ONE_EXIT = true, ONE_OPEN = true, PIN = true, BUILD_VISIBLE = false,
    DDL_WAITS_MOVE = true, MOVE_WAITS_DDL = true, END_AFTER_DRAIN = true, PULL_AT_EPOCH = true, FENCE_IS_EPOCH = true, OWNER_CHECK = 2,
    SCHEMA_ON_PREPARE = false).* from "./m21_catalog_epoch"
}
module m24_m21_red_strict_epoch {
  import m21_core(HAS_BUILD = false, HAS_CHECK = true, HAS_DROP = false, HAS_SPLIT = true, NTXN = 1, FIXED_INIT = true,
    REJECT_STALE = true, RECHECK = true, FENCE = true, DRAIN = true, CHECK_AT_EPOCH = true, GUARD_CHECK = true,
    ALL_ACKS = true, ONE_EXIT = true, ONE_OPEN = true, PIN = true, BUILD_VISIBLE = false,
    DDL_WAITS_MOVE = true, MOVE_WAITS_DDL = true, END_AFTER_DRAIN = true, PULL_AT_EPOCH = true, FENCE_IS_EPOCH = true, OWNER_CHECK = 1,
    SCHEMA_ON_PREPARE = false).* from "./m21_catalog_epoch"
}
