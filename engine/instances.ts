// Issue #76, FM-3, FM-7, VT-4, S14, DF-2, DX-1, I4, I6, I8, A9: the read half
// of FM-3, the instance as a step sees it, through the public API. The shape
// lands first, so the checks below compile: the projection and the step-scoped
// read answer undefined until the implementation lands, and the checks that
// expect a view fail as marked.

import type { JsonValue } from './definition.js'
import type { Instance } from './instance.js'
import type { ActorId, Log } from './operation.js'
import type { Status, StatusContext } from './status.js'

/**
 * An instance that the projection found on the log (#76, FM-3, DX-1). It always
 * names the instance id, because `instanceOf` finds the start event by that id.
 */
export type ProjectedInstance = Instance & { readonly instanceId: string }

/**
 * The instance as one actor and one step see it (#76, FM-3, FM-7, VT-4, I8).
 */
export type InstanceView = {
  readonly instanceId: string
  readonly status: Status
  readonly visible: readonly string[]
  readonly editable: readonly string[]
  readonly values: Readonly<Record<string, JsonValue>>
}

/** Project the log into one instance (#76); the implementation follows. */
export function instanceOf(_log: Log, _instanceId: string): ProjectedInstance | undefined {
  return undefined
}

/** Read the instance as one actor and the current step see it (#76); the implementation follows. */
export function readInstance(
  _actor: ActorId,
  _instance: ProjectedInstance,
  _context: StatusContext
): InstanceView | undefined {
  return undefined
}
