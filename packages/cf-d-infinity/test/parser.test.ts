// SQLite の方言のパーサ (src/sql/lexer.ts、parser.ts、printer.ts) の試験。
//
// 1. 受け付けるかどうかを、本物の SQLite の構文の判定と比べる (文の一覧は test/parser-statements.ts)。
// 2. 木の形の見本。計画の組み立て (plan.ts) と DDL の解釈 (ddl.ts) は、節の種類と欄をそのまま読むので、形が変わると文の経路が
//    黙って変わる。見本は、入れ替える前のパーサ (sql-parser-cst) の木と同じであることを確かめて作った (2026-11-14)。
// 3. 文面への出し直し。節の外側の空白と注釈は付かない。木を書き換えた後でも出し直せる。
// 4. 前のパーサと読み方を変えた所 (どれも SQLite の文法に合わせた)。
import { DatabaseSync } from "node:sqlite";
import { describe, expect, it } from "vitest";
import { bindParams, constant, parseStatements, render, text, walk, type Node } from "../src/sql/cst";
import { parseDdl } from "../src/sql/ddl";
import { tokenize } from "../src/sql/lexer";
import { SqlError } from "../src/types";
import { diff } from "./diff";
import { randomExpression, splitStatements, sqliteAccepts } from "./parser-oracle";
import { STATEMENTS } from "./parser-statements";

/** 木の形を短い文字列にする。range と空白は出さない。予約語は文面、識別子は ` を付けた文面、値が undefined の欄は出さない。 */
function shape(n: Node): string {
  if (n === null) return "null";
  if (n === undefined) return "undef";
  if (typeof n === "string") return JSON.stringify(n);
  if (typeof n !== "object") return String(n);
  if (Array.isArray(n)) return `[${n.map(shape).join(" ")}]`;
  switch (n.type) {
    case "keyword": return n.name === n.text.toUpperCase() ? n.text : `${n.text}~${n.name}`;
    case "identifier": return n.text === n.name ? `\`${n.text}` : `\`${n.text}~${n.name}`;
    case "number_literal": return `#${n.text}${String(n.value) === n.text ? "" : `~${n.value}`}`;
    case "string_literal": return `${n.text}`;
    case "parameter": return `P${n.text}`;
    case "binary_expr": return `(${shape(n.operator)} ${shape(n.left)} ${shape(n.right)})`;
    case "prefix_op_expr": return `(pre ${shape(n.operator)} ${shape(n.expr)})`;
    case "postfix_op_expr": return `(post ${shape(n.expr)} ${shape(n.operator)})`;
    case "paren_expr": return `(paren ${shape(n.expr)})`;
    case "list_expr": return `(list ${n.items.map(shape).join(" ")})`;
    case "member_expr": return `(. ${shape(n.object)} ${shape(n.property)})`;
    default: {
      const keys = Object.keys(n).filter((k) => k !== "type" && k !== "range" && k !== "leading" && k !== "trailing" && n[k] !== undefined).sort();
      return `${n.type}{${keys.map((k) => `${k}: ${shape(n[k])}`).join(", ")}}`;
    }
  }
}

const one = (sql: string): Node => {
  const stmts = parseStatements(sql);
  expect(stmts).toHaveLength(1);
  return stmts[0];
};
/** 式の木の形。 */
const expr = (e: string): string => shape(one(`SELECT ${e}`).clauses[0].columns.items[0]);
const refuses = (sql: string): string => {
  try {
    parseStatements(sql);
    return "accepted";
  } catch (e) {
    return (e as Error).message;
  }
};

/** 前のパーサと同じ形の木。[文, 形]。 */
const SHAPES: [string, string][] = [
  ["SELECT a, t.b AS x, c y, d 'z' FROM t WHERE a = ?1 AND b IN (1, 2) ORDER BY a DESC, b, 1 LIMIT 3",
    "select_stmt{clauses: [select_clause{columns: (list `a alias{alias: `x, asKw: AS, expr: (. `t `b)} alias{alias: `y, expr: `c} alias{alias: `'z'~z, expr: `d}), modifiers: [], selectKw: SELECT} from_clause{expr: `t, fromKw: FROM} where_clause{expr: (AND (\"=\" `a P?1) (IN `b (paren (list #1 #2)))), whereKw: WHERE} order_by_clause{orderByKw: [ORDER BY], specifications: (list sort_specification{direction: sort_direction_desc{descKw: DESC}, expr: `a} `b sort_specification{expr: #1})} limit_clause{count: #3, limitKw: LIMIT}]}"],
  ["SELECT DISTINCT * FROM main.t AS x INDEXED BY i JOIN u ON x.a = u.a LEFT OUTER JOIN v USING (a), w NOT INDEXED",
    "select_stmt{clauses: [select_clause{columns: (list all_columns{}), modifiers: [select_distinct{distinctKw: DISTINCT}], selectKw: SELECT} from_clause{expr: join_expr{left: join_expr{left: join_expr{left: indexed_table{index: `i, indexedByKw: [INDEXED BY], table: alias{alias: `x, asKw: AS, expr: (. `main `t)}}, operator: JOIN, right: `u, specification: join_on_specification{expr: (\"=\" (. `x `a) (. `u `a)), onKw: ON}}, operator: [LEFT OUTER JOIN], right: `v, specification: join_using_specification{expr: (paren (list `a)), usingKw: USING}}, operator: \",\", right: not_indexed_table{notIndexedKw: [NOT INDEXED], table: `w}}, fromKw: FROM}]}"],
  ["SELECT (SELECT max(b) FROM u), EXISTS (SELECT 1) FROM (SELECT a FROM t) s, json_each(s.a) j WHERE a IN (SELECT a FROM u) AND b NOT IN u",
    "select_stmt{clauses: [select_clause{columns: (list (paren select_stmt{clauses: [select_clause{columns: (list func_call{args: (paren func_args{args: (list `b)}), name: `max}), modifiers: [], selectKw: SELECT} from_clause{expr: `u, fromKw: FROM}]}) (pre EXISTS (paren select_stmt{clauses: [select_clause{columns: (list #1), modifiers: [], selectKw: SELECT}]}))), modifiers: [], selectKw: SELECT} from_clause{expr: join_expr{left: alias{alias: `s, expr: (paren select_stmt{clauses: [select_clause{columns: (list `a), modifiers: [], selectKw: SELECT} from_clause{expr: `t, fromKw: FROM}]})}, operator: \",\", right: alias{alias: `j, expr: func_call{args: (paren func_args{args: (list (. `s `a))}), name: `json_each}}}, fromKw: FROM} where_clause{expr: (AND (IN `a (paren select_stmt{clauses: [select_clause{columns: (list `a), modifiers: [], selectKw: SELECT} from_clause{expr: `u, fromKw: FROM}]})) ([NOT IN] `b `u)), whereKw: WHERE}]}"],
  ["SELECT a, count(*), count(DISTINCT b), sum(c) FILTER (WHERE c > 0), row_number() OVER (PARTITION BY a ORDER BY b ROWS 1 PRECEDING) FROM t GROUP BY a HAVING count(*) > 1",
    "select_stmt{clauses: [select_clause{columns: (list `a func_call{args: (paren func_args{args: (list all_columns{})}), name: `count} func_call{args: (paren func_args{args: (list `b), distinctKw: DISTINCT}), name: `count} func_call{args: (paren func_args{args: (list `c)}), filter: filter_arg{filterKw: FILTER, where: (paren where_clause{expr: (\">\" `c #0), whereKw: WHERE})}, name: `sum} func_call{args: (paren func_args{args: (list )}), name: `row_number, over: over_arg{overKw: OVER, window: (paren window_definition{frame: frame_clause{extent: frame_bound_preceding{expr: #1, precedingKw: PRECEDING}, unitKw: ROWS}, orderBy: order_by_clause{orderByKw: [ORDER BY], specifications: (list `b)}, partitionBy: partition_by_clause{partitionByKw: [PARTITION BY], specifications: (list `a)}})}}), modifiers: [], selectKw: SELECT} from_clause{expr: `t, fromKw: FROM} group_by_clause{columns: (list `a), groupByKw: [GROUP BY]} having_clause{expr: (\">\" func_call{args: (paren func_args{args: (list all_columns{})}), name: `count} #1), havingKw: HAVING}]}"],
  ["WITH RECURSIVE c(x) AS (SELECT 1 UNION ALL SELECT x + 1 FROM c) SELECT x FROM c UNION ALL VALUES (2) EXCEPT SELECT 3 ORDER BY 1 LIMIT 5 OFFSET 1",
    "compound_select_stmt{left: compound_select_stmt{left: select_stmt{clauses: [with_clause{recursiveKw: RECURSIVE, tables: (list common_table_expr{asKw: AS, columns: (paren (list `x)), expr: (paren compound_select_stmt{left: select_stmt{clauses: [select_clause{columns: (list #1), modifiers: [], selectKw: SELECT}]}, operator: [UNION ALL], right: select_stmt{clauses: [select_clause{columns: (list (\"+\" `x #1)), modifiers: [], selectKw: SELECT} from_clause{expr: `c, fromKw: FROM}]}}), table: `c}), withKw: WITH} select_clause{columns: (list `x), modifiers: [], selectKw: SELECT} from_clause{expr: `c, fromKw: FROM}]}, operator: [UNION ALL], right: select_stmt{clauses: [values_clause{values: (list (paren (list #2))), valuesKw: VALUES}]}}, operator: EXCEPT, right: select_stmt{clauses: [select_clause{columns: (list #3), modifiers: [], selectKw: SELECT} order_by_clause{orderByKw: [ORDER BY], specifications: (list sort_specification{expr: #1})} limit_clause{count: #5, limitKw: LIMIT, offset: #1, offsetKw: OFFSET}]}}"],
  ["SELECT a FROM t LIMIT 2, 1",
    "select_stmt{clauses: [select_clause{columns: (list `a), modifiers: [], selectKw: SELECT} from_clause{expr: `t, fromKw: FROM} limit_clause{count: #1, limitKw: LIMIT, offset: #2}]}"],
  ["SELECT -a, NOT b, a IS NOT NULL, a NOT IN (1), a NOT BETWEEN 1 AND 2, a LIKE 'x%' ESCAPE '!', a COLLATE NOCASE, CAST(a AS VARCHAR(10)), CASE a WHEN 1 THEN 2 ELSE 3 END, a ISNULL, a NOT NULL",
    "select_stmt{clauses: [select_clause{columns: (list (pre \"-\" `a) (pre NOT `b) ([IS NOT] `a null_literal{nullKw: NULL, value: null}) ([NOT IN] `a (paren (list #1))) between_expr{andKw: AND, begin: #1, betweenKw: [NOT BETWEEN], end: #2, left: `a} (LIKE `a (ESCAPE 'x%' '!')) (COLLATE `a `NOCASE) cast_expr{args: (paren cast_arg{asKw: AS, dataType: named_data_type{name: VARCHAR, params: (paren (list #10))}, expr: `a}), castKw: CAST} case_expr{caseKw: CASE, clauses: [case_when{condition: #1, result: #2, thenKw: THEN, whenKw: WHEN} case_else{elseKw: ELSE, result: #3}], endKw: END, expr: `a} (post `a ISNULL) (post `a [NOT NULL])), modifiers: [], selectKw: SELECT}]}"],
  ["SELECT (a, b), x'0aFF', 1.50, 'it''s', NULL, TRUE, CURRENT_TIMESTAMP, \"q\"\"x\", [b c], t.*, a || b, a -> '$.x', a IS NOT DISTINCT FROM b, ~a, a OR b AND c",
    "select_stmt{clauses: [select_clause{columns: (list (paren (list `a `b)) blob_literal{text: \"x'0aFF'\", value: [10 255]} #1.50~1.5 'it''s' null_literal{nullKw: NULL, value: null} boolean_literal{value: true, valueKw: TRUE} func_call{name: `CURRENT_TIMESTAMP} `\"q\"\"x\"~q\"x `[b c]~b c (. `t all_columns{}) (\"||\" `a `b) (\"->\" `a '$.x') ([IS NOT DISTINCT FROM] `a `b) (pre \"~\" `a) (OR `a (AND `b `c))), modifiers: [], selectKw: SELECT}]}"],
  ["INSERT OR REPLACE INTO t (a, b) VALUES (1, ?), (2, :x) ON CONFLICT (a) WHERE a > 0 DO UPDATE SET b = excluded.b WHERE b > 0 ON CONFLICT DO NOTHING RETURNING *, a AS q",
    "insert_stmt{clauses: [insert_clause{columns: (paren (list `a `b)), insertKw: INSERT, intoKw: INTO, modifiers: [], orAction: or_alternate_action{actionKw: REPLACE, orKw: OR}, table: `t} values_clause{values: (list (paren (list #1 P?)) (paren (list #2 P:x))), valuesKw: VALUES} upsert_clause{action: upsert_action_update{set: set_clause{assignments: (list column_assignment{column: `b, expr: (. `excluded `b)}), setKw: SET}, updateKw: UPDATE, where: where_clause{expr: (\">\" `b #0), whereKw: WHERE}}, conflictTarget: (paren (list index_specification{expr: `a})), doKw: DO, onConflictKw: [ON CONFLICT], where: where_clause{expr: (\">\" `a #0), whereKw: WHERE}} upsert_clause{action: upsert_action_nothing{nothingKw: NOTHING}, doKw: DO, onConflictKw: [ON CONFLICT]} returning_clause{columns: (list all_columns{} alias{alias: `q, asKw: AS, expr: `a}), returningKw: RETURNING}]}"],
  ["REPLACE INTO t DEFAULT VALUES",
    "insert_stmt{clauses: [insert_clause{insertKw: REPLACE, intoKw: INTO, modifiers: [], table: `t} default_values{defaultValuesKw: [DEFAULT VALUES]}]}"],
  ["INSERT INTO main.t AS x SELECT * FROM u UNION SELECT * FROM v",
    "insert_stmt{clauses: [insert_clause{insertKw: INSERT, intoKw: INTO, modifiers: [], table: alias{alias: `x, asKw: AS, expr: (. `main `t)}} compound_select_stmt{left: select_stmt{clauses: [select_clause{columns: (list all_columns{}), modifiers: [], selectKw: SELECT} from_clause{expr: `u, fromKw: FROM}]}, operator: UNION, right: select_stmt{clauses: [select_clause{columns: (list all_columns{}), modifiers: [], selectKw: SELECT} from_clause{expr: `v, fromKw: FROM}]}}]}"],
  ["WITH c AS (SELECT 1) UPDATE OR IGNORE t AS x SET a = 1, (b, c) = (2, 3) FROM u WHERE x.id = u.id RETURNING a",
    "update_stmt{clauses: [with_clause{tables: (list common_table_expr{asKw: AS, expr: (paren select_stmt{clauses: [select_clause{columns: (list #1), modifiers: [], selectKw: SELECT}]}), table: `c}), withKw: WITH} update_clause{modifiers: [], orAction: or_alternate_action{actionKw: IGNORE, orKw: OR}, tables: (list alias{alias: `x, asKw: AS, expr: `t}), updateKw: UPDATE} set_clause{assignments: (list column_assignment{column: `a, expr: #1} column_assignment{column: (paren (list `b `c)), expr: (paren (list #2 #3))}), setKw: SET} from_clause{expr: `u, fromKw: FROM} where_clause{expr: (\"=\" (. `x `id) (. `u `id)), whereKw: WHERE} returning_clause{columns: (list `a), returningKw: RETURNING}]}"],
  ["DELETE FROM t WHERE id = @id ORDER BY id LIMIT 1",
    "delete_stmt{clauses: [delete_clause{deleteKw: DELETE, fromKw: FROM, modifiers: [], tables: (list `t)} where_clause{expr: (\"=\" `id P@id), whereKw: WHERE} order_by_clause{orderByKw: [ORDER BY], specifications: (list `id)} limit_clause{count: #1, limitKw: LIMIT}]}"],
  ["CREATE TABLE IF NOT EXISTS t (id INTEGER PRIMARY KEY AUTOINCREMENT, a TEXT COLLATE NOCASE NOT NULL UNIQUE DEFAULT 'x', b INT CONSTRAINT fk REFERENCES u (id) ON DELETE CASCADE DEFERRABLE, c INT CHECK (c > 0) DEFAULT (1), d VARCHAR(10) DEFAULT -1, e UNSIGNED BIG INT, CONSTRAINT k UNIQUE (a, b), PRIMARY KEY (id DESC, a), FOREIGN KEY (b) REFERENCES u (id)) WITHOUT ROWID, STRICT",
    "create_table_stmt{clauses: [], columns: (paren (list column_definition{constraints: [constraint_primary_key{clauses: [], primaryKeyKw: [PRIMARY KEY]} constraint_auto_increment{autoIncrementKw: AUTOINCREMENT}], dataType: named_data_type{name: INTEGER}, name: `id} column_definition{constraints: [constraint_collate{collateKw: COLLATE, collation: `NOCASE} constraint_not_null{clauses: [], notNullKw: [NOT NULL]} constraint_unique{clauses: [], uniqueKw: UNIQUE} constraint_default{defaultKw: DEFAULT, expr: 'x'}], dataType: named_data_type{name: TEXT}, name: `a} column_definition{constraints: [constraint{constraint: references_specification{columns: (paren (list `id)), options: [referential_action{actionKw: CASCADE, eventKw: DELETE, onKw: ON}], referencesKw: REFERENCES, table: `u}, modifiers: [constraint_modifier{kw: DEFERRABLE}], name: constraint_name{constraintKw: CONSTRAINT, name: `fk}}], dataType: named_data_type{name: INT}, name: `b} column_definition{constraints: [constraint_check{checkKw: CHECK, clauses: [], expr: (paren (\">\" `c #0))} constraint_default{defaultKw: DEFAULT, expr: (paren #1)}], dataType: named_data_type{name: INT}, name: `c} column_definition{constraints: [constraint_default{defaultKw: DEFAULT, expr: (pre \"-\" #1)}], dataType: named_data_type{name: VARCHAR, params: (paren (list #10))}, name: `d} column_definition{constraints: [], dataType: named_data_type{name: [UNSIGNED BIG INT]}, name: `e} constraint{constraint: constraint_unique{clauses: [], columns: (paren (list `a `b)), uniqueKw: UNIQUE}, modifiers: [], name: constraint_name{constraintKw: CONSTRAINT, name: `k}} constraint_primary_key{clauses: [], columns: (paren (list index_specification{direction: sort_direction_desc{descKw: DESC}, expr: `id} index_specification{expr: `a})), primaryKeyKw: [PRIMARY KEY]} constraint_foreign_key{columns: (paren (list `b)), foreignKeyKw: [FOREIGN KEY], references: references_specification{columns: (paren (list `id)), options: [], referencesKw: REFERENCES, table: `u}})), createKw: CREATE, ifNotExistsKw: [IF NOT EXISTS], name: `t, options: (list table_option{name: [WITHOUT ROWID]} table_option{name: STRICT}), tableKw: TABLE}"],
  ["CREATE TEMP TABLE main.t (a)",
    "create_table_stmt{clauses: [], columns: (paren (list column_definition{constraints: [], name: `a})), createKw: CREATE, kind: relation_kind{kindKw: TEMP}, name: (. `main `t), tableKw: TABLE}"],
  ["CREATE TABLE t AS SELECT 1",
    "create_table_stmt{clauses: [as_clause{asKw: AS, expr: select_stmt{clauses: [select_clause{columns: (list #1), modifiers: [], selectKw: SELECT}]}}], createKw: CREATE, name: `t, tableKw: TABLE}"],
  ["CREATE UNIQUE INDEX IF NOT EXISTS i ON t (a, b DESC, lower(c)) WHERE a > 0",
    "create_index_stmt{clauses: [where_clause{expr: (\">\" `a #0), whereKw: WHERE}], columns: (paren (list index_specification{expr: `a} index_specification{direction: sort_direction_desc{descKw: DESC}, expr: `b} index_specification{expr: func_call{args: (paren func_args{args: (list `c)}), name: `lower}})), createKw: CREATE, ifNotExistsKw: [IF NOT EXISTS], indexKw: INDEX, indexTypeKw: UNIQUE, name: `i, onKw: ON, table: `t}"],
  ["CREATE VIEW IF NOT EXISTS v (x) AS SELECT a FROM t",
    "create_view_stmt{clauses: [as_clause{asKw: AS, expr: select_stmt{clauses: [select_clause{columns: (list `a), modifiers: [], selectKw: SELECT} from_clause{expr: `t, fromKw: FROM}]}}], columns: (paren (list column_definition{constraints: [], name: `x})), createKw: CREATE, ifNotExistsKw: [IF NOT EXISTS], kinds: [], name: `v, viewKw: VIEW}"],
  ["CREATE TRIGGER tr AFTER UPDATE OF a ON t FOR EACH ROW WHEN new.a > 0 BEGIN UPDATE u SET a = 1; SELECT RAISE(ABORT, 'no'); END",
    "create_trigger_stmt{body: block_stmt{beginKw: BEGIN, endKw: END, program: program{statements: [update_stmt{clauses: [update_clause{modifiers: [], tables: (list `u), updateKw: UPDATE} set_clause{assignments: (list column_assignment{column: `a, expr: #1}), setKw: SET}]} select_stmt{clauses: [select_clause{columns: (list raise_expr{args: (paren (list raise_expr_type{typeKw: ABORT} 'no')), raiseKw: RAISE}), modifiers: [], selectKw: SELECT}]} empty{}]}}, clauses: [for_each_clause{forEachKw: [FOR EACH], itemKw: ROW} when_clause{expr: (\">\" (. `new `a) #0), whenKw: WHEN}], createKw: CREATE, event: trigger_event{columns: (list `a), eventKw: UPDATE, ofKw: OF}, name: `tr, target: trigger_target{onKw: ON, table: `t}, timeKw: AFTER, triggerKw: TRIGGER}"],
  ["DROP TABLE IF EXISTS main.t",
    "drop_table_stmt{dropKw: DROP, ifExistsKw: [IF EXISTS], tableKw: TABLE, tables: (list (. `main `t))}"],
  ["DROP INDEX i",
    "drop_index_stmt{dropKw: DROP, indexKw: INDEX, indexes: (list `i)}"],
  ["DROP VIEW IF EXISTS v",
    "drop_view_stmt{dropKw: DROP, ifExistsKw: [IF EXISTS], viewKw: VIEW, views: (list `v)}"],
  ["DROP TRIGGER IF EXISTS tr",
    "drop_trigger_stmt{dropTriggerKw: [DROP TRIGGER], ifExistsKw: [IF EXISTS], trigger: `tr}"],
  ["ALTER TABLE t RENAME TO u",
    "alter_table_stmt{actions: (list alter_action_rename{newName: `u, renameKw: [RENAME TO]}), alterTableKw: [ALTER TABLE], table: `t}"],
  ["ALTER TABLE t ADD COLUMN c INT DEFAULT 0 REFERENCES u (id)",
    "alter_table_stmt{actions: (list alter_action_add_column{addKw: [ADD COLUMN], column: column_definition{constraints: [constraint_default{defaultKw: DEFAULT, expr: #0} references_specification{columns: (paren (list `id)), options: [], referencesKw: REFERENCES, table: `u}], dataType: named_data_type{name: INT}, name: `c}}), alterTableKw: [ALTER TABLE], table: `t}"],
  ["ALTER TABLE t RENAME COLUMN a TO b",
    "alter_table_stmt{actions: (list alter_action_rename_column{newName: `b, oldName: `a, renameKw: [RENAME COLUMN], toKw: TO}), alterTableKw: [ALTER TABLE], table: `t}"],
  ["ALTER TABLE t DROP COLUMN a",
    "alter_table_stmt{actions: (list alter_action_drop_column{column: `a, dropKw: [DROP COLUMN]}), alterTableKw: [ALTER TABLE], table: `t}"],
  ["BEGIN IMMEDIATE TRANSACTION",
    "start_transaction_stmt{behaviorKw: IMMEDIATE, startKw: BEGIN, transactionKw: TRANSACTION}"],
  ["END",
    "commit_transaction_stmt{commitKw: END}"],
  ["ROLLBACK TO SAVEPOINT s",
    "rollback_transaction_stmt{rollbackKw: ROLLBACK, savepoint: rollback_to_savepoint{savepoint: `s, savepointKw: SAVEPOINT, toKw: TO}}"],
  ["SAVEPOINT s",
    "savepoint_stmt{savepoint: `s, savepointKw: SAVEPOINT}"],
  ["RELEASE s",
    "release_savepoint_stmt{releaseKw: RELEASE, savepoint: `s}"],
  ["PRAGMA table_info(t)",
    "pragma_stmt{pragma: pragma_func_call{args: (paren t), name: `table_info}, pragmaKw: PRAGMA}"],
  ["PRAGMA main.foreign_keys = ON",
    "pragma_stmt{pragma: pragma_assignment{name: (. `main `foreign_keys), value: ON}, pragmaKw: PRAGMA}"],
  ["EXPLAIN QUERY PLAN SELECT 1",
    "explain_stmt{explainKw: EXPLAIN, queryPlanKw: [QUERY PLAN], statement: select_stmt{clauses: [select_clause{columns: (list #1), modifiers: [], selectKw: SELECT}]}}"],
  ["ANALYZE",
    "analyze_stmt{analyzeKw: ANALYZE, tables: []}"],
  ["ANALYZE main.t",
    "analyze_stmt{analyzeKw: ANALYZE, tables: (list (. `main `t))}"],
  ["REINDEX t",
    "reindex_stmt{name: `t, reindexKw: REINDEX}"],
  ["VACUUM main INTO 'f'",
    "vacuum_stmt{file: 'f', intoKw: INTO, schema: `main, vacuumKw: VACUUM}"],
  ["ATTACH DATABASE 'f' AS x",
    "attach_database_stmt{asKw: AS, attachKw: ATTACH, databaseKw: DATABASE, file: 'f', schema: `x}"],
  ["DETACH x",
    "detach_database_stmt{detachKw: DETACH, schema: `x}"],
];

/**
 * 文の一覧のうち、受け付けるかどうかが SQLite と違うもの。ここに挙げたとおりであることを確かめる。
 *   accepts: D∞ のパーサは通すが、SQLite は構文の誤りにする。文は SQLite まで届いて、そこで断られる。
 *   refuses: SQLite は通すが、D∞ のパーサは構文の誤りにする。
 */
const KNOWN_DIFFERENCES: string[] = [
  // UPDATE と DELETE の ORDER BY と LIMIT は、SQLite では組み込みの指定 (SQLITE_ENABLE_UPDATE_DELETE_LIMIT) があるときだけの構文である。
  "accepts: UPDATE t SET a = 1 ORDER BY b LIMIT 1",
  "accepts: UPDATE t SET a = 1 WHERE c = 1 ORDER BY b DESC LIMIT 1 OFFSET 2",
  "accepts: DELETE FROM t WHERE a = 1 ORDER BY b LIMIT 1",
  "accepts: DELETE FROM t ORDER BY b LIMIT 1 OFFSET 1",
  // SQLite は名前に文字列の literal も読む。ここでは、別名と照合順序の名前でだけ読む。
  "refuses: SELECT a FROM 't'",
  "refuses: CREATE TABLE 't' ('a' INT)",
  // INDEXED は SQLite では識別子にも使える。ここでは予約語である。
  "refuses: SELECT indexed FROM t",
  // 表の制約は、SQLite では `,` なしでも続けて書ける。制約のない CONSTRAINT 名前 も書ける。どちらも読まない。
  "refuses: CREATE TABLE t (a, PRIMARY KEY (a) UNIQUE (a))",
  "refuses: CREATE TABLE t (a INT CONSTRAINT x)",
  // 引用した型の名前と、表の UNIQUE の列の照合順序や方向。読むと、DDL の解釈 (ddl.ts) が誤った表定義を記録する (parser.ts)。
  "refuses: CREATE TABLE t (id \"INTEGER\" PRIMARY KEY, v 'my type')",
  "refuses: CREATE TABLE t (a INT, UNIQUE (a COLLATE NOCASE DESC))",
];

/** パーサが通して SQLite が断る文のうち、分かっているもの (KNOWN_DIFFERENCES の accepts と同じ理由)。壊した文の試験が使う。 */
const KNOWN_LAX = [
  // UPDATE と DELETE の ORDER BY と LIMIT (SQLite の組み込みの指定)。
  /^(WITH\b.*)?(UPDATE|DELETE)\b[^]*\b(ORDER\s+BY|LIMIT)\b/i,
  // INSERT ... SELECT ... FROM t ON CONFLICT。SQLite は ON を結合の条件として読んで断る (WHERE true を挟めと文書にある)。
  /^INSERT\b[^]*\bSELECT\b[^]*\bON\s+CONFLICT\b/i,
];

describe("the SQL parser", () => {
  describe("accepting and refusing", () => {
    it("agrees with SQLite on every statement of the list, except the listed ones", () => {
      const differences: string[] = [];
      for (const source of STATEMENTS) {
        const ours = refuses(source) === "accepted";
        const theirs = (splitStatements(source) ?? [source]).every(sqliteAccepts);
        if (ours !== theirs) differences.push(`${ours ? "accepts" : "refuses"}: ${source}`);
      }
      expect(differences).toEqual(KNOWN_DIFFERENCES);
    });

    it("agrees with SQLite on random expressions", () => {
      const differences: string[] = [];
      for (let seed = 1; seed <= 3000; seed++) {
        const sql = `SELECT ${randomExpression(seed)} FROM t`;
        const ours = refuses(sql) === "accepted";
        if (ours !== sqliteAccepts(sql)) differences.push(`${ours ? "accepts" : "refuses"}: ${sql}`);
      }
      expect(differences).toEqual([]);
    });

    it("groups the operators of random expressions as SQLite does", () => {
      // 式を、今のパーサが読んだ木のとおりに全部括弧で囲み直す。SQLite が元の式と同じ値を返せば、演算子の優先順位と結合の向きが
      // SQLite と同じである。前のパーサは、3 か所で SQLite と違う組み方をしていた (下の「読み方を変えた所」)。
      const db = new DatabaseSync(":memory:");
      db.exec("CREATE TABLE t (a, b, c, q); INSERT INTO t VALUES (1, 2, 3, 'x'), (0, NULL, -1, '10'), (5, 2.5, 'x', NULL), (NULL, 0, 7, 'ab'), (3, 3, 3, 3), (-2, 1, 0, '2.5')");
      const values = (e: string): string => {
        try {
          const st = db.prepare(`SELECT ${e} FROM t ORDER BY rowid`);
          st.setReturnArrays(true);
          return JSON.stringify(st.all());
        } catch (err) {
          return `error: ${(err as Error).message}`;
        }
      };
      const words = (op: Node): string => (typeof op === "string" ? op : Array.isArray(op) ? op.map((k) => k.text).join(" ") : op.text);
      const grouped = (n: Node): string => {
        switch (n.type) {
          case "binary_expr": {
            const escape = n.right.type === "binary_expr" && n.right.operator?.name === "ESCAPE";
            if (escape) return `(${grouped(n.left)} ${words(n.operator)} ${grouped(n.right.left)} ESCAPE ${grouped(n.right.right)})`;
            return `(${grouped(n.left)} ${words(n.operator)} ${n.operator?.name === "COLLATE" ? text(n.right) : grouped(n.right)})`;
          }
          case "prefix_op_expr": return `(${words(n.operator)} ${grouped(n.expr)})`;
          case "postfix_op_expr": return `(${grouped(n.expr)} ${words(n.operator)})`;
          case "between_expr": return `(${grouped(n.left)} ${words(n.betweenKw)} ${grouped(n.begin)} AND ${grouped(n.end)})`;
          case "paren_expr":
            if (n.expr.type === "list_expr") return `(${n.expr.items.map(grouped).join(", ")})`;
            return n.expr.type === "select_stmt" ? text(n) : `(${grouped(n.expr)})`;
          default: return text(n);
        }
      };
      let regrouped = 0;
      for (let seed = 1; seed <= 3000; seed++) {
        const e = randomExpression(seed, { evaluable: true });
        const g = grouped(one(`SELECT ${e} FROM t`).clauses[0].columns.items[0]);
        if (g !== e) regrouped++;
        expect(values(g), `${e}\n  read as ${g}`).toBe(values(e));
      }
      expect(regrouped).toBeGreaterThan(1500);
    });

    it("words a syntax error the way SQLite does", () => {
      expect(refuses("SELECT a FROM")).toBe("incomplete input");
      expect(refuses("SELECT a b c FROM t")).toBe('near "c": syntax error');
      expect(refuses("SELECT a FROM t WHERE a == = 1")).toBe('near "=": syntax error');
      expect(refuses("SELECT 'abc")).toBe(`unrecognized token: "'abc"`);
      expect(refuses("SELECT 1e")).toBe('unrecognized token: "1e"');
      expect(refuses("SELECT # FROM t")).toBe('unrecognized token: "#"');
      expect(refuses("SELECT 1; garbage")).toBe('near "garbage": syntax error');
      // 消した SHARD KEY の句 (test/internal-names.test.ts)。
      expect(refuses("CREATE TABLE s (a INTEGER PRIMARY KEY) SHARD KEY (a)")).toBe('near "SHARD": syntax error');
    });

    it("refuses anything left over after a statement", () => {
      // 文を作り直してシャードへ送る経路 (INSERT、CREATE TABLE) がある。読めない続きを黙って捨てると、誤った文が正しい文に化ける。
      expect(refuses("INSERT INTO t (a) VALUES (1) nonsense")).toBe('near "nonsense": syntax error');
      expect(refuses("INSERT INTO t x VALUES (1)")).toBe('near "x": syntax error');
      expect(refuses("CREATE TABLE t (a INT) nonsense")).toBe('near "nonsense": syntax error');
      expect(refuses("UPDATE t SET a = 1 WHERE b = 2 3")).toBe('near "3": syntax error');
    });

    it("takes damaged statements without failing in any other way, and accepts none that SQLite refuses", () => {
      // 一覧の文のトークンを 1 つ消す、重ねる、隣と入れ替える。パーサは、文を読むか SqlError で断るかのどちらかで、ほかの例外を投げない。
      // パーサが通した文は、SQLite も通す。通さないと、文を作り直す経路 (INSERT、CREATE TABLE) が、誤った文を正しい文にして実行する。
      const crashes: string[] = [];
      const lax: string[] = [];
      const seen = new Set<string>();
      let damaged = 0;
      for (const source of STATEMENTS) {
        let texts: string[];
        try {
          texts = tokenize(source).filter((t) => t.kind !== "eof").map((t) => t.text);
        } catch {
          continue;
        }
        for (let i = 0; i < texts.length; i++) {
          for (const parts of [
            [...texts.slice(0, i), ...texts.slice(i + 1)],
            [...texts.slice(0, i + 1), texts[i]!, ...texts.slice(i + 1)],
            i + 1 < texts.length ? [...texts.slice(0, i), texts[i + 1]!, texts[i]!, ...texts.slice(i + 2)] : [],
          ]) {
            const m = parts.join(" ");
            if (parts.length === 0 || seen.has(m)) continue;
            seen.add(m);
            damaged++;
            let stmts: Node[];
            try {
              stmts = parseStatements(m);
            } catch (e) {
              if (!(e instanceof SqlError)) crashes.push(`${String(e)}: ${m}`);
              continue;
            }
            for (const st of stmts) {
              const t = text(st);
              if (sqliteAccepts(t) || KNOWN_LAX.some((re) => re.test(t))) continue;
              lax.push(t);
            }
          }
        }
      }
      expect(damaged).toBeGreaterThan(30000);
      expect(crashes).toEqual([]);
      expect(lax).toEqual([]);
    });

    it("reads a CREATE TRIGGER as one statement, with the semicolons of its body", () => {
      const stmts = parseStatements("CREATE TRIGGER tr AFTER INSERT ON t BEGIN UPDATE u SET a = 1; DELETE FROM v; END; SELECT 1");
      expect(stmts.map((s) => s.type)).toEqual(["create_trigger_stmt", "select_stmt"]);
      expect(text(stmts[0])).toBe("CREATE TRIGGER tr AFTER INSERT ON t BEGIN UPDATE u SET a = 1; DELETE FROM v; END");
    });

    it("reads chains of operators and joins as long as SQLite allows, and refuses deeper nesting with an SQL error", () => {
      // SQLite の式の深さの上限は 1000、結合の表の数の上限は 64 である。
      const where = Array.from({ length: 900 }, (_v, i) => `c${i} = ${i}`).join(" AND ");
      const from = Array.from({ length: 64 }, (_v, i) => `t${i}`).join(" JOIN ");
      const stmt = one(`SELECT 1 + ${Array.from({ length: 900 }, () => "1").join(" + ")} FROM ${from} WHERE ${where}`);
      expect(text(stmt).length).toBeGreaterThan(10000);
      expect(refuses(`SELECT ${"(".repeat(50000)}1${")".repeat(50000)}`)).toBe("parser stack overflow");
    });
  });

  describe("the tree", () => {
    it.each(SHAPES)("%s", (sql, expected) => {
      expect(shape(one(sql))).toBe(expected);
    });

    it("gives every parameter its position in the text, so that they bind in the order written", () => {
      const stmt = one("SELECT ?2, :a, ?, @b, $c, :a, ?1 FROM t WHERE x = ?5");
      const values = bindParams(stmt, [10, 20, 30, 40, 50, 60]);
      expect(values).toEqual([10, 20, 30, 40, 50, 60]);
      expect(render(stmt, values)).toEqual({ sql: "SELECT ?, ?, ?, ?, ?, ?, ? FROM t WHERE x = ?", params: [20, 30, 40, 50, 60, 30, 10, 50] });
      const named = one("SELECT :a, @b, $c, :a");
      expect(bindParams(named, { a: 1, "@b": 2, c: 3 })).toEqual([1, 2, 3]);
    });

    it("finds parameters and subqueries inside statements it only passes on", () => {
      const types = (sql: string): string[] => {
        const out: string[] = [];
        walk(one(sql), (x) => {
          if (x.type === "parameter" || x.type === "select_stmt") out.push(x.type === "parameter" ? x.text : x.type);
        });
        return out;
      };
      expect(types("EXPLAIN QUERY PLAN SELECT a FROM t WHERE b = ?1 AND c IN (SELECT ?2)")).toEqual(["select_stmt", "?1", "select_stmt", "?2"]);
      expect(types("CREATE VIEW v AS SELECT a FROM t WHERE b IN (SELECT c FROM u)")).toEqual(["select_stmt", "select_stmt"]);
      expect(types("INSERT INTO t VALUES (?, (SELECT max(a) FROM t)) ON CONFLICT (a) DO UPDATE SET b = (SELECT ?) RETURNING (SELECT 1)"))
        .toEqual(["?", "select_stmt", "select_stmt", "?", "select_stmt"]);
    });
  });

  describe("printing", () => {
    it("gives back each statement's own text, without the whitespace and comments around it", () => {
      // 文の中の空白は、CR も含めて、書いたまま出す。SQLite は、結果の列名に式の文面をそのまま使う。
      const stmts = parseStatements("  /* a */ SELECT 1 /* b */ ; -- c\n SELECT /* inside */\r\n\t2 -- d\n;;\n");
      expect(stmts.map(text)).toEqual(["SELECT 1", "SELECT /* inside */\r\n\t2"]);
    });

    it("prints a part of a statement without the comments next to it", () => {
      // 条件は括弧で包んでシャードへ送る (plan.ts の scanOf)。行末までの注釈が末尾に付くと、閉じる括弧が注釈に呑まれる。
      const where = one("SELECT x FROM t WHERE a = 1 -- first\n AND /* second */ b = 2 -- last\n").clauses[2].expr;
      expect([text(where.left), text(where.right)]).toEqual(["a = 1", "b = 2"]);
      expect(text(where)).toBe("a = 1 -- first\n AND /* second */ b = 2");
    });

    it("prints every statement of the list so that it parses to the same tree again", () => {
      for (const source of STATEMENTS) {
        if (refuses(source) !== "accepted") continue;
        for (const stmt of parseStatements(source)) {
          const again = one(text(stmt));
          expect(shape(again)).toBe(shape(stmt));
          expect(text(again)).toBe(text(stmt));
        }
      }
    });

    it("prints a tree after constraints and list items are taken out of it", () => {
      // 外部キーと、シャードをまたぐ UNIQUE は、シャードへ送る CREATE TABLE から外す (ddl.ts)。前後の空白と `,` も一緒に消える。
      const r = parseDdl(
        "CREATE TABLE t (id INTEGER PRIMARY KEY, a TEXT UNIQUE,\n  b INT  REFERENCES u (id)  NOT NULL , UNIQUE (a, b), FOREIGN KEY (b) REFERENCES u (id), CHECK (b > 0) )",
        { tables: {}, views: {}, indexes: {} },
      );
      expect(r.sql[0]).toBe("CREATE TABLE t (id INTEGER PRIMARY KEY, a TEXT,\n  b INT  NOT NULL , CHECK (b > 0) )");
      const added = parseDdl("ALTER TABLE t ADD COLUMN c INT DEFAULT 0 REFERENCES u (id) CHECK (c >= 0)", { tables: { t: r.defs[0]! }, views: {}, indexes: {} });
      expect(added.sql).toContain('ALTER TABLE "t" ADD COLUMN c INT DEFAULT 0 CHECK (c >= 0)');
    });
  });

  describe("where it reads a statement differently from the parser it replaced", () => {
    // どれも、前のパーサ (sql-parser-cst) の読み方が SQLite と違っていた所である。今は SQLite の文法に従う。

    it("follows SQLite's operator precedence", () => {
      // 前は、= と < を同じ強さで左から、& を | より強く、INTERSECT を EXCEPT より強く読んだ。
      expect(expr("a = b < c")).toBe('("=" `a ("<" `b `c))');
      expect(expr("a | b & c << d")).toBe('("<<" ("&" ("|" `a `b) `c) `d)');
      expect(shape(one("SELECT 1 EXCEPT SELECT 2 INTERSECT SELECT 3"))).toMatch(/^compound_select_stmt\{left: compound_select_stmt\{.*operator: EXCEPT.*operator: INTERSECT/);
    });

    it("reads 0X1f and 1_000 as numbers, not as identifiers", () => {
      const [hex, separated, real] = one("SELECT 0X1f, 1_000, 5.").clauses[0].columns.items;
      expect([constant(hex, []), constant(separated, [])]).toEqual([{ value: 31 }, { value: 1000 }]);
      expect(real.type).toBe("number_literal");
    });

    it("ends a DEFAULT value where SQLite ends it, so that the constraints after it are seen", async () => {
      // 前は `DEFAULT 'x' COLLATE NOCASE` の COLLATE を既定値の式の一部として読み、列の照合順序を記録しなかった。
      const r = parseDdl("CREATE TABLE c (id INTEGER PRIMARY KEY, a TEXT DEFAULT 'x' COLLATE NOCASE NOT NULL)", { tables: {}, views: {}, indexes: {} });
      expect(r.defs[0]!.collation).toEqual({ a: "NOCASE" });
      expect(r.defs[0]!.defaults).toEqual(["a"]);
      // 照合順序を知らないと、集約をシャードへ分けて押し下げ、集めた後を BINARY で比べて、SQLite と違う答えを返した。
      const problems = await diff(`
        CREATE TABLE c (id INTEGER PRIMARY KEY, a TEXT DEFAULT 'x' COLLATE NOCASE);
        INSERT INTO c VALUES (1, 'a'), (2, 'B'), (3, 'c'), (4, 'D'), (5, 'e'), (6, 'F'), (7, 'g'), (8, 'H');
        SELECT max(a) FROM c;
        SELECT min(a) FROM c;
        SELECT max(a), min(a) FROM c WHERE id < 7;
        SELECT a FROM c ORDER BY a LIMIT 3;
      `, 4);
      expect(problems).toEqual([]);
    });

    it("runs a WHERE whose conditions have line comments after them", async () => {
      // 前は、条件の後ろの行末までの注釈が条件の文面に付いた。条件を括弧で包んでシャードへ送る文 (plan.ts の scanOf) で、閉じる括弧が
      // 注釈に呑まれ、incomplete input で落ちた。
      const problems = await diff(`
        CREATE TABLE p (id INTEGER PRIMARY KEY, a INTEGER, b INTEGER);
        INSERT INTO p VALUES (1, 1, 2), (2, 1, 3), (3, 2, 2), (4, 1, 2);
        SELECT id FROM p WHERE a = 1 -- first
          AND b = 2 ORDER BY id;
        SELECT count(*) FROM p WHERE a = 1 /* first */ AND b = 2 -- second
          ;
        UPDATE p SET b = 9 WHERE a = 1 -- first
          AND b = 2;
        SELECT id, b FROM p ORDER BY id;
      `, 3);
      expect(problems).toEqual([]);
    });

    it("sees INTEGER PRIMARY KEY as the rowid when a comment sits next to the type", async () => {
      // 前は、型の名前の文面に隣の注釈が付き、INTEGER と一致しなかった。rowid の別名と見なされず、主キーを省いた INSERT が失敗した。
      const r = parseDdl("CREATE TABLE c (id /* the row id */ INTEGER PRIMARY KEY, v TEXT)", { tables: {}, views: {}, indexes: {} });
      expect(r.defs[0]!.rowidAlias).toBe("id");
      const problems = await diff(`
        CREATE TABLE c (id /* the row id */ INTEGER PRIMARY KEY, v TEXT);
        INSERT INTO c (v) VALUES ('a'), ('b'), ('c');
        SELECT id, v FROM c ORDER BY id;
      `, 3);
      expect(problems).toEqual([]);
    });

    it("reads SQLite statements the old parser could not, and answers them as SQLite does", async () => {
      for (const sql of [
        "SELECT a, sum(b) OVER w FROM t WINDOW w AS (PARTITION BY a ORDER BY b)", "SELECT a = b IN (1, 2) FROM t", "SELECT a NOT LIKE b ESCAPE c FROM t",
        "SELECT * FROM t NATURAL CROSS JOIN u", "PRAGMA cache_size = -2000", 'PRAGMA table_xinfo("t")', "CREATE TABLE t (a INT, b INT REFERENCES u (a) MATCH FULL)",
        "SELECT a < b BETWEEN c AND d, a ISNULL = b FROM t", "SELECT a COLLATE 'nocase' FROM t", "BEGIN TRANSACTION x",
      ]) expect(refuses(sql)).toBe("accepted");
      const problems = await diff(`
        CREATE TABLE w (id INTEGER PRIMARY KEY, g INTEGER, v INTEGER, s TEXT);
        INSERT INTO w VALUES (1, 1, 10, 'a_b'), (2, 1, 20, 'axb'), (3, 2, 30, 'a%'), (4, 2, 40, NULL), (5, 3, 5., 'A_B');
        SELECT id, sum(v) OVER win FROM w WINDOW win AS (PARTITION BY g ORDER BY id) ORDER BY id;
        SELECT id, rank() OVER win, sum(v) OVER (win ROWS UNBOUNDED PRECEDING) FROM w WINDOW win AS (ORDER BY g) ORDER BY id;
        SELECT id FROM w WHERE g = 1 IN (1, 2) ORDER BY id;
        SELECT id FROM w WHERE s NOT LIKE 'a!_b' ESCAPE '!' ORDER BY id;
        SELECT id FROM w WHERE s LIKE 'a' || '!' || '_b' ESCAPE '!' ORDER BY id;
        SELECT id FROM w WHERE v < 25 BETWEEN 0 AND 0 ORDER BY id;
        SELECT id FROM w WHERE s ISNULL = 0 ORDER BY id;
        SELECT id, v FROM w WHERE v = 5. ORDER BY id;
      `, 4);
      expect(problems).toEqual([]);
    });

    it("answers random WHERE clauses as SQLite does, on three shards", async () => {
      // 前のパーサは、乱数で作った式の 3 割ほどを読めなかった。読めるようになった式が、計画の組み立て (条件の押し下げ、行を集める経路) を
      // 通っても、SQLite と同じ答えになることを確かめる。
      const script = [
        "CREATE TABLE t (id INTEGER PRIMARY KEY, a, b, c, q)",
        "INSERT INTO t VALUES (1, 1, 2, 3, 'x'), (2, 0, NULL, -1, '10'), (3, 5, 2.5, 'x', NULL), (4, NULL, 0, 7, 'ab'), (5, 3, 3, 3, 3), (6, -2, 1, 0, '2.5')",
        ...Array.from({ length: 400 }, (_v, seed) => `SELECT id FROM t WHERE ${randomExpression(seed + 1, { evaluable: true })} ORDER BY id`),
        ...Array.from({ length: 100 }, (_v, seed) => `SELECT id, ${randomExpression(seed + 1000, { evaluable: true })} AS v FROM t WHERE id = ${1 + (seed % 6)}`),
      ].join(";\n");
      expect(await diff(`${script};\n`, 3)).toEqual([]);
    }, 120000);

    it("refuses what is not SQLite, which the old parser let through", () => {
      for (const sql of [
        "DROP TABLE t, u", "DELETE t", "INSERT t VALUES (1)", "UPDATE t x SET a = 1", "DELETE FROM t x WHERE a = 1", "SELECT CAST(a) FROM t", "SELECT cast FROM t", "SELECT x'0g'", "SELECT 0x",
        "CREATE TABLE t", "VALUES (1) ORDER BY 1", "SELECT count(DISTINCT *) FROM t", "CREATE TABLE t (a INT, PRIMARY KEY (a), b INT)",
      ]) expect(refuses(sql), sql).not.toBe("accepted");
    });

    it("reads a join word as a name or as a join by its place, not by the text after it", () => {
      // 前は、解析の前に文面を書き換えて、後ろに JOIN などが続かない結合の語を引用符で囲んでいた (2026-11-14 に消した)。
      // 後ろを空白だけ飛ばして見ていたので、間に注釈があると、結合の語を表の別名にした。
      const join = (sql: string): string => {
        const from = one(sql).clauses[1].expr;
        return `${from.type} ${(Array.isArray(from.operator) ? from.operator : [from.operator]).map((k: Node) => k.name).join(" ")}, left ${from.left.type}`;
      };
      for (const sql of [
        "SELECT * FROM p LEFT JOIN q", "SELECT * FROM p LEFT /* c */ JOIN q", "SELECT * FROM p LEFT -- c\n JOIN q", "SELECT * FROM p left\r\n\tjoin q", "SELECT * FROM p LEFT/**/JOIN q",
      ]) expect(join(sql), sql).toBe("join_expr LEFT JOIN, left identifier");
      expect(join("SELECT * FROM p NATURAL /* a */ LEFT /* b */ OUTER /* c */ JOIN q")).toBe("join_expr NATURAL LEFT OUTER JOIN, left identifier");
      // 表の名前が結合の語でも、後ろの結合はそのまま読む。AS の後ろでは、結合の語も別名になる。
      expect(join("SELECT * FROM left LEFT JOIN cross")).toBe("join_expr LEFT JOIN, left identifier");
      expect(join("SELECT * FROM left JOIN cross")).toBe("join_expr JOIN, left identifier");
      expect(join("SELECT * FROM p AS left LEFT JOIN q")).toBe("join_expr LEFT JOIN, left alias");
      // 名前として読んだ結合の語は、書いたままの文面で出る。結果の列名が SQLite と同じになる (前は `"left" + 1`)。
      expect(text(one("SELECT left + 1, p.full, natural FROM p WHERE right = 1 ORDER BY inner"))).toBe("SELECT left + 1, p.full, natural FROM p WHERE right = 1 ORDER BY inner");
      expect(expr("left + 1")).toBe('("+" `left #1)');
      // SQLite が結合の語を名前として読まない場所 (AS のない別名、型の名前、照合順序の名前、DEFAULT の後ろ) では、ここでも読まない。
      expect(refuses("SELECT a FROM t left")).toBe("incomplete input");
      expect(refuses("SELECT a FROM t left WHERE a = 1")).toBe('near "WHERE": syntax error');
      expect(refuses("SELECT a left FROM t")).toBe('near "left": syntax error');
      expect(refuses("SELECT * FROM (SELECT 1) cross")).toBe("incomplete input");
      expect(refuses("CREATE TABLE t (a left)")).toBe('near "left": syntax error');
      expect(refuses("CREATE TABLE t (a DEFAULT left)")).toBe('near "left": syntax error');
      expect(refuses("CREATE TABLE t (a TEXT COLLATE left)")).toBe('near "left": syntax error');
      expect(refuses("SELECT a COLLATE left FROM t")).toBe('near "left": syntax error');
      expect(refuses("SELECT * FROM p natural left outer cross JOIN q")).toBe('near "cross": syntax error');
    });

    it("reads ALL in the arguments of a function, and an IN with an empty list, where SQLite reads them", () => {
      // 前は、解析の前の書き換えが、`(` の直後の ALL を落とし、`IN ()` を常に偽のサブクエリに置き換えていた。
      // ALL は木に残す。文面に出るので、結果の列名が SQLite と同じになる。
      expect(expr("count(ALL a)")).toBe("func_call{args: (paren func_args{allKw: ALL, args: (list `a)}), name: `count}");
      expect(expr("count( /* every */ all a)")).toBe("func_call{args: (paren func_args{allKw: all, args: (list `a)}), name: `count}");
      expect(expr("count(ALL)")).toBe("func_call{args: (paren func_args{allKw: ALL, args: (list )}), name: `count}");
      expect(text(one("SELECT count( /* every */ ALL a ), max(ALL a, 2) FROM t"))).toBe("SELECT count( /* every */ ALL a ), max(ALL a, 2) FROM t");
      // ALL を書けるのは、式の中の関数の呼び出しの、引数の先頭だけである。
      for (const sql of [
        "SELECT count(ALL *) FROM t", "SELECT count(ALL DISTINCT a) FROM t", "SELECT count(DISTINCT ALL a) FROM t", "SELECT count(ALL ALL a) FROM t", "SELECT count(a, ALL b) FROM t",
        "SELECT (ALL a) FROM t", "SELECT a FROM t WHERE a IN (ALL 1)", "SELECT * FROM json_each(ALL '[1]')", "SELECT a FROM t WHERE a IN f(ALL 1)", "SELECT * FROM json_each(DISTINCT '[1]')",
      ]) {
        expect(refuses(sql), sql).toMatch(/syntax error/);
        expect(sqliteAccepts(sql), sql).toBe(false);
      }
      // 空の並びは、空の並びとして読む。括弧の中の注釈は、文面に残る。
      expect(expr("a IN ()")).toBe("(IN `a (paren (list )))");
      expect(expr("a NOT IN ( /* nothing */ )")).toBe("([NOT IN] `a (paren (list )))");
      expect(text(one("SELECT a IN ( /* nothing */ ), (a, b) not in () FROM t"))).toBe("SELECT a IN ( /* nothing */ ), (a, b) not in () FROM t");
      // 空にできるのは、IN の右辺の並びだけである。
      for (const sql of ["SELECT ()", "SELECT a IN (()) FROM t", "SELECT a FROM t WHERE a = ()", "INSERT INTO t VALUES ()"]) {
        expect(refuses(sql), sql).toMatch(/syntax error/);
        expect(sqliteAccepts(sql), sql).toBe(false);
      }
    });

    it("keeps the arguments of a virtual table module as text", () => {
      // モジュールが自分で読む文面で、SQL の式とは限らない。D∞ は仮想表を作れないので、形は使わない。文を 1 つとして読めればよい。
      const stmts = parseStatements("CREATE VIRTUAL TABLE ft USING fts5(a, b UNINDEXED, tokenize = 'porter unicode61'); SELECT 1");
      expect(stmts.map((s) => s.type)).toEqual(["create_table_stmt", "select_stmt"]);
      expect(text(stmts[0])).toBe("CREATE VIRTUAL TABLE ft USING fts5(a, b UNINDEXED, tokenize = 'porter unicode61')");
    });
  });
});
