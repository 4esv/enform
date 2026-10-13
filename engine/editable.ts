// Issue #191, FM-3, FM-4, I8, AS-2, AS-4, A9: the field keys a step makes
// editable for an actor.
//
// FM-3: each step sets which fields are editable. FM-4: the server runs the
// rule again at each submission and does not trust client state, so the check
// lives in the engine only (A9). The step-scoped read (`readInstance`) and the
// completion (`complete`) call the same function, so a field the read does not
// list in `editable` is exactly a field a completion refuses, and the read and
// the write cannot disagree.
//
// The function is pure and deterministic (I6): it reads only its arguments,
// never the clock or a random source.

import type { FlowStep } from './definition.js'
import type { Instance } from './instance.js'
import type { ActorId } from './operation.js'

/**
 * The field keys the actor may edit on the step (FM-3). A step that declares
 * no `editable` makes no field editable, and only an assignee of the step gets
 * the editable keys; an actor that may read but is not an assignee gets an
 * empty list. The definition parser guarantees that every key names a field of
 * the step (FM-3), so a key of another step is never editable here.
 */
export function editableKeys(
  actor: ActorId,
  instance: Instance,
  step: FlowStep
): readonly string[] {
  if (step.editable === undefined) return []
  if (!isStepAssignee(actor, instance, step.key)) return []
  return step.editable
}

/** Whether the actor is an assignee of one step (AS-2, AS-4). */
function isStepAssignee(actor: ActorId, instance: Instance, step: string): boolean {
  return instance.assignees.some(
    (assignee) => assignee.step === step && assignee.members.includes(actor)
  )
}
