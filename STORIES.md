# enform: Stories

This document describes the golden paths of enform from the point of view of each person. Each story is an acceptance test. A requirement in `MVP.md` is done only when each story that cites it passes.

Each story has two layers:

1. **Engine path.** The story through the CLI and the HTTP API. This is the proof.
2. **Interface path.** The same story through the GUI. Each GUI step must map to engine steps. If a GUI step does not map, the GUI is incorrect.

The engine path passes before work on the interface path starts.

## Contents

1. [Rules](#rules)
2. [Test method](#test-method)
3. [Evidence](#evidence)
4. [Cast](#cast)
5. [Example flow](#example-flow)
6. [Part 1: Build](#part-1-build)
7. [Part 2: Submit and route](#part-2-submit-and-route)
8. [Part 3: Act on work](#part-3-act-on-work)
9. [Part 4: Know what happened](#part-4-know-what-happened)
10. [Traceability](#traceability)

## Rules

- Story IDs (`S01` and up) are permanent. Do not reuse them. A withdrawn story stays in this document with the label **Withdrawn**.
- Each acceptance criterion uses the form Given, When, Then. Each criterion becomes one or more automated tests in `stories/S<nn>-<slug>/`. The slug is in the story heading.
- **Measures** make a golden path measurable. CI checks the measures that it can check. The pilot checks the others.
- **Refs** cite the requirements and invariants of `MVP.md` that the story uses.
- Tests use `--json` output. The human-readable output in this document is an example.
- A story does not add scope. If a story needs something that `MVP.md` does not contain, amend `MVP.md` first.

## Test method

Stories are the center of the test suite. The golden path of each story is fixed. All other tests are controlled variations of it.

### Golden path

Each story has one executable scenario: `stories/S<nn>-<slug>/scenario.ts`. The scenario uses the public API. Its steps match the story: a person acts, then a condition must be true.

Golden paths are deterministic (I6). If a golden path is flaky, the engine or the scenario has a defect. Do not retry it until it passes.

The scenario runs in four modes. Where the modes overlap, the results must be equal.

| Mode | Execution |
|---|---|
| `api` | The scenario against the HTTP API. |
| `cli` | The same steps through the CLI with `--json`. |
| `dry` | The same steps as a dry run. The side-effect intents must equal those of `api` (I7). |
| `gui` | The same steps in a browser. This mode starts when the interface path exists. |

### Fuzzy paths

Variation operators generate fuzzy paths from each golden path. Do not write fuzzy tests by hand.

| Operator | Variation |
|---|---|
| Actor | Do each step as each person in the cast. The expected result comes from the scopes of that person: success, or an authorization failure. |
| Duplicate | Send each operation two times. Deliver each job two times. The end state does not change (I1, I3). |
| Race | Add a competing action by another person at each step: two claims, claim and takeover, edit and publish. |
| Fault | At each step boundary, stop the realtime connection, stop the worker, or restart the server. |
| Offline | Do the steps of a person without a connection. Refresh during the steps. Then reconnect. |
| Clock | Move the clock forward, move it back, or skew it, near deadlines and idle limits. |
| Data | Generate valid and invalid form data from the flow schema, with property-based generation. |
| Version | Publish a new definition version between two steps. |

### Oracles

The suite checks each run, golden or generated, in this order:

1. All invariants (I1 to I16) are true. This check does not depend on the variation.
2. The end state is equal to the golden end state, or to the deviation that the operator predicts. Examples: an authorization failure, or a refused takeover with the remaining time.
3. The timeline is consistent. Each state change has an attributed event. All events are in one global order.

### Failures

When a fuzzy run fails:

1. Minimize it to the smallest variation that fails.
2. Add it to the story as a named variant, for example `S10.v3: takeover races release`, with its own fixture.
3. The variant runs at each change, as the golden path does.

The suite grows from real failures. Each failure stays with the story that it broke.

### Coverage

Coverage is the matrix of story, operator and mode. The build writes it to `stories/MATRIX.md`. CI fails if:

- an in-scope requirement has no story and no requirement test,
- a story does not run under an operator that applies to it, or
- a matrix cell is skipped without a written reason in the story.

## Evidence

This table records where each story was done. Update it in the same pull request as the work. Use issue numbers (`#12`), test paths and commit hashes. A story is **Done** when both paths pass.

| Story | Engine issue | Engine tests | Engine commits | Interface issue | Interface commits | Status |
|---|---|---|---|---|---|---|
| S01 | #38 | stories/S01-publish-flow/scenario.test.ts | ad5ddca eac5f63 58750b7 | | | Engine in progress |
| S02 | #39 | stories/S02-grant-scopes/scenario.test.ts | 5383f8c | | | Engine in progress |
| S03 | #40 | stories/S03-edit-text/scenario.test.ts | e436106 | | | Engine in progress |
| S04 | #41 | stories/S04-add-field-live/scenario.test.ts | c38bb5e | | | Engine in progress |
| S05 | #42 | stories/S05-skip-step/scenario.test.ts | 501e5e3 | | | Engine in progress |
| S06 | #43 | stories/S06-start-submission/scenario.test.ts | 7d0b973 | | | Engine in progress |
| S07 | #44 | | | | | Not started |
| S08 | #45 | stories/S08-route/scenario.test.ts | c3d8025 | | | Engine in progress |
| S09 | #46 | stories/S09-claim-approve/scenario.test.ts | 8888d67 | | | Engine in progress |
| S10 | #47 | stories/S10-takeover/scenario.test.ts | d165932 | | | Engine in progress |
| S11 | #48 | stories/S11-send-back/scenario.test.ts | 981b365 | | | Engine in progress |
| S12 | #49 | stories/S12-reminders-escalation/scenario.test.ts | e85a55b | | | Engine in progress |
| S13 | #50 | stories/S13-withdraw-cancel/scenario.test.ts | 0194b88 | | | Engine in progress |
| S14 | #51 | stories/S14-find-status/scenario.test.ts | 4cb4d49 | | | Engine in progress |
| S15 | #52 | stories/S15-investigate/scenario.test.ts | 2768a41 | | | Engine in progress |
| S16 | #53 | stories/S16-undo/scenario.test.ts | 5bf4a30 | | | Engine in progress |

Status values: Not started, Engine in progress, Engine passes, Interface in progress, Done.

## Cast

The cast are people, not roles. Their grants give their capabilities.

| Person | Situation | Grants (example) |
|---|---|---|
| Dana | Developer. Maintains enform at the institution. | `org.grants`, `org.connectors`, `org.teams`, `org.impersonate`, and `flow.build` on all flows |
| Priya | Department coordinator. Owns the overload flow. | On `course-overload`: `flow.edit`, `flow.dryrun`, `instance.read`, `instance.timeline`, `task.reassign` |
| Sam | Student. | `instance.start` on `course-overload`, through the group `All-Students` |
| Dr. Okafor | Advisor of Sam. | Target of step `advisor` by field. `step.outcome:approve` and `step.outcome:send_back` on that step. |
| Dr. Lin | Chair of Computer Science. | Member of `CS-Chairs`. `step.outcome:approve` and `step.outcome:send_back` on step `chair`. |
| Lee, Ana | Registrar staff. Peers. | Members of team `registrar-office`. `step.outcome:approve` and `step.outcome:reject` on step `registrar`. |
| Jordan | Registrar reviewer. | Member of `registrar-office`. `step.outcome:send_back` only. Jordan is a reviewer, not an approver. |

## Example flow

All stories use one flow, so that they share fixtures.

**`course-overload`**: a student asks for permission to take more credits than the standard limit.

| Step | Targets | Notes |
|---|---|---|
| `request` | `starter` | Sam fills in the form. |
| `advisor` | `field:advisor` | Approve or send back. |
| `chair` | group `CS-Chairs` | Skipped when `overload_credits <= 2`. |
| `registrar` | team `registrar-office` | Approve or reject. Takeover is allowed after 4 hours of idle time. |

## Part 1: Build

### S01: Create and publish a flow (`publish-flow`)

> As Dana, I want to define a flow as a file, test it and publish it, so that a new process starts without the GUI.

**Engine path**

```sh
enform login                                   # SSO device flow
enform flow init course-overload               # writes course-overload.flow.json in canonical form
# edit the file
enform flow validate course-overload.flow.json # schema, rule compilation, target resolution
enform flow push course-overload.flow.json     # file differences become operations on the draft
enform flow dry-run course-overload --data fixtures/sam.json --as sam --as okafor --as lee
enform flow publish course-overload            # version 1, hash a1b2c3
```

**Interface path.** Dana creates the flow in the builder. She adds sections, fields and steps. She does a dry run from the builder toolbar. She publishes.

**Acceptance**

- Given a valid file, when Dana pushes it, then the draft definition is equal to the file. A pull gives an identical file, byte for byte.
- Given an invalid file, when Dana validates it, then the command exits with a non-zero code, names each error by path, and changes nothing on the server.
- Given a draft, when Dana publishes, then an immutable version with a content hash exists. The change feed shows "Dana published v1".
- Given a published version, when Dana pushes more changes, then instances in progress stay on v1.

**Measures.** A developer who reads the documentation for the first time goes from `init` to a published two-step flow in less than 10 minutes. `push` and `validate` each take less than 2 seconds.

**Refs.** ID-1, DF-1, DF-2, DF-4, DR-1, DR-5, DX-3, VT-6, I9, I14

### S02: Grant access by scope (`grant-scopes`)

> As Dana, I want to give each person the correct abilities, so that reviewers cannot approve and coordinators cannot rebuild flows.

**Engine path**

```sh
enform grant add group:All-Students   instance.start         flow:course-overload
enform grant add user:lee             step.outcome:approve,step.outcome:reject flow:course-overload/step:registrar
enform grant add user:ana             step.outcome:approve,step.outcome:reject flow:course-overload/step:registrar
enform grant add group:CS-Chairs      step.outcome:approve,step.outcome:send_back flow:course-overload/step:chair
enform grant add user:jordan          step.outcome:send_back flow:course-overload/step:registrar
enform grant add user:priya           flow.edit,flow.dryrun,instance.read,instance.timeline,task.reassign flow:course-overload
enform grant list flow:course-overload
```

**Interface path.** The flow has a Sharing panel. Presets such as "Approver" fill in scopes. The panel shows the stored result as a list of scopes.

**Acceptance**

- Given Jordan has only `step.outcome:send_back` on the registrar step, when Jordan claims a registrar task, then the only available outcome is Send back. An API request to approve returns 403.
- Given a grant made through a GUI preset, when the API lists grants, then only scopes show.
- Each grant change shows in the change feed, with an author and a time.

**Measures.** One CLI command or one panel answers "Who can approve at the registrar step?". Nobody reads code.

**Refs.** AC-1 to AC-4, VT-6, I8, I14

### S03: Edit the text of a form (`edit-text`)

> As Priya, I want to correct a typing error and add a dropdown option, so that I do not need a ticket for Dana.

**Engine path**

```sh
enform flow pull course-overload
# edit a label and add an option
enform flow push course-overload.flow.json
enform flow publish course-overload   # allowed: edit-class changes only
```

**Interface path.** Priya opens the builder. Structural controls are disabled for her. She edits the label in place and adds the option. If Dana is in the flow, Priya sees the cursor of Dana. Priya publishes.

**Acceptance**

- Given Priya has `flow.edit` and not `flow.build`, when she changes a label or an option, then the push succeeds.
- Given the same grants, when her push adds a field, then the engine rejects it. The message names the structural change and the necessary scope.
- Given Priya and Dana edit the same draft at the same time, then nobody is blocked. Each sees the changes of the other live. The version difference shows the author of each change.

**Measures.** A label change takes less than 2 minutes, from builder open to publication. No edit by Priya or Dana is lost.

**Refs.** DF-3, DF-5, DF-6, RT-2, D2, A1, I1, I14

### S04: Add a field while submissions are in progress (`add-field-live`)

> As Dana, I want to add a required field to a live flow, so that the process can change and drafts do not break.

**Engine path**

```sh
# add the required field reason_category to the request step
enform flow push course-overload.flow.json
enform flow diff course-overload --from v1 --to draft
enform flow publish course-overload   # version 2
```

**Interface path.** Dana adds the field and publishes. Sam has an open draft on v1. He sees a notice: "This form changed. One new field needs your answer."

**Acceptance**

- Given instances that were submitted on v1, when v2 is published, then they continue on v1 with no change.
- Given a draft on v1 that is not submitted, when Sam opens it again, then it moves to v2. It keeps each value that fits. It highlights the new required field. It shows each value that does not fit, and does not delete it.
- The difference from v1 to v2 shows the new field.

**Refs.** DF-2, DF-6, RT-6, A7

### S05: Skip a step when a condition is true (`skip-step`)

> As Dana, I want the chair to skip small overloads, so that chairs see only the requests that need them.

**Engine path**

```json
{ "key": "chair", "targets": [{ "group": "CS-Chairs" }],
  "skipWhen": { "<=": [{ "var": "overload_credits" }, 2] } }
```

```sh
enform flow dry-run course-overload --data fixtures/overload-2.json   # chair: skipped
enform flow dry-run course-overload --data fixtures/overload-4.json   # chair: active
```

**Interface path.** The step settings have a condition builder: "Skip this step when [Overload credits] [≤] [2]". The dry-run panel shows the skipped step in grey, with the reason.

**Acceptance**

- Given `overload_credits = 2`, when the advisor approves, then the instance goes directly to `registrar`. The timeline records "chair skipped: overload_credits ≤ 2".
- Given `overload_credits = 4`, then `chair` becomes active.
- Dry run and live give the same routing for both fixtures.

**Refs.** WF-1, FM-5, DR-1, I6, I7, I13

## Part 2: Submit and route

### S06: Start a submission (`start-submission`)

> As Sam, I want to open the form link, fill it in and submit it, so that my request starts and I know that it arrived.

**Engine path**

```sh
enform instance start course-overload --data fixtures/sam.json   # creates a draft
enform instance submit <id>
enform instance show <id>   # state: in progress; step: advisor; holder: Dr. Okafor (unopened)
```

**Interface path.** Sam opens a link while he is not signed in. SSO signs him in and returns him to the form. As he types, each field shows "Saved on this device", then "Synced". He submits. The step tracker shows "Waiting for Dr. Okafor. Not opened."

**Acceptance**

- Given Sam is not signed in, when he opens the link, then SSO signs him in and he returns to the same form. The engine never creates an anonymous draft.
- Given Sam does not have `instance.start`, then he sees "You cannot start this form" and the name of the flow owner. He does not see an empty form.
- After submission, the outbox contains an assignment email to Dr. Okafor, in the same transaction. Its status is visible.

**Measures.** From link to submission, there are no screens other than SSO and the form. Submissions without sign-in: 0.

**Refs.** ID-2, ID-3, RT-3, SE-1, VT-2, I2, I15

### S07: Lose the connection during fill-in (`lose-connection`)

> As Sam, on a bad day with no signal, I want my typing to survive network loss and accidental refreshes, so that I never fill in a form two times.

**Engine path (simulation test).** Apply operations. Stop the transport. Apply more operations locally. Reconnect. Send all operations again. The server state must equal the local state, with each operation applied one time.

**Interface path.** The connection indicator changes from live, to degraded, to offline. Sam continues to type. Fields show "Saved on this device". He refreshes and all data is there. He submits while offline. He sees "Will submit when you are back online". The connection returns and the submission completes.

**Acceptance**

- Given 50 edits made offline, when the connection returns, then all 50 edits arrive at the server, each one time.
- Given a refresh while offline, then the form loads from local encrypted storage in less than 1 second.
- Given Sam signs out on a shared computer, then the local draft is deleted. The server copy stays, if it was synchronized.
- Given the server rejects an offline submission when it arrives, then Sam sees the reason and the draft is complete.

**Refs.** RT-1, RT-3, RT-4, RT-5, I1, I11, I15, I16

**Modes.** The `cli` cell is skipped. The engine path is a transport simulation, and the CLI has no transport to interrupt.

### S08: Route to the correct people (`route`)

> As Dana, I want each task to go to real, current people, so that no task waits for a person who left or does not exist.

**Engine path**

```sh
enform flow dry-run course-overload --data fixtures/sam.json --explain-routing
# advisor   → field:advisor          → user:okafor (resolved at creation)
# registrar → team:registrar-office  → lee, ana, jordan (resolved live)
```

**Interface path.** For each step, the dry-run panel shows who gets the task and why.

**Acceptance**

- Given `field:advisor` names a deprovisioned user, when the step starts, then the task goes to the Unroutable queue. Priya gets an alert in less than 5 minutes. The timeline gives the reason.
- Given Ana joins `registrar-office` while a registrar task is open, then the task shows in her Available tab. No publication is necessary.
- Each instance records the resolved assignees and the membership snapshot at the time of resolution.

**Refs.** AS-1, AS-4, AS-5, ID-4, ID-5, I10, I13

## Part 3: Act on work

### S09: Claim and approve (`claim-approve`)

> As Lee, I want to see the work available to my team, claim one task and approve it, so that work moves and nobody is locked out.

**Engine path**

```sh
enform task list --available
enform task claim <task>
enform task complete <task> --outcome approve --comment "Within policy"
```

**Interface path.** The Available tab of Lee shows the task as unopened. To open the task does not claim it. Ana can open it at the same time. She sees "Lee is viewing". Lee selects Claim, then Approve.

**Acceptance**

- Given Lee and Ana both open the task, then nobody is blocked from viewing.
- Given both select Claim at the same time, then exactly one claim succeeds. The other person sees "Claimed by Lee just now" and, if the step allows it, a Take over action.
- Given Lee has a stale view, when he completes the task, then the version check rejects it and asks him to refresh. There is no second approval.

**Measures.** An approval takes 3 interactions or fewer from the inbox.

**Refs.** AS-2, AC-4, RT-2, VT-1, I5, I8

### S10: Take over from a peer on vacation (`takeover`)

> As Ana, I want to take a task that Lee claimed before his vacation, so that the student does not wait a week and no administrator must help.

**Engine path**

```sh
enform task show <task>          # claimed by lee, idle 2 days; takeover: allowed after PT4H
enform task takeover <task> --reason "Lee is out until 10/19"
```

**Interface path.** The task shows "Claimed by Lee. Idle 2 days." Ana selects Take over and types a reason. The task is now hers. Lee gets a notification.

**Acceptance**

- Given the step allows takeover after 4 hours of idle time, and Lee is idle for longer, then the takeover by Ana succeeds. No administrator is necessary.
- Given Lee was active 10 minutes ago, then the engine refuses the takeover and shows the remaining time.
- The timeline records who took the task, from whom, when and why. Lee gets a notification.
- Lee, or Priya with `task.reassign`, can undo the takeover.

**Measures.** Administrator actions necessary to move work between peers: 0.

**Refs.** AS-3, WF-5, A1, A2, I14

### S11: Send back for revision (`send-back`)

> As Dr. Okafor, I want to send the request of Sam back with a note, so that he can correct it and does not start again.

**Engine path**

```sh
enform task complete <task> --outcome send_back --to request --comment "Attach your degree audit"
enform instance show <id>   # step: request (revision 2); holder: sam
```

**Interface path.** Dr. Okafor selects Send back, selects the step and writes a note. Sam gets an email. The request shows in his inbox, with the note above the form. When he submits again, Dr. Okafor sees revision 1 and revision 2 in the timeline.

**Acceptance**

- Given a send back without a comment, then the engine rejects it.
- Given Sam submits again, then the instance goes to `advisor` again. The timeline shows both revisions.
- Jordan can send back at the registrar step. Jordan cannot approve (see S02).

**Refs.** WF-2, WF-3, AC-4, SE-2

### S12: Reminders and escalation (`reminders-escalation`)

> As Priya, I want stuck tasks to remind people and then escalate, so that no task waits in silence.

**Engine path**

```sh
enform flow dry-run course-overload --data fixtures/sam.json --advance P1D   # reminder captured
enform flow dry-run course-overload --data fixtures/sam.json --advance P3D   # escalation adds CS-Chairs
```

**Interface path.** The dry-run panel shows a simulated clock. The reminder and the escalation email show in the preview inbox. In live, the step tracker shows "Due Friday. Reminder sent Wednesday."

**Acceptance**

- Given a reminder interval of 1 day, when 1 simulated day passes, then exactly one reminder is captured.
- Given the worker stops and restarts near the deadline, then the escalation fires exactly one time.
- Given the task completes before the deadline, then its pending timers are cancelled in the same transaction.

**Refs.** SE-3, SE-4, SE-5, DR-3, DR-4, I2, I3, I7

### S13: Withdraw or cancel a submission (`withdraw-cancel`)

> As Sam, I want to withdraw a request that I do not need. As Priya, I want to cancel a request that is not valid. In both cases, all involved people must know.

**Engine path**

```sh
enform instance withdraw <id> --reason "Dropped a class"     # Sam, own instance
enform instance cancel <id> --reason "Duplicate of #4411"    # Priya, instance.cancel
```

**Interface path.** Sam has a Withdraw button on his own instance. Priya has a Cancel action. Both ask for a reason.

**Acceptance**

- Given a withdrawal, then open tasks close, pending timers are cancelled, and current holders get a notification.
- Given Sam tries to cancel the instance of another person, then the request returns 403.
- A person can undo a withdrawal or a cancellation within the undo period of the flow. The undo restores the previous step and holder, as a compensating event.

**Refs.** WF-4, WF-5, AC-1, AC-5, SE-5, I4

## Part 4: Know what happened

### S14: Find the status of a submission (`find-status`)

> As Sam, I want to see where my request is and what it waits for, so that I do not need to send emails.

**Engine path**

```sh
enform instance show <id>
# step 3 of 4: registrar. Claimed by Ana 2 hours ago. Due Thursday.
```

**Interface path.** Each row of Started by me has a status line. The instance page has a step tracker. It shows each step as not reached, unopened, opened, completed, skipped or sent back.

**Acceptance**

- The status line shows the difference between "Waiting to be opened" and "Opened, in progress".
- Skipped steps show the reason.
- Sam sees the status. He does not see the notes of other people or restricted fields.

**Measures.** In the pilot, "Where is it?" support requests decrease by 80% from the baseline.

**Refs.** VT-1, VT-2, VT-3, VT-4, I8

### S15: Investigate a problem (`investigate`)

> As Dana, when a user reports a problem, I want to see what changed and when, next to what occurred, so that I can find the cause myself.

**Engine path**

```sh
enform instance timeline <id> --with-changes
# 15:12  dana    flow course-overload: edited routing for step registrar (v4 to v5)
# 15:20  system  instance 4412: task registrar to Unroutable (team empty)
enform flow diff course-overload --from v4 --to v5
```

**Interface path.** The instance timeline has the toggle "Show changes to this flow". It puts configuration changes between the instance events, in strict order. Each change links to its difference.

**Acceptance**

- Instance events and configuration changes share one global order. No two entries have an ambiguous order.
- Each change that affects behavior shows with its author: definition, grant, team, connector, template.
- Connector calls show with operation, time and outcome. They never show response bodies.

**Refs.** DF-6, VT-5, VT-6, I4, I13, I14

### S16: Undo a mistake (`undo`)

> As Lee, I want to undo an approval that I made on the wrong request, so that one wrong click does not damage the semester of a student.

**Engine path**

```sh
enform log --instance <id> --limit 5
enform undo <event-id> --reason "Approved the wrong request"
```

**Interface path.** A notification shows "Approved. Undo." After the notification closes, Undo stays available in the timeline, for the period that the flow allows.

**Acceptance**

- Undo adds a compensating event. The original event stays in the log.
- Side effects that already occurred, such as a sent email, are not reversed. The timeline marks them "Already sent". The undo notifies the affected people.
- If the instance passed a point that the flow marks as final, the engine refuses the undo and gives the reason.

**Refs.** WF-5, A2, I4, D6

## Traceability

The build generates `stories/MATRIX.md` from the Refs lines in this document. CI fails if an in-scope requirement in `MVP.md` has no story and no requirement test, or if a story cites an unknown ID.
