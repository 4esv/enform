# Acting on work

<!-- description: The inbox with its three tabs, claiming and completing a task, sending back with a comment, takeover, release and reassign, withdrawing or cancelling a submission, and undoing any manual action within the flow's undo window. -->

Everything a person does to a submission is an attributed, versioned operation. Each one is visible in the timeline, and each manual one can be undone within the flow's undo window.

## The inbox

The inbox (`/?inbox=1`) has three tabs:

| Tab | Lists |
|---|---|
| My tasks | The tasks you hold. |
| Available | The tasks you may claim: the open tasks of the steps whose targets resolve to you. |
| Started by me | The submissions you started, with their status. |

A task shows the flow, the step, the holder or "unclaimed", the time it started, and its due time. The header shows the connection mode; see [Realtime and offline](realtime-offline.md).

## Start and submit

Open a flow (`/?flow=<slug>`) and fill in the request form. Each edit is saved on your device at once and sent as it lands; the draft is private to you until you submit. **Submit** validates on the server and routes the submission to its first task. "Started by me" then shows where it is.

If you may not start a flow, the server refuses the start and the page shows the refusal with the scope that would allow it.

## Claim and complete

On a task page, **Claim** makes you the holder. The form of the step shows the fields the step makes visible, with the editable ones open. The outcome buttons are the outcomes your scopes allow: with only `step.outcome:send_back` on a step you see only Send back, and an API request to approve answers 403.

Choosing an outcome completes the step with the values you captured and a comment, and the engine routes the instance to the next step, skips the steps whose conditions hold, and shows the result in the status line.

## Send back

**Send back** returns the submission to an earlier step with a comment. The author sees the comment on the field or at the top of the form, corrects the submission and submits again. The tracker shows the step as sent back and the timeline keeps both rounds.

## Takeover, release, reassign

- **Take over** a claimed task when the step allows it (always, after the holder has been idle for the set period, or never), with a reason. The previous holder is told.
- **Release** a task you hold back to the pool, so another eligible person can claim it.
- **Reassign** a task to a person, with a reason, when you are a flow owner (`task.reassign`). The Unroutable queue uses the same action.

## Withdraw and cancel

A starter can **withdraw** their own submission with a reason, when the flow allows it. A flow owner can **cancel** a submission with a reason. Both close the instance, cancel its timers in the same transaction, tell the holder, and show in "Started by me" and the timeline. Both can be undone within the window.

## Undo

Any manual action can be undone within the flow's undo window: a claim, a completion, a send back, a takeover, a withdrawal, a cancellation, a grant change. The timeline offers **Undo** on each event you may undo, and the page shows a toast with Undo right after an action. The engine adds a compensating event; nothing is deleted.

An undo of a completed step restores the step and its holder. A side effect that already went out, such as an email the worker sent, is marked "Already sent" rather than pretended away.

Who may undo: the actor of the event, a flow owner, and for a takeover also the person it took the task from.

## Messages

Below the timeline, the task page lists each email the engine recorded for the submission with the status the worker gave it: queued, sent, or failed with the last error. A flow owner sends one again with **Send again**; the log records who did. An administrator reads what each kind of message says, with its variables and a preview, on the templates page.

## The timeline and the change feed

Each instance has a timeline: every event in order, with the actor and the time, and a toggle that adds the changes to the flow's definition and configuration in the same order. The global change feed (`/?changes=1`) shows every attributed change across flows, filtered by flow and by type. Both read the one log, so they never disagree with the status line or the tracker.

## From the terminal

The same actions are CLI commands: `enform task list|show|claim|complete|takeover|release|reassign`, `enform instance start|edit|submit|show|timeline|withdraw|cancel|undo`, `enform undo <event-seq>` and `enform log`. See the [CLI reference](cli.md).
