// Issue #42, S05, WF-1, FM-5, I6, I7, I14: the skip decision and the run path.
//
// WF-1: a step carries an optional skip condition, a JSON Logic expression
// (FM-5). When the condition is true the instance advances past the step, and
// the timeline records the skip (S05). The decision is a pure function of the
// step and the instance data (I6): it reads no clock, no random source and no
// I/O. One run path serves both the dry run and the live run (I7): it decides
// the same route for the same definition and data, and only the side-effect
// sink differs. A live run commits one `step.skipped@1` operation per skipped
// step, attributed to the actor who advanced the flow (I14); a dry run writes
// no event and reports the same route and the same skips as intents.

import type { State } from './apply.js'
import { type ConditionData, evaluate } from './condition.js'
import type { FlowDefinition, FlowStep, JsonValue } from './definition.js'
import type { ActorId } from './operation.js'
import type { OutboxEntry } from './outbox.js'
import { type RunSources, runSteps, type Step } from './run.js'

/** The versioned event type of a skip (S05, WF-1). */
export const STEP_SKIPPED = 'step.skipped@1'

/** One step that a condition skips, with the condition that skipped it (S05). */
export type SkippedStep = {
  readonly step: string
  readonly condition: JsonValue
}

/** The route of a flow over one data set (WF-1, S05): the active steps and the skipped ones. */
export type FlowRoute = {
  /** The steps that run, in definition order, after the conditions are applied (WF-1). */
  readonly active: readonly string[]
  /** The steps that a condition skips, in definition order, with the condition (S05). */
  readonly skipped: readonly SkippedStep[]
}

/** The outcome of a flow run (I7): the end state, the side-effect intents and the route. */
export type FlowRun = {
  readonly state: State
  /** The side effects that the run produced, in step order (I7). */
  readonly intents: readonly OutboxEntry[]
  readonly route: FlowRoute
}

/**
 * Decide whether one step is skipped (WF-1, S05, I6): the skip condition is
 * true. A step with no condition is never skipped.
 */
export function isStepSkipped(step: FlowStep, data: ConditionData): boolean {
  if (step.skipWhen === undefined) return false
  return evaluate(step.skipWhen, data) === true
}

/**
 * Run a flow over one data set (S05, I7). The run reads the definition's steps
 * in order and decides each one with `isStepSkipped` (I6). A skipped step is
 * absent from `route.active`, and its condition is in `route.skipped`. One
 * loop serves both modes (I7): a live run commits one `step.skipped@1`
 * operation per skipped step, attributed to the actor (I14), and a dry run
 * writes no event. Both modes decide the same route and produce the same
 * side-effect intents for the same definition and data (I7).
 */
export function runFlow(
  definition: FlowDefinition,
  data: ConditionData,
  sources: RunSources,
  actor: ActorId
): FlowRun {
  const active: string[] = []
  const skipped: SkippedStep[] = []
  const steps: Step[] = []
  for (const step of definition.steps) {
    const condition = step.skipWhen
    if (condition !== undefined && isStepSkipped(step, data)) {
      skipped.push({ step: step.key, condition })
      steps.push({ type: STEP_SKIPPED, payload: { step: step.key, condition }, actor })
      continue
    }
    active.push(step.key)
  }
  const { state, intents } = runSteps(steps, sources)
  return { state, intents, route: { active, skipped } }
}
