import { STEP_COMPLETED } from '../../engine/action.js'
import type { Grant } from '../../engine/authorize.js'
import type { ConditionData } from '../../engine/condition.js'
import { type FlowDefinition, parse } from '../../engine/definition.js'
import type { Flow, FlowVersion } from '../../engine/flow.js'
import { type ConnectorCall, contentHash } from '../../engine/instance.js'
import type { Event, Log } from '../../engine/operation.js'
import type { OutboxEntry } from '../../engine/outbox.js'
import type { TargetResolver } from '../../engine/routing.js'
import { EMAIL_CONNECTOR } from '../../engine/submission.js'
import { SENT_OUTCOME } from '../../engine/undo.js'

// S16: undo a mistake (STORIES.md). Lee approves the wrong course-overload
// request at the registrar step, and the flow's automation sends the student a
// confirmation email and the decision as a PDF, with a copy to the coordinator
// (SE-1, I2). Lee undoes the approval, because one wrong click must not damage
// the semester of a student. The undo is a compensating event (WF-5, A2, D6):
// the engine appends an `event.undone@1` event, and the approval stays in the
// log (I4). The emails already went out, so the undo does not reverse them: it
// marks them "Already sent" and notifies the people they reached (S16, A2). The
// flow marks a point final, a later schema change, so the story injects the
// final point; once the flow moved past it the engine refuses the undo and
// gives the reason (S16, WF-5). The path is deterministic (I6): it reads no
// clock and no random source, and the directory is injected.

/** The flow slug of the story (STORIES.md, the example flow). */
export const SLUG = 'course-overload'

/** Sam, the student who starts the request (S06). */
export const STARTER = 'user:sam'

/** Dr. Okafor, the advisor of Sam: he acts on the advisor step (S08, AS-1). */
export const OKAFOR = 'user:okafor'

/** Lee, registrar staff: he approves the wrong request (S16). */
export const LEE = 'user:lee'

/** Ana, registrar staff, a peer of Lee in the registrar team (S10). */
export const ANA = 'user:ana'

/** Priya, the department coordinator: she gets the copy of a decision (S14, S16). */
export const PRIYA = 'user:priya'

/** The worker, which records the connector calls that it ran (SE-1, I13). */
export const SYSTEM = 'system'

/** The team that holds the registrar task (AS-1, AS-4). */
export const REGISTRAR_TEAM = 'registrar-office'

/** The three steps of the story: the request, the advisor, then the registrar (WF-1). */
export const REQUEST_STEP = 'request'
export const ADVISOR_STEP = 'advisor'
export const REGISTRAR_STEP = 'registrar'

/** The resource of each step (MVP.md 5.6). */
export const REQUEST_RESOURCE = `flow:${SLUG}/step:${REQUEST_STEP}`
export const ADVISOR_RESOURCE = `flow:${SLUG}/step:${ADVISOR_STEP}`
export const REGISTRAR_RESOURCE = `flow:${SLUG}/step:${REGISTRAR_STEP}`

/** The outcome that submits the request (WF-1). */
export const SUBMIT = 'submit'

/** The outcome that approves a step (WF-2, S16). */
export const APPROVE = 'approve'

/** The members of the registrar team when the request reaches it (AS-1, I13). */
export const REGISTRAR_MEMBERS: readonly string[] = [LEE, ANA]

/** The definition of version 1: the request, the advisor and the registrar (WF-1). */
export const definition: FlowDefinition = parse(`{
  "schemaVersion": 1,
  "steps": [
    {
      "key": "${REQUEST_STEP}",
      "targets": [{ "starter": "starter" }],
      "outcomes": ["${SUBMIT}"]
    },
    {
      "key": "${ADVISOR_STEP}",
      "targets": [{ "field": "advisor" }],
      "outcomes": ["${APPROVE}", "send_back"]
    },
    {
      "key": "${REGISTRAR_STEP}",
      "targets": [{ "team": "${REGISTRAR_TEAM}" }],
      "outcomes": ["${APPROVE}", "reject", "send_back"]
    }
  ]
}
`)

/** The published version 1: a start needs a version with a content hash (DF-2). */
export const versionV1: FlowVersion = {
  version: 1,
  contentHash: contentHash(definition),
  definition,
}

/** The flow of the story: version 1 published, ready for a start (DF-2). */
export const flow: Flow = { slug: SLUG, versions: [versionV1] }

/** The data of Sam's request: no step has a skip condition, so the request step is first (WF-1). */
export const data: ConditionData = {}

/** The directory of the story (AS-1, I13): the starter, a field and a team resolve. */
export const resolve: TargetResolver = (target) => {
  if ('starter' in target) return [STARTER]
  if ('field' in target) return [OKAFOR]
  if ('team' in target) return REGISTRAR_MEMBERS
  return []
}

/** The grants that apply to Sam: the All-Students group may start the flow (S02, AC-1). */
export const starterGrants: readonly Grant[] = [
  { principal: STARTER, scopes: ['instance.start'], resource: `flow:${SLUG}` },
]

/** The grants that apply to Sam on the request step: he submits his own request (S06, WF-1). */
export const samGrants: readonly Grant[] = [
  { principal: STARTER, scopes: [`step.outcome:${SUBMIT}`], resource: REQUEST_RESOURCE },
]

/** The grants that apply to Dr. Okafor: he approves on the advisor step (S08, AC-4). */
export const okaforGrants: readonly Grant[] = [
  { principal: OKAFOR, scopes: [`step.outcome:${APPROVE}`], resource: ADVISOR_RESOURCE },
]

/** The grants that apply to Lee: he approves on the registrar step (S16, AC-4). */
export const leeGrants: readonly Grant[] = [
  { principal: LEE, scopes: [`step.outcome:${APPROVE}`], resource: REGISTRAR_RESOURCE },
]

/** The connector operation that sends the confirmation email of a template (SE-2, D7). */
export const CONFIRMATION_EMAIL = 'send-confirmation'

/** The connector operation that sends the decision as a PDF (SE-2, D7). */
export const DECISION_PDF = 'send-decision-pdf'

/** The connector operation that sends the coordinator the copy of a decision (SE-2, S14). */
export const OFFICE_COPY = 'send-office-copy'

/**
 * The side effects of the registrar approval (I2, SE-1): the confirmation email
 * to Sam, the decision as a PDF to Sam, and the copy to Priya. The approval
 * operation carries them, so one apply commits the decision and its side
 * effects together (I2).
 */
export const approvalOutbox: readonly OutboxEntry[] = [
  {
    operation: CONFIRMATION_EMAIL,
    target: EMAIL_CONNECTOR,
    payload: { to: STARTER, step: REGISTRAR_STEP },
  },
  {
    operation: DECISION_PDF,
    target: EMAIL_CONNECTOR,
    payload: { to: STARTER, step: REGISTRAR_STEP },
  },
  {
    operation: OFFICE_COPY,
    target: EMAIL_CONNECTOR,
    payload: { to: PRIYA, step: REGISTRAR_STEP },
  },
]

/**
 * The connector calls that the worker already ran for the approval (I13, A2).
 * The worker records each one on the log, so the undo reads them as the side
 * effects that already occurred.
 */
export const sentCalls: readonly ConnectorCall[] = approvalOutbox.map((entry, index) => ({
  operation: entry.operation,
  time: 1_700_000_000_000 + index * 60_000,
  outcome: SENT_OUTCOME,
}))

/**
 * The final point of the course-overload flow (S16, WF-5): a later flow setting
 * states it, so the story injects the predicate, as S10 injects the idle
 * timeout and S13 the undo period. The flow marks a decision final once a later
 * step of the flow decided (I4, the log is the one order), so the registrar
 * decision, the last step, stays undoable while the advisor decision does not.
 */
export const finalPoint = (event: Event, log: Log): string | undefined => {
  if (event.type !== STEP_COMPLETED) return undefined
  const step = event.payload.step
  if (typeof step !== 'string') return undefined
  const decidedLater = log.some(
    (candidate) => candidate.seq > event.seq && candidate.type === STEP_COMPLETED
  )
  if (!decidedLater) return undefined
  return `the flow decided a later step after the ${step} decision, so the flow passed the point that marks ${step} final (S16, WF-5)`
}
