// Issue #264, DR-1, DR-3, DR-4, DR-5, S05, S08, S12, I6, I7: the dry run of
// a definition. It routes the data through the steps as a submit would,
// names the steps a condition skipped with the condition, resolves who each
// active step goes to and why (the target and its members, AS-1), previews
// the assignment emails of the first step after the request form as the
// inbox a live submit would fill (DR-3), and, with the simulated clock moved
// forward, the reminders and the escalation that the first step fires by
// then (DR-4). It is pure and deterministic (I6): it reads the injected
// directory and the given time, writes no event and sends nothing (A6).

import type { ConditionData } from './condition.js'
import type { FlowDefinition, FlowStep, JsonValue } from './definition.js'
import type { Assignee } from './instance.js'
import type { ActorId } from './operation.js'
import type { OutboxEntry } from './outbox.js'
import { type ScheduledTimer, timersOfStep } from './reminders.js'
import { resolveAssignees, type TargetResolver } from './routing.js'
import { assignmentEmails } from './submission.js'
import { isStepSkipped, type SkippedStep } from './workflow.js'

/** What a dry run needs (DR-1): the definition, the data, who runs it, the directory and the clock. */
export type DryRunOptions = {
  readonly definition: FlowDefinition
  readonly data: ConditionData
  /** The person the run acts as: the starter of the request (DR-5 when it is not the requester). */
  readonly actor: ActorId
  readonly resolve: TargetResolver
  /** The simulated time the run starts at (I6). */
  readonly now: number
  /** How far the simulated clock moves forward after the start, in milliseconds (DR-4). */
  readonly advanceMs?: number
  /** The instance id the timers are keyed by (I3); the default names the dry run. */
  readonly instanceId?: string
}

/** One timer of the first step, and whether the moved clock fired it (DR-4). */
export type DryRunTimer = {
  readonly step: string
  readonly kind: ScheduledTimer['kind']
  readonly fireAt: number
  readonly fired: boolean
}

export type DryRunResult = {
  readonly route: {
    readonly active: readonly string[]
    readonly skipped: readonly SkippedStep[]
  }
  /** Who each active step resolves to, and through which target (S08, AS-1). */
  readonly assignees: readonly Assignee[]
  /** The step a submit routes to: the first active step after the request form. */
  readonly next?: string
  /** The preview inbox (DR-3): the assignment emails of the next step, then the timer emails the clock fired. */
  readonly intents: readonly OutboxEntry[]
  readonly timers: readonly DryRunTimer[]
}

/** The value of a field as a condition reads it. */
function dataOf(values: ConditionData): Record<string, JsonValue> {
  return values as Record<string, JsonValue>
}

export function dryRun(options: DryRunOptions): DryRunResult {
  const { definition, data, resolve } = options
  const active: FlowStep[] = []
  const skipped: SkippedStep[] = []
  for (const step of definition.steps) {
    if (step.skipWhen !== undefined && isStepSkipped(step, dataOf(data))) {
      skipped.push({ step: step.key, condition: step.skipWhen })
      continue
    }
    active.push(step)
  }
  const assignees = active.flatMap((step) => resolveAssignees(step, resolve))
  const next = active[1]
  const nextAssignees =
    next === undefined ? [] : assignees.filter((entry) => entry.step === next.key)
  const intents: OutboxEntry[] = next === undefined ? [] : [...assignmentEmails(nextAssignees)]
  const timers: DryRunTimer[] = []
  if (next !== undefined) {
    const to = nextAssignees.flatMap((entry) => entry.members)[0]
    const scheduled = timersOfStep(next, {
      instance: options.instanceId ?? 'dry-run',
      since: options.now,
      ...(to === undefined ? {} : { to }),
    })
    const until = options.now + (options.advanceMs ?? 0)
    for (const timer of scheduled) {
      const fired = (options.advanceMs ?? 0) > 0 && timer.fireAt <= until
      timers.push({ step: next.key, kind: timer.kind, fireAt: timer.fireAt, fired })
      if (fired) intents.push(timer.entry)
    }
  }
  return {
    route: { active: active.map((step) => step.key), skipped },
    assignees,
    ...(next === undefined ? {} : { next: next.key }),
    intents,
    timers,
  }
}
