// Issue #256, I8, I4, VT-5, VT-6, S16, DX-3: the authorized read of the log.
//
// The log is one sequence in one global order (I4), and every read is
// authorized (I8). A principal reads the events of the instances it may read
// (`mayRead`: its own, the ones it is assigned to, the flows it holds
// `instance.read` on; a draft stays private to its starter), the configuration
// changes of the flows it holds `instance.timeline` on (VT-5), and everything
// with `org.grants` on `org`. An event that names neither an instance nor a
// flow (a principal update, a seed clear) is the organization's and needs
// `org.grants`. A filter by instance and a limit serve `enform log --instance
// <id> --limit <n>` (S16, DX-3). The function is pure and deterministic (I6).

import { authorize, type Grant } from './authorize.js'
import { publishedByHash } from './flow.js'
import { instanceOf, type ProjectedInstance } from './instances.js'
import type { ActorId, Event, Log } from './operation.js'
import { refreshLiveTargets } from './resolve.js'
import type { TargetResolver } from './routing.js'
import { mayRead } from './status.js'
import { flowOf, isConfigChange } from './timeline.js'

/** What a log read needs beside the actor (I8): its grants, the directory, and the optional filters. */
export type LogReadOptions = {
  /** The grants that apply to the acting principal (AC-1, I8). */
  readonly grants: readonly Grant[]
  /** The directory resolver, so a live group or team target names its current members (AS-4). */
  readonly resolve?: TargetResolver
  /** Only the events of this instance (S16). */
  readonly instanceId?: string
  /** Only the events of this flow (#260, RT-1): its configuration changes and its instances' events. */
  readonly flow?: string
  /** Only the newest `limit` events of the result (S16). */
  readonly limit?: number
}

/**
 * The events of the log that one principal may read, in log order (I8, I4).
 * An administrator (`org.grants` on `org`) reads everything. Otherwise an
 * event of an instance is readable when the instance is (`mayRead`, with the
 * live targets refreshed through the resolver), a configuration change of a
 * flow is readable with `instance.timeline` on that flow, and any other event
 * is not. The instance filter keeps that instance's events, and the limit
 * keeps the newest ones.
 */
export function readableLog(log: Log, actor: ActorId, options: LogReadOptions): readonly Event[] {
  const admin = authorize(options.grants, 'org.grants', 'org')
  const readable = new Map<string, boolean>()
  const instanceReadable = (instanceId: string): boolean => {
    const known = readable.get(instanceId)
    if (known !== undefined) return known
    const instance = instanceOf(log, instanceId)
    const published =
      instance === undefined ? undefined : publishedByHash(log, instance.definitionVersion)
    const allowed =
      instance !== undefined &&
      published !== undefined &&
      mayRead(actor, refreshLive(instance, options.resolve), {
        flow: instance.flow,
        definition: published.definition,
        log,
        grants: options.grants,
      })
    readable.set(instanceId, allowed)
    return allowed
  }
  const flowMatches = (event: Event): boolean =>
    options.flow === undefined ||
    flowOf(event) === options.flow ||
    instanceFlow(event) === options.flow
  const instanceFlow = (event: Event): string | undefined => {
    const instanceId = event.payload.instanceId
    return typeof instanceId === 'string' ? instanceOf(log, instanceId)?.flow : undefined
  }
  const events = log.filter((event) => {
    if (!flowMatches(event)) return false
    const instanceId = event.payload.instanceId
    if (typeof instanceId === 'string') {
      if (options.instanceId !== undefined && options.instanceId !== instanceId) return false
      return admin || instanceReadable(instanceId)
    }
    if (options.instanceId !== undefined) return false
    if (admin) return true
    if (!isConfigChange(event.type)) return false
    const flow = flowOf(event)
    return flow !== undefined && authorize(options.grants, 'instance.timeline', `flow:${flow}`)
  })
  if (options.limit === undefined || options.limit < 0 || options.limit >= events.length)
    return events
  return events.slice(events.length - options.limit)
}

/** The instance with its live targets refreshed through the resolver (AS-4); unchanged without one. */
function refreshLive(
  instance: ProjectedInstance,
  resolve: TargetResolver | undefined
): ProjectedInstance {
  if (resolve === undefined) return instance
  return { ...instance, assignees: refreshLiveTargets(instance.assignees, resolve) }
}
