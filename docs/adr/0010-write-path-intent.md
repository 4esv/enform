# 0010: Resolve client intents on the write path

| Field | Value |
|---|---|
| Status | Accepted |
| Date | 2026-10-11 |
| Refs | DX-1, ADR 0004, A9, I13, WF-1, DF-2, FM-7 |

## Context

ADR 0004 makes every change an operation with an ID that the client creates, so a retry is idempotent. DX-1 makes `POST /api/v1/operations` the public write path, and I12 keeps the interface away from engine internals by giving it only the generated API client. A start is not a plain append: the engine routes the draft to the first step whose skip condition is false (WF-1), resolves the assignees (I13), stamps the instance with the published version's content hash (DF-2), records the starter, and records the values that the form holds (FM-7). The first browser form (#181) therefore had to fabricate the two engine decisions it cannot make, `currentStep` and `assignees`, and post them as a resolved `instance.started@1` operation. A9 calls that a defect: a GUI feature must be a sequence of API calls, and each GUI step must map to an engine step.

## Decision

A client writes an intent: the operation ID it chose, the event type, the actor, and the values it honestly knows. The server resolves the rest through the engine before it appends, and the appended event keeps the client's ID.

## Alternatives

- **A command endpoint per intent.** Rejected. The operation log already expresses every change, so a second write path would duplicate it and weaken the one idempotent append.
- **The client resolving the routing itself.** Rejected. The client cannot resolve assignees or choose the start step, and A9 forbids putting correctness in the interface.
- **Store the intent and resolve it later.** Rejected. An event is a fact, not a request; the log records the resolved occurrence, never a deferred wish.

## Consequences

- Easier: a browser posts only the flow slug and its values, and a GUI step equals the engine step that the API appends, so S06 and gui mode compare one step to one step.
- Harder: the server must resolve intents through the engine before appending, and a release server must inject the directory resolver and the grants it reads from the log.
- Constraint: the engine owns routing, authorization, version stamping and the starter; the client may send only the intent envelope and the values it honestly knows, and the appended event keeps the client's ID and time.
