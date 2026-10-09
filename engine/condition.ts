// Issue #42, S05, FM-5, WF-1, I6, ADR 0008: the JSON Logic condition evaluator.
//
// FM-5 fixes one expression format for all rules: a JSON expression tree in
// JSON Logic syntax (ADR 0008). This module evaluates the subset that the
// stories use: a path read (`var`), comparison (`==`, `===`, `!=`, `!==`,
// `<`, `<=`, `>`, `>=`), logic (`and`, `or`, `not`, `if`, `!!`) and arithmetic
// (`+`, `-`, `*`, `/`, `%`). It is a pure function of the expression and the
// data (I6): it reads no clock, no random source and no I/O. An unknown
// operator, an expression that is not one operator node, or a `var` path that
// the data does not have throws, so a wrong expression cannot give a silent
// wrong answer. The QuickJS-to-WASM sandbox and the TypeScript rule node type
// arrive later (ADR 0008); this evaluator is the deterministic base.

import type { JsonValue } from './definition.js'

/** The data that a condition reads (S05): the values that a run supplies for the expression. */
export type ConditionData = Readonly<Record<string, unknown>>

/**
 * Evaluate a JSON Logic expression over the data (FM-5, S05, I6). The result is
 * the value of the expression: a comparison gives a boolean, `var` gives the
 * value at the path, and so on. It is deterministic: the same expression and
 * the same data give the same result.
 */
export function evaluate(_expr: JsonValue, _data: ConditionData): unknown {
  throw new Error('condition: the evaluator is not implemented yet (issue #42)')
}
