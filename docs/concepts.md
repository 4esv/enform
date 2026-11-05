# Concepts

<!-- description: The vocabulary of enform: flows, versions, steps, targets, scopes and grants, instances and tasks, the append-only log, and how dry runs relate to live runs. Read this once and every page and every command makes sense. -->

enform uses a small number of terms with exact meanings. The engine, the interface, the API and the CLI use them the same way.

## Flow

A **flow** is one JSON document with a `schemaVersion`, a list of steps and, for each step, its form, its targets and its outcomes. A published JSON Schema (`schemas/flow/v2.json`) validates it. A flow has a **slug** (`course-overload`) that names it in every URL and command.

A flow has a **draft** and zero or more **published versions**. Editing changes the draft. **Publishing** freezes the draft as the next version with a content hash; a version never changes afterwards. A submission runs on the version it started on, however many versions are published later.

The engine keeps a **canonical file form** of a definition. `enform flow pull` writes it and `enform flow push` turns the difference between the file and the draft into operations, so a developer can keep flows in a repository while a coordinator edits the same draft in the browser.

## Step

A **step** has a key, a form, targets and outcomes. The first step is the **request**: the starter fills it in and submits. Each later step is a **task** for the people its targets resolve to. A step can be **skipped** by a condition, **sent back** to an earlier step with a comment, and configured with a reminder interval, a deadline with escalation, and a takeover policy.

## Target

A **target** says who a step is for. The types are a user, a directory group, a team, and the dynamic targets `starter`, `field:<key>` (the person chosen in a user-picker field of the form) and `manager-of:starter`. Groups and teams resolve **live**: whoever is in the team when a person views or claims the task. Dynamic targets resolve **once**, when the engine creates the task, and the instance records the result.

A task nobody can receive goes to the **Unroutable queue**, where a flow owner reassigns it. The timeline records the reason.

## Scope and grant

Authorization is a pure function of **grants**. A grant gives a **principal** (a user, a group or a team) a set of **scopes** on a **resource**. A resource is the organization (`org`), a flow (`flow:course-overload`) or a step of a flow (`flow:course-overload/step:registrar`).

| Scope | Allows |
|---|---|
| `instance.start` | Start a submission of the flow. |
| `instance.read`, `instance.timeline` | Read instances and their timelines, with the configuration changes. |
| `step.outcome:<name>` | Choose that outcome on that step, such as `step.outcome:approve`. |
| `task.reassign` | Reassign and release tasks of the flow, and act on its Unroutable queue. Holders of it are the flow owners. |
| `flow.edit` | Edit labels, help text, option lists and email copy of the flow. |
| `flow.build` | Any change to the flow, including structure. |
| `flow.dryrun` | Run the flow as a dry run. |
| `org.grants` | Manage grants. Administrators hold it on `org`. |
| `org.teams` | Create and maintain teams. |
| `org.impersonate` | Run a dry run as another person. Each use is logged. |

A target of a step may claim its tasks. Which outcomes the holder may choose comes from the `step.outcome:` scopes, so reviewers and approvers can share one step. The interface shows **presets** such as "Approver" that expand to scopes when a grant is made; the engine stores only scopes.

## Instance and task

An **instance** is one submission of a flow: its values, its current step, its holder, its status and its history. Starting a flow creates an instance in a **draft** state that is private to its starter until it is submitted. From then on the instance moves through the steps. At each step one **task** exists; the first eligible person to **claim** it holds it until an outcome completes it.

Each instance has a **status line** in plain language ("Waiting for the registrar's office, held by Ana since Tuesday"), a **step tracker** with one state per step, and a **timeline** that lists every event in order, with a toggle that adds the changes to the flow's configuration.

## The log

Every change is an **operation**: a client-chosen ID, a versioned event type (`task.claimed@1`), the actor, the time and a payload. The server appends operations to one **append-only log** in one global order. Everything else, the flows, the instances, the inbox, the grants, the teams, is a **projection** folded out of the log, and `enform admin rebuild` folds it again from scratch.

The log is why enform can promise "no mysteries": every page and every command reads the same ordered record, the retry of an operation appends nothing the second time, and an undo adds a compensating event rather than deleting anything.

## Live and dry

The engine runs **live** and **dry** on one code path. Live, side effects (emails, timers) go to the outbox and a worker delivers them. Dry, they go to a preview inbox, nothing is stored and a simulated clock can move forward so reminders and escalations fire on demand. The route and the assignees of a dry run equal those of the live run with the same data.

## Where to look

| Page | Shows |
|---|---|
| Flows (`/`) | The flows you may start, edit or read. |
| Inbox (`/?inbox=1`) | My tasks, Available, Started by me. |
| A flow (`/?flow=<slug>`) | The request form of its published version. |
| An instance (`/?flow=<slug>&instance=<id>`) | The task page: the form of the current step, the tracker, the timeline, the outcomes. |
| The builder (`/?flow=<slug>&builder=1`) | The draft, its sharing, its dry run, its versions. |
| Changes (`/?changes=1`) | The global change feed, filtered by flow and by type. |
| Unroutable (`/?queue=1`) | The tasks nobody can receive. |
| Users and groups (`/?users=1`, `/?groups=1`) | The built-in directory. |
| Teams (`/?teams=1`) | The teams and their members; a holder of `org.teams` maintains them. |
| Templates (`/?templates=1`) | The email templates with their variables and a preview, for an administrator. |
