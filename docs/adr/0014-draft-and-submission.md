# 0014: A start creates a private draft; a submit routes it

| Field | Value |
|---|---|
| Status | Accepted |
| Date | 2026-11-05 |
| Refs | S06, S07, FM-4, FM-7, RT-3, RT-5, VT-4, SE-1, SE-2, D1, I2, I5, I8, ADR 0010 |

## Context

The glossary of `MVP.md` defines a draft as an instance before submission, whose contents only its author can see (D1, VT-4). S06 starts a draft with `enform instance start` and submits it with `enform instance submit`. RT-3 makes drafts local first: the browser saves each edit on the device and sends it to the server as an idempotent operation, and RT-5 queues a submission made offline. FM-4 runs every rule and validation again at each submission.

Before this decision the engine had two models at once. The start routed the instance to the first step whose skip condition was false and recorded its assignees, so an assignee could read a draft before its author submitted it, and nothing validated the values a start recorded (#202). The demo seed and the interface modelled the request form as a first step that the starter claimed and completed, and the `instance.submitted@1` event only set a flag and recorded the assignment email after that completion. Neither model let a browser stream edits to a draft, and the live path sent no task-assigned email.

## Decision

The request form is the first step of the definition. A start (`instance.started@1`) creates a draft on it: the instance records the starter, the values it holds and the first step as its current step, and it routes nothing. While the instance is a draft, only its starter may read its contents, no task row exists, and the engine refuses a claim, a completion, a send back and a takeover on it. The starter edits a draft with `draft.edited@1` operations, each a merge of values with a client-created id (I1), so a browser can send one operation per edit (RT-3).

A submit (`instance.submitted@1`) is the starter's completion of the request form. The engine validates the values against the first step's fields and rules (FM-4), refuses with every error named by path, and otherwise records the first step as completed, routes to the next step whose skip condition is false (or the Unroutable queue), records the assignees, the skipped steps and the merged values, and carries the task-assigned email of each assignee in the same operation (I2, SE-2). A completion of a later step records the task-assigned email of the next step's assignees in the same way.

An unsubmitted draft appears only in its starter's Started by me tab, as a draft. A draft that is withdrawn is discarded. A send back to the request form makes the instance a draft again: the starter corrects it and submits it again through the same submit, which records the next revision of the request form (WF-3).

## Alternatives

- **Keep routing at the start and validate the start's values.** Rejected. A local-first draft is created on the first keystroke, when the values cannot be valid yet, and the route would be decided on values the author is still typing.
- **Model submission as the starter claiming and completing the first step.** Rejected. It needs a `step.outcome` grant and a claim for the author's own form, and it leaves `instance.submitted@1` without a meaning.
- **A draft table outside the log.** Rejected by I4 and D3: a draft edit is a change that must rebuild from the log.

## Consequences

- Easier: one submission path for the CLI, the API and the browser, one place for the request form's validation, and a draft that is honestly private.
- Harder: the start, the submit and the completion change shape before the first release (`MVP.md` 9.3), and every scenario, projection and test that started an instance and claimed it at once now submits first.
- Constraint: the first step of a definition is the request form; a flow whose first step targets someone other than the starter still starts as the starter's draft.
