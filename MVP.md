# enform: MVP Specification

| Field | Value |
|---|---|
| Document | `MVP.md` |
| Governs | Releases `0.0.0` to `1.0.0` |
| Status | Accepted |
| Change process | Pull request with a [Scope Ledger](#13-scope-ledger) entry |

This document is the scope. If a capability is not in [In scope](#5-in-scope), it is out of scope. To resolve an ambiguity, amend this document. Do not resolve it in code.

## Contents

1. [Purpose](#1-purpose)
2. [Axioms](#2-axioms)
3. [Glossary](#3-glossary)
4. [Invariants](#4-invariants)
5. [In scope](#5-in-scope)
6. [Out of scope](#6-out-of-scope)
7. [Exit criteria for 1.0.0](#7-exit-criteria-for-100)
8. [Release plan](#8-release-plan)
9. [Versioning](#9-versioning)
10. [Scope rules](#10-scope-rules)
11. [Engineering practice](#11-engineering-practice)
12. [Decisions](#12-decisions)
13. [Scope Ledger](#13-scope-ledger)

## 1. Purpose

enform is an engine with a public API and a file format. The web interface is the first client of that API. The interface has no capability that the API does not have.

People use enform to build flows. A flow is a form with steps, approvals and routing. People fill in flows, act on them, and always know their status.

enform has these properties:

- Nobody blocks anybody.
- All manual actions are reversible.
- All changes are visible, attributed and in order.
- No work is lost, also on a bad network.

The MVP is complete when one real multi-step flow operates in production and meets the [exit criteria](#7-exit-criteria-for-100).

## 2. Axioms

Axioms state the reasons. Invariants (section 4) enforce the axioms and make them testable. Requirements (section 5) state what to build. Each requirement traces to one or more axioms or invariants.

| ID | Axiom | Meaning |
|---|---|---|
| A1 | Nobody blocks anybody. | Users do not block users. Users and developers do not block each other. There are no locks. |
| A2 | Manual actions are reversible. Everything is logged. | A compensating event can undo an edit, claim, reassignment or step outcome. The system records side effects of configured automation, such as a sent email. It does not reverse them. |
| A3 | The engine is the product. | The API, the definition format and the realtime protocol are first class. The interface uses only the public API. |
| A4 | State is honest. | A screen shows the true state. Otherwise, it marks the state as pending, stale, offline or conflicted. It never shows an unconfirmed state as confirmed. |
| A5 | Multiplayer where it adds value. | Building, review and read-only views are live and shared. One author fills in a form. |
| A6 | Dry runs have parity. | A dry run uses the same engine, rules, routing and timers as live. It does not create permanent records. |
| A7 | Work is never lost. | Edits survive refreshes, crashes and lost connections. |
| A8 | No mysteries. | All changes are visible, attributed and on one timeline. The reader finds the cause. The system makes this easy. |
| A9 | The engine decides. Interfaces present. | Correctness, authorization and state transitions are only in the engine. The CLI and the GUI are replaceable clients of the public API. If a GUI feature is not a sequence of API calls, it is a defect. The engine changes slowly and with care. Interfaces can change at any time. |

## 3. Glossary

These terms are normative. Code, documentation, API and interface use them with these meanings only.

| Term | Definition |
|---|---|
| Flow | A definition. It has one form schema, one or more steps, rules, grants and notifications. It is the only top-level object type. |
| Version | An immutable snapshot of a flow. Publishing creates it. A content hash identifies it. |
| Draft definition | The editable copy of a flow before publication. More than one person can edit it at the same time. |
| Step | A stage in a flow. It sets who acts, what they see, what they can edit, which outcomes they can choose, and its timers. |
| Instance | One run of a flow. It stays on the version that it started on. |
| Draft | An instance before submission. Only its author can see its contents. |
| Task | The unit of work that a step creates on an instance. |
| Target | The recipient of a task: a user, a directory group, a team, or a dynamic rule. |
| Team | A named set of users and groups. enform stores and maintains it. |
| Flow owner | A principal with `task.reassign` on the flow. Owners get the alerts of I10 and can send email again (SE-1). |
| Claim | To take ownership of a task. To view a task does not claim it. |
| Grant | A record of `(principal, scope, resource)`. Grants are the only source of permission. |
| Scope | One permission that a grant gives, for example `instance.start`. |
| Operation (op) | One change. It has an ID that the client creates. All changes are operations. |
| Event | An immutable, ordered record of an occurrence. |
| Log | The single sequence of all events, in one global order. |
| Side effect | An action outside enform, such as an email or an outbound request. The worker executes it from the outbox. |
| Connector | A named external endpoint that an administrator configures. Each connector operation is declared `read` or `write`. |
| Dry run | An execution that captures writes and emails and does not send them. It can simulate time. Its records expire. |

## 4. Invariants

An invariant is a property that is always true. Each invariant has a test suite, named in the table. CI fails if an invariant has no suite, or if a suite is skipped.

| ID | Invariant | Axioms | Suite |
|---|---|---|---|
| I1 | Idempotent operations. Each change is an operation with an ID that the client creates. If the engine applies an operation two times, the result is the same as one time. | A2, A7 | `invariants/I1-idempotent-ops` |
| I2 | Transactional outbox. A state change and the side effects that it causes commit in one database transaction. Both commit, or neither commits. | A2, A4 | `invariants/I2-transactional-outbox` |
| I3 | Idempotent side effects. Each side effect has a deterministic key: instance, step, rule and occurrence. It executes a maximum of one time, also after a retry, crash or redelivery. | A2 | `invariants/I3-idempotent-side-effects` |
| I4 | Append-only log. The engine does not update or delete events. The only exception is a redaction event (D5). The engine can rebuild all derived state from the log. | A2, A8 | `invariants/I4-append-only-log` |
| I5 | No blocking locks. A read or an edit never waits for another user. Only step completion is serialized, with an optimistic version check. | A1 | `invariants/I5-no-blocking-locks` |
| I6 | Determinism. The same definition, events, clock and ID source give the same result. The clock and the ID generator are injected. No code reads the system clock directly. | A6 | `invariants/I6-determinism` |
| I7 | Dry-run parity. Dry runs and live runs use the same code path. Only the side-effect sink and the clock are different. The same scenarios run in both modes and must give the same side-effect intents. | A6 | `invariants/I7-dry-run-parity` |
| I8 | Authorization everywhere. The server authorizes every read and write. This includes realtime broadcasts, exports and PDFs. A subscriber never receives an event that it cannot see. | A3 | `invariants/I8-authorization-everywhere` |
| I9 | Canonical round trip. Conversion of a definition from file to operations and back to file gives an identical file, byte for byte. | A3 | `invariants/I9-canonical-round-trip` |
| I10 | No silent routing loss. If the targets of a task resolve to nobody, the task goes to the Unroutable queue. The flow owner gets an alert. | A4, A8 | `invariants/I10-no-silent-routing-loss` |
| I11 | Encrypted local drafts. Drafts in the browser are encrypted with a key that the session controls. Sign-out or idle timeout deletes them. | A7 | `invariants/I11-encrypted-local-drafts` |
| I12 | Public API only. The interface uses only the generated public API client. A lint rule enforces this. | A3, A9 | `invariants/I12-public-api-only` |
| I13 | Stamped instances. Each instance records its definition version and the resolved assignees with a membership snapshot. It also records a log of connector calls: operation, time and outcome. It does not record response bodies. | A8 | `invariants/I13-stamped-instances` |
| I14 | Attributed configuration. Each change that affects behavior is an attributed, versioned operation on the log. This includes definitions, connectors, grants, teams, templates and settings. | A8 | `invariants/I14-attributed-configuration` |
| I15 | No acknowledged edit is lost. If the interface shows "Saved on this device", the edit gets to the server, or it stays recoverable on the device until a deliberate deletion. The interface always shows the difference between "Saved on this device" and "Synced". | A4, A7 | `invariants/I15-no-acknowledged-edit-lost` |
| I16 | No false confirmation. The interface never shows an unconfirmed state as confirmed. An optimistic update shows as pending until the server acknowledges it. | A4 | `invariants/I16-no-false-confirmation` |

## 5. In scope

Requirement IDs are permanent. Do not reuse or renumber them. A withdrawn requirement stays in the table with the label **Withdrawn**.

### 5.1 Identity (ID)

| ID | Requirement | Traces to |
|---|---|---|
| ID-1 | Sign-in uses OIDC through Keycloak. Keycloak connects to on-premises Active Directory and to Microsoft Entra ID. | A3 |
| ID-2 | Each flow URL requires sign-in by default. A visitor who is not signed in goes to SSO, then returns to the same location. | A4 |
| ID-3 | Anonymous access is an explicit setting for each flow. The builder and the form show a visible label for it. | A4 |
| ID-4 | Immutable directory IDs identify people and groups. Names and email addresses do not. | A8 |
| ID-5 | Group membership synchronizes at sign-in and on a schedule. When a user is deprovisioned, their claimed tasks go back to the pool. The log records this. | A1, A8 |

### 5.2 Definitions (DF)

| ID | Requirement | Traces to |
|---|---|---|
| DF-1 | A flow is one JSON document. A published JSON Schema validates it. The document has an integer `schemaVersion`. | A3 |
| DF-2 | Publication creates an immutable version with a content hash. An instance stays on the version that it started on. | A8 |
| DF-3 | More than one person can edit a draft definition at the same time, with presence. All edits are operations. | A1, A5, I1 |
| DF-4 | A definition has a canonical file form. The CLI `pull` command writes it. The CLI `push` command converts file differences into operations. | A3, I9 |
| DF-5 | The scope `flow.edit` allows edit-class changes. The scope `flow.build` allows all changes (D2). | A1 |
| DF-6 | Each version shows a field-level difference from its parent. | A8 |

### 5.3 Forms and rules (FM)

| ID | Requirement | Traces to |
|---|---|---|
| FM-1 | Controls: text, long text, number, money, date, select, multi-select, checkbox, radio, yes/no, email, phone, file upload, user picker, static text, repeating section. | A3 |
| FM-2 | Conditions on data, step and user can show, hide, collapse, require or lock sections and fields. | A9 |
| FM-3 | Each step sets which fields are visible and which fields are editable. | I8 |
| FM-4 | The server runs all rules and validation again at each submission. The server does not trust client state. | I8 |
| FM-5 | All rules use one expression format: a JSON expression tree (ADR 0008). The visual condition builder writes it. A TypeScript rule is one node type of the tree. It runs in a sandbox with CPU, memory and time limits and no network access. | A3, I6 |
| FM-6 | Connector `read` operations can supply option lists and default values. | A3 |

### 5.4 Workflow (WF)

| ID | Requirement | Traces to |
|---|---|---|
| WF-1 | Steps are linear, with conditional branches and skip conditions. An instance has one active step at a time. | A9 |
| WF-2 | Step outcomes are configurable: approve, reject, send back, or custom. Each outcome maps to a transition. | A9 |
| WF-3 | Send back moves the instance to an earlier step. It requires a comment. The log records it as a revision. | A2 |
| WF-4 | The starter can withdraw an instance, unless the flow prevents it. | A2 |
| WF-5 | A compensating event can undo each manual action: edit, claim, release, takeover, reassign, outcome, withdraw, cancel. Each flow sets the limits for undo. | A2, I4 |

### 5.5 Assignment (AS)

| ID | Requirement | Traces to |
|---|---|---|
| AS-1 | Target types: user, directory group, team, or dynamic. Dynamic targets are `starter`, `field:<key>` and `manager-of:starter`. | A1 |
| AS-2 | Completion policy: the first person to claim the task owns it. | A1 |
| AS-3 | Any eligible target can take over a claimed task. Each step sets when: always, after an idle period, or never. The person who takes over must give a reason. | A1, A8 |
| AS-4 | Groups and teams resolve live, when a person views or claims the task. Dynamic targets resolve one time, when the engine creates the task. The instance records both. | I13 |
| AS-5 | The Unroutable queue operates as I10 states. | I10 |
| AS-6 | Users with the scope `org.teams` create and maintain teams. | A1 |

### 5.6 Access control (AC)

The engine has no roles. Permission comes only from grants. A grant is `(principal, scope, resource)`.

- The principal is a user, a group or a team.
- The scope is one row of the table below.
- The resource is `org`, `flow:<slug>`, or `flow:<slug>/step:<key>`. A grant on a flow applies to all of its steps.

A combination such as "reviewer", "approver" or "administrator approver" is a set of scopes. It is not a type.

| ID | Requirement | Traces to |
|---|---|---|
| AC-1 | Authorization is a pure function of grants, scope and resource. Only the engine evaluates it. | A9, I8 |
| AC-2 | Grant changes are attributed, versioned operations. | I14 |
| AC-3 | The GUI can show named presets, such as "Approver". A preset expands to scopes when the grant is made. The engine stores only scopes. Presets have no meaning in the engine. | A9 |
| AC-4 | A target of a step can claim the tasks of that step. Scopes of the form `step.outcome:<name>` control which outcomes that person can choose. Thus reviewers and approvers can share one step. | A9 |
| AC-5 | A starter can always read their own instances. A starter can withdraw an instance if the flow allows it. | A4 |

**Scopes**

| Scope | Resource | Allows |
|---|---|---|
| `flow.read` | flow | Read the published definition. |
| `flow.edit` | flow | Change labels, help text, option lists and email copy in a draft definition, and publish those changes. |
| `flow.build` | flow | Change all parts of a draft definition, and publish. |
| `flow.dryrun` | flow | Do dry runs. |
| `flow.grant` | flow | Add and remove grants on the flow. |
| `instance.start` | flow | Start an instance. |
| `instance.read` | flow | Read all instances of the flow. |
| `instance.edit` | flow | Edit instance data outside the step sequence. Requires a reason. |
| `instance.cancel` | flow | Cancel any instance. Requires a reason. |
| `instance.timeline` | flow | Read complete timelines, with configuration changes included. |
| `task.reassign` | flow, step | Reassign or release any task, also if the actor is not a target. On a flow, makes the principal a flow owner (section 3). |
| `step.outcome:<name>` | flow, step | Choose the named outcome on a task that the actor holds. |
| `org.connectors` | org | Manage connectors. |
| `org.teams` | org | Manage teams. |
| `org.grants` | org | Grant any scope on any resource. |
| `org.impersonate` | org | Use test identities in dry runs. |
| `org.redact` | org | Issue redaction events. |

### 5.7 Side effects (SE)

| ID | Requirement | Traces to |
|---|---|---|
| SE-1 | Email goes through an outbox. A worker sends it, with retries and backoff. Each message shows one status: queued, sent, failed or bounced. A flow owner can send it again. | I2, I3, A4 |
| SE-2 | Each event type has an email template with variables and a preview. Event types: task assigned, sent back, completed, reminder, escalation, unroutable (I10), taken over, withdrawn or cancelled, undone. | A4 |
| SE-3 | Reminders occur at configured intervals before and after the due time. | A1 |
| SE-4 | At the deadline, an escalation notifies a person or adds targets. It does not remove the current owner. | A1 |
| SE-5 | Timers are durable jobs. The engine creates and cancels them in the same transaction as their task. | I2, I3 |
| SE-6 | Administrators configure connectors. Each connector operation is declared `read` or `write`. The default is `write` (D4). Calls have timeouts and idempotency keys. Writes have retries. | I3, I7 |
| SE-7 | A SQL connector gives named, parameterized queries for SQL Server and PostgreSQL. Flows do not contain raw SQL. | A3 |

### 5.8 Realtime and resilience (RT)

| ID | Requirement | Traces to |
|---|---|---|
| RT-1 | The primary transport is WebSocket. The fallback order is Server-Sent Events, then polling, then offline. The interface always shows the current mode. | A4 |
| RT-2 | Draft definitions and read-only views show presence: who is there, and where. | A5 |
| RT-3 | Drafts are local first. The browser saves each edit to encrypted storage, then sends it to the server as an idempotent operation. | I1, I11, I15 |
| RT-4 | After a refresh, the interface shows the local state immediately, then reconciles it with the server. | A7 |
| RT-5 | A submission made offline goes into a queue, with the label "Will submit when you are back online". If the server rejects it, the draft stays, and the author sees the reason. | A4, I15 |
| RT-6 | If a definition changes while a draft is open, the draft moves to the new version. If a value does not fit the new version, the author sees it. The engine does not delete it. | A4, A7 |

### 5.9 Dry run (DR)

| ID | Requirement | Traces to |
|---|---|---|
| DR-1 | Any version or draft definition can run as a dry run. | A6, I7 |
| DR-2 | Connector reads execute. Writes are captured and show as "Would have sent". | I7 |
| DR-3 | Emails go to a preview inbox. They are not sent. | I7 |
| DR-4 | The clock is simulated. The author can move time forward so that timers fire. | I6 |
| DR-5 | The author can run a step as a test identity. This requires `org.impersonate`. The log records each use. | I8, I14 |
| DR-6 | Dry-run records expire automatically. They do not show in live views. | A6 |

### 5.10 Visibility and timeline (VT)

| ID | Requirement | Traces to |
|---|---|---|
| VT-1 | The inbox has three tabs: My tasks, Available, Started by me. | A4 |
| VT-2 | Each instance has a step tracker. Each step shows one state: not reached, unopened, opened (with last activity), completed, skipped or sent back. Each step shows the holder, the start time and the due time. | A4 |
| VT-3 | Each instance has a status line in plain language. | A4 |
| VT-4 | Draft contents are private until submission. Activity status is visible, for example "In progress by Sam, last active 2 minutes ago". | A4, A5 |
| VT-5 | The log supplies the instance timeline. A toggle adds the changes to the flow definition and configuration, in the same order. | A8, I14 |
| VT-6 | A global change feed shows attributed changes. It can filter by flow and by type. | A8 |

### 5.11 Developer surface (DX)

| ID | Requirement | Traces to |
|---|---|---|
| DX-1 | An OpenAPI document describes the HTTP API. The API path prefix is `/api/v1`. | A3 |
| DX-2 | A published message schema describes the realtime protocol. Client and server agree on the protocol version in the handshake. | A3 |
| DX-3 | The CLI covers each engine operation that `STORIES.md` uses. Command groups: `login`, `flow`, `grant`, `instance`, `task`, `undo`, `log`. Each command accepts `--json`. | A3, A6, A9 |
| DX-4 | The API client that the interface uses is generated from the OpenAPI document. | I12 |

### 5.12 Output (OU)

| ID | Requirement | Traces to |
|---|---|---|
| OU-1 | The engine renders an instance as a PDF on request. The PDF shows the form as a given step sees it, and the step history. | I8 |

## 6. Out of scope

Each item is excluded on purpose. To add an item, amend this document (section 10).

| Excluded | Reason |
|---|---|
| Parallel steps | Linear steps with branches (WF-1) are sufficient for the pilot. Concurrency needs a separate design. |
| "All" and "quorum" completion policies | They need voting semantics. |
| Co-editing a form during fill-in | One author fills in a form (A5). |
| Custom PDF templates. Fill-in of existing PDFs. | The default PDF (OU-1) is sufficient for 1.0. |
| Reporting views and BI integration | After 1.0. The API and the log are the integration points. |
| Delegation and out-of-office | Takeover (AS-3) covers this need for now. |
| Notification digests and preferences | |
| Comments and mentions | |
| SCIM provisioning | Synchronization (ID-5) covers deprovisioning. |
| Slack and Teams notifications | |
| Inbound webhooks | |
| Multi-tenancy | One installation serves one organization. |
| Native mobile applications | The web interface is responsive. |
| Replay or bisect against other versions | A8 gives transparency. It does not give built-in causality. |
| Storage of connector response bodies | Privacy cost. I13 records calls. It does not record payloads. |
| Migration from other products | Separate tools outside this repository. |

## 7. Exit criteria for 1.0.0

All criteria must be true for 14 consecutive days, in production, on the pilot flow.

| Criterion | Target |
|---|---|
| Submissions made without sign-in on a flow that does not allow anonymous access | 0 |
| Instances or edits lost | 0 |
| Tasks that needed administrator repair | 0 |
| Emails without a recorded delivery outcome | 0 |
| Unroutable tasks not shown to the owner within 5 minutes | 0 |
| Invariant suites I1 to I16 | All pass on `main` |
| Open regressions against these criteria | 0 |

## 8. Release plan

`main` is always releasable. Each milestone is a minor release `0.y.0`. Each milestone ends with a demonstration.

| Version | Milestone | Contents | Demonstration |
|---|---|---|---|
| `0.0.0` | Charter | This document, `STORIES.md`, `AGENTS.md`, `CONTRIBUTING.md`, `CHANGELOG.md`, ADRs 0001 and 0002. No product code. | The scope is ready for review. |
| `0.1.0` | Foundation | Repository layout, CI, Compose stack, PostgreSQL, Keycloak with AD and Entra ID (ID-1, ID-4), the OpenAPI document (DX-1), the log and the operation model (I1, I4, I6, I14), the invariant and story harness. | A user signs in. Operations are idempotent. State rebuilds from the log. |
| `0.2.0` | Engine | ID-2, ID-3, ID-5, DF-1, DF-2, WF-1 to WF-3, WF-5, AS-1 to AS-6, AC-1 to AC-4, DX-3, the side-effect sink with live and dry-run modes (I2, I5, I7 to I10, I13). | A flow runs from start to end through the API and the CLI, live and dry. |
| `0.3.0` | Side effects | WF-4, AC-5, SE-1 to SE-7, DR-1 to DR-6, I3. | Reminders and escalations fire on a simulated clock. Email status is visible. |
| `0.4.0` | Forms | FM-1 to FM-6, OU-1. The web interface starts: the generated API client (DX-4, I12) and the form. | A dynamic form shows, validates on the server and prints. |
| `0.5.0` | Realtime and resilience | RT-1 to RT-5, DX-2, I11, I15, I16. | The network fails during an edit. After a refresh, no work is lost and the state is correct. |
| `0.6.0` | Builder | DF-3 to DF-6, RT-6 and the multiplayer builder. | Two builders and one CLI push edit one flow at the same time. |
| `0.7.0` | Visibility | VT-1 to VT-6. | A requester finds the status of a submission without help. |
| `0.8.0` | Pilot | Hardening. The pilot flow goes into production. | The measurement period of section 7 starts. |
| `1.0.0` | MVP | The exit criteria of section 7 are met. | |

## 9. Versioning

### 9.1 Public surfaces

A change is breaking if it is not compatible with one of these surfaces. Nothing else is public.

| Surface | Versioned by | Location |
|---|---|---|
| Flow definition format | Integer `schemaVersion` | `schemas/flow/v<N>.json` |
| HTTP API | Path prefix `/api/v<N>` and the OpenAPI document | `api/openapi.yaml` |
| Realtime protocol | Integer protocol version, agreed in the handshake | `schemas/realtime/v<N>.json` |
| Event types | Version suffix for each type, for example `task.claimed@1` | `schemas/events/` |
| CLI | Command names, flags, exit codes and `--json` output | `cli/` |
| Deployment configuration | Environment variables and Compose service names | `deploy/` |

Database tables, internal modules and interface markup are not public. They can change in any release.

### 9.2 Product version

The repository uses [Semantic Versioning 2.0.0](https://semver.org/).

Before 1.0.0:

- SemVer permits any change. enform is more strict.
- A breaking change increments the minor version. It never increments the patch version.
- The changelog lists each breaking change under **Breaking**, with migration steps.

From 1.0.0:

- **Major:** a breaking change to a public surface.
- **Minor:** a compatible addition.
- **Patch:** a compatible fix.

Release tags are signed. They come only from `main`. Their format is `v<MAJOR>.<MINOR>.<PATCH>`.

### 9.3 Schema and event evolution

- **Definition schema.** The engine reads all earlier values of `schemaVersion`. It writes only the latest value. Each increment includes a forward migrator, with fixture tests for each earlier version.
- **Events.** The engine never rewrites an event. A changed event shape gets a new type version. An upcaster converts old events when the engine reads them.
- **Realtime protocol.** The server supports the current version and the previous version. It tells older clients to reload.

### 9.4 Deprecation (from 1.0.0)

1. Deprecate a surface in a minor release. Add a runtime warning and a changelog entry.
2. Remove it in a major release, not earlier.

### 9.5 Changelog

`CHANGELOG.md` uses the [Keep a Changelog](https://keepachangelog.com/) format. A pull request that contains `feat`, `fix`, `perf` or a breaking change adds an entry under `Unreleased`. CI enforces this.

### 9.6 Commits

Commit messages use [Conventional Commits 1.0.0](https://www.conventionalcommits.org/).

| Part | Rule |
|---|---|
| Type | `feat`, `fix`, `perf`, `refactor`, `test`, `docs`, `build`, `ci`, `chore` |
| Scope | The area: `engine`, `api`, `realtime`, `ui`, `cli`, `identity`, `worker`, `schema`, `docs` |
| Breaking change | `!` after the type or scope, and a `BREAKING CHANGE:` footer |
| References | A footer that cites the issue and the IDs, for example `Refs: #42, AS-3, I5` |

Before 1.0.0, a breaking change increments the minor version. `feat` and `fix` increment the patch version. From 1.0.0, the standard SemVer mapping applies.

## 10. Scope rules

1. This document is the only source of scope. An issue, a discussion or a prompt does not change scope.
2. To change scope, open a pull request that edits this document. Add a [Scope Ledger](#13-scope-ledger) entry that states the change and the reason. Merge it before any code that implements the change.
3. Each issue and each pull request cites the requirement or invariant IDs that it serves. Work that cites no ID is out of scope.
4. IDs are permanent. To remove a requirement, mark it **Withdrawn** and add a ledger entry. Do not reuse the ID.
5. Do not include unrelated changes. Put each unrelated change in its own pull request, with its own ID.
6. `STORIES.md` defines the acceptance tests. A requirement is complete only when each story that cites it passes. The engine path (CLI and API) passes first. The interface path passes second. A requirement that no story cites is complete when its requirement test passes.
7. A story does not add scope. If a story needs something that section 5 does not contain, amend this document first.

## 11. Engineering practice

### 11.1 Work sequence

All work follows this sequence. `CONTRIBUTING.md` gives the procedure.

1. **Issue.** Open an issue. It cites the story and the requirement or invariant IDs.
2. **Failing test.** Commit a test that fails. Mark it as expected to fail, with the issue number. The suite stays green. If an expected failure passes, the suite fails.
3. **Implementation.** Commit the implementation. Remove the expected-failure mark. The test passes.
4. **Evidence.** Record the issue, the tests and the commits in the evidence table of `STORIES.md`.
5. **Push.** Push only when the complete local check passes. Nothing goes to the remote until it is green.

### 11.2 Contracts first

Merge the JSON Schemas, the OpenAPI document and the realtime message schemas before the code that serves them, or with that code. Generate types from the schemas. Do not derive schemas from code.

### 11.3 Architecture Decision Records

- Each decision that is costly to reverse gets an ADR in `docs/adr/NNNN-title.md`. The ADR states the context, the decision, the rejected alternatives and the consequences.
- An accepted ADR does not change. To change a decision, write a new ADR that supersedes the old one.
- Accepted at `0.0.0`: 0001 Record decisions as ADRs. 0002 License.
- Required for `0.1.0`: 0003 PostgreSQL as the only datastore and job queue. 0004 Operation and event model. 0005 Keycloak as identity broker. 0006 Realtime transport and fallback. 0007 Encrypted local drafts. 0008 Rules sandbox.

### 11.4 Tests

Stories are the center of the test suite. `STORIES.md` gives the method. All other test layers supply the stories or check them.

| Layer | Purpose |
|---|---|
| Story scenarios (`stories/`) | One deterministic golden path for each story. It runs in `api`, `cli`, `dry` and `gui` modes. |
| Generated fuzzy paths | Variation operators applied to each golden path: actor, duplicate, race, fault, offline, clock, data, version. |
| Invariant oracles (`invariants/`) | I1 to I16. They run after each story run, golden or generated. |
| Promoted variants | Each minimized fuzzy failure. It stays as a named variant of the story that it broke. |
| Unit and property tests | Engine internals: operation application, canonical round trip, schema migrators, rule evaluation. They support stories. They do not replace them. |

### 11.5 Commits and history

- Each commit builds and passes all tests.
- Each commit contains one logical change.
- The commit message body states the reason. The diff shows the change.
- History is real. Clean up local commits before a push. Never rewrite `main`.
- `main` is protected. It accepts pull requests only, with green CI and linear history.

### 11.6 Definition of done

A requirement is done when all items are true:

- [ ] The contract (schema, OpenAPI or protocol) is merged, or has no change.
- [ ] The issue exists, and each commit cites it and the IDs.
- [ ] A failing test came before the implementation.
- [ ] Each story that cites the requirement passes its golden path in all applicable modes.
- [ ] The generated fuzzy paths of those stories pass all invariant oracles.
- [ ] The evidence table of `STORIES.md` is updated.
- [ ] User documentation and API reference are updated.
- [ ] The changelog has an entry, if the change is a `feat`, `fix`, `perf` or a breaking change (9.5).
- [ ] An ADR exists, if the change made a decision that is costly to reverse.

## 12. Decisions

Each decision applies until an amendment under section 10 changes it.

| ID | Decision | Reason |
|---|---|---|
| D1 | One author fills in a form. Draft contents are private until submission. Activity status is public. | A5, with privacy. See VT-4. |
| D2 | `flow.edit` allows changes to labels, help text, option lists and email copy only. Structural changes require `flow.build`. | Users can edit forms. They do not get control of the engine. |
| D3 | The operation log on the server is canonical. Files are a projection of it. | Two sources of truth would block a person (A1). |
| D4 | The default declaration of a connector operation is `write`. | An incorrect `read` label on a write is more dangerous than the opposite (I7). |
| D5 | Legal deletion is a redaction event. It requires `org.redact`. It is attributed. It is not reversible, by design. | Privacy law has priority over A2. I4 allows only this exception. |
| D6 | To undo a completed step, the engine adds a compensating event. It does not delete. | I4. |
| D7 | Pilot flow: three steps, request, approval, processing. A ledger entry replaces it with the real flow before `0.8.0`. | A real flow sets the limits of the MVP. |
| D8 | License: MIT. See ADR 0002. | |

## 13. Scope Ledger

This ledger is append-only. The newest entry is last.

| Date | Change | IDs | Reason |
|---|---|---|---|
| 2026-10-08 | Initial scope accepted. | All | Charter for `0.0.0`. |
| 2026-10-08 | Section 8: ID-2 and ID-3 move to `0.2.0`; WF-4 and AC-5 to `0.3.0`; RT-6 to `0.6.0`. ID-5, DX-1 to DX-4, I2, I3, I5, I8 to I10, I12 and I13 get a milestone. The web interface starts at `0.4.0`. | ID-2, ID-3, ID-5, WF-4, AC-5, RT-6, DX-1 to DX-4, I2, I3, I5, I8, I9, I10, I12, I13 | Each milestone must demonstrate its row with its own issues (#98). |
| 2026-10-08 | A requirement that no story cites is complete when its requirement test passes; CI accepts that. Requirements trace to axioms or invariants; empty cells filled. Suite and story slugs fixed. Refs added to S01, S02, S03, S09, S15. S07 skips `cli` with a reason. S11 shows revisions in the timeline. 11.6 uses the changelog trigger of 9.5. | All | Sixteen requirements had no story and no completion rule (#99). |
| 2026-10-08 | Glossary: a flow owner is a principal with `task.reassign` on the flow. | I10, SE-1 | I10, SE-1, S06 and S08 used a term that nothing defined (#100). |
| 2026-10-08 | SE-2 adds the event types unroutable, taken over, withdrawn or cancelled, undone. | SE-2, I10 | S08, S10, S13 and S16 notify people; SE-2 had no template for it (#101). |
| 2026-10-08 | `STORIES.md` cast: Dr. Lin, chair, member of `CS-Chairs`. | AS-1, WF-1 | The Actor operator needs a person for each step (#102). |
| 2026-10-08 | FM-5: the one format is a JSON expression tree. A TypeScript rule is a node of it, run in the sandbox. | FM-5 | FM-5 and S05 pointed at different formats (#103). ADR 0008 records the decision. |
