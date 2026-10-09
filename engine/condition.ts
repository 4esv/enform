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
export type ConditionData = Readonly<Record<string, JsonValue>>

/**
 * Evaluate a JSON Logic expression over the data (FM-5, S05, I6). The result is
 * the value of the expression: a comparison gives a boolean, `var` gives the
 * value at the path, and so on. It is deterministic: the same expression and
 * the same data give the same result.
 */
export function evaluate(expr: JsonValue, data: ConditionData): JsonValue {
  return resolve(expr, data)
}

/** Resolve one node: an operator node, or a literal value. An array is never a node. */
function resolve(expr: JsonValue, data: ConditionData): JsonValue {
  if (Array.isArray(expr)) {
    throw new Error('condition: an expression must be one operator node, not an array')
  }
  if (!isJsonObject(expr)) return expr
  const keys = Object.keys(expr)
  if (keys.length !== 1) {
    throw new Error('condition: an expression must be one operator node')
  }
  return evaluateOperator(keys[0], expr[keys[0]], data)
}

/**
 * Evaluate one operator node. The operands are resolved before the operator
 * applies, so a nested expression is evaluated once and in order.
 */
function evaluateOperator(operator: string, raw: JsonValue, data: ConditionData): JsonValue {
  if (operator === 'var') return readVar(raw, data)
  const args = argsOf(raw, data)
  switch (operator) {
    case 'and':
      requireAtLeast(operator, args, 1)
      return args.reduce((accumulator, value) => (isTruthy(accumulator) ? value : accumulator))
    case 'or':
      requireAtLeast(operator, args, 1)
      return args.reduce((accumulator, value) => (isTruthy(accumulator) ? accumulator : value))
    case 'not':
      requireArgs(operator, args, 1)
      return !isTruthy(args[0])
    case '!!':
      requireArgs(operator, args, 1)
      return isTruthy(args[0])
    case 'if':
      requireArgs(operator, args, 3)
      return isTruthy(args[0]) ? args[1] : args[2]
    case '==':
      // biome-ignore lint/suspicious/noDoubleEquals: JSON Logic `==` is a loose comparison (FM-5).
      return compare(operator, args, (a, b) => a == b)
    case '===':
      return compare(operator, args, (a, b) => a === b)
    case '!=':
      // biome-ignore lint/suspicious/noDoubleEquals: JSON Logic `!=` is a loose comparison (FM-5).
      return compare(operator, args, (a, b) => a != b)
    case '!==':
      return compare(operator, args, (a, b) => a !== b)
    case '<':
      return compare(operator, args, (a, b) => Number(a) < Number(b))
    case '<=':
      return compare(operator, args, (a, b) => Number(a) <= Number(b))
    case '>':
      return compare(operator, args, (a, b) => Number(a) > Number(b))
    case '>=':
      return compare(operator, args, (a, b) => Number(a) >= Number(b))
    case '+':
      return arithmetic(operator, args, (a, b) => a + b)
    case '-':
      return arithmetic(operator, args, (a, b) => a - b)
    case '*':
      return arithmetic(operator, args, (a, b) => a * b)
    case '/':
      return arithmetic(operator, args, (a, b) => a / b)
    case '%':
      return arithmetic(operator, args, (a, b) => a % b)
    default:
      throw new Error(`condition: ${operator} is not a known operator`)
  }
}

/** Resolve an operator's operands. A single value is one operand; an array is the operand list. */
function argsOf(raw: JsonValue, data: ConditionData): readonly JsonValue[] {
  const operands = Array.isArray(raw) ? raw : [raw]
  return operands.map((operand) => resolve(operand, data))
}

/**
 * Read a dotted path from the data (S05). A missing path throws, so a rule
 * cannot read a value that the data does not have and silently compare nothing.
 */
function readVar(raw: JsonValue, data: ConditionData): JsonValue {
  if (typeof raw !== 'string') {
    throw new Error('condition: var takes the dotted path as a string')
  }
  let current: JsonValue = data
  for (const part of raw.split('.')) {
    if (!isJsonObject(current) || !(part in current)) {
      throw new Error(`condition: the var path ${raw} is not in the data`)
    }
    current = current[part]
  }
  return current
}

/** A binary comparison: exactly two operands, tested with the given predicate. */
function compare(
  operator: string,
  args: readonly JsonValue[],
  test: (a: JsonValue, b: JsonValue) => boolean
): boolean {
  requireArgs(operator, args, 2)
  return test(args[0], args[1])
}

/** A binary arithmetic operation: exactly two operands, read as numbers. */
function arithmetic(
  operator: string,
  args: readonly JsonValue[],
  operation: (a: number, b: number) => number
): number {
  requireArgs(operator, args, 2)
  return operation(Number(args[0]), Number(args[1]))
}

/** Require an exact operand count, so a mistyped rule throws instead of comparing a gap. */
function requireArgs(operator: string, args: readonly JsonValue[], count: number): void {
  if (args.length !== count) {
    throw new Error(`condition: ${operator} takes ${count} operands, got ${args.length}`)
  }
}

/** Require a minimum operand count for the variadic logic operators. */
function requireAtLeast(operator: string, args: readonly JsonValue[], count: number): void {
  if (args.length < count) {
    throw new Error(`condition: ${operator} takes at least ${count} operand`)
  }
}

/** The JSON Logic truth value: an empty array is false, everything else follows JavaScript. */
function isTruthy(value: JsonValue): boolean {
  if (Array.isArray(value)) return value.length > 0
  return Boolean(value)
}

/** A JSON object: not null and not an array. */
function isJsonObject(value: JsonValue): value is { readonly [key: string]: JsonValue } {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}
