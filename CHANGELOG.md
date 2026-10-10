# Changelog

All notable changes to this project are recorded in this file.

The format follows [Keep a Changelog](https://keepachangelog.com/en/1.1.0/). The project follows [Semantic Versioning](https://semver.org/spec/v2.0.0.html), with the stricter rules of `MVP.md` section 9.

## [Unreleased]

### Added

- The repository layout of `MVP.md` section 9.1 and the five commands: `make setup`, `make check`, `make invariants`, `make stories` and `make stack` (#95).
- The engine operation model: idempotent operations with client-created UUIDv7 IDs (I1) (#7).
- The engine rebuilds derived state from the append-only log (I4) (#10).
- The engine runs a sequence deterministically from injected clock and ID sources (I6) (#12).
- The engine records configuration changes as attributed, versioned operations (I14) (#20).
- An OpenAPI document describes the HTTP API under `/api/v1` (DX-1) (#91).
- The engine serves the HTTP API in-process for the story harness (DX-1) (#24).
- The story harness checks every run against the invariants, the golden end state and the timeline (I1, I4, I6, I14) (#28).
- The story harness applies the Duplicate operator, sending each operation twice without changing the end state (I1, I3) (#31).
- The build writes `stories/MATRIX.md`, the matrix of story, operator and mode, and CI checks the coverage rules of `STORIES.md` (#29).
- The engine parses and serializes a flow definition canonically, round-tripping byte for byte (I9, DF-1) (#15).
- The engine stamps each instance with its definition version, resolved assignees and a connector-call log (I13, DF-2) (#19).
- The engine authorizes every read and write as a pure function of grants, scope and resource (I8, AC-1) (#14).
- The engine records a state change and its side effects as one event, an append-only outbox (I2) (#8).
- The engine routes a task whose targets resolve to nobody to the Unroutable queue and alerts the flow owner (I10, AS-5) (#16).
- The engine applies an optimistic version check on step completion, so a read or edit never waits (I5) (#11).
- The engine runs dry and live on one code path, differing only in the side-effect sink and the clock, with the same side-effect intents (I7) (#13).
- The story harness runs a scenario in dry mode, and the dry side-effect intents equal api mode (I7) (#26).
- The story harness runs a scenario in cli mode, with the same result as api mode (I6) (#25).
- The engine models a flow lifecycle: a draft definition, publish to an immutable version with a content hash, and instances pinned to their version (DF-1, DF-2, DF-4) (#38).
- The engine models grants as attributed configuration operations derived from the log, so authorize answers who can do what (AC-1, AC-4) (#39).
- The engine guards a flow push by change class: an edit-class change needs flow.edit, a structural change needs flow.build, and the rejection names the change and the scope (DF-3) (#40).
- The engine versions a flow: publishing a structural change creates an immutable v2, submitted instances stay on v1, and an unsubmitted draft rebinds to v2 (DF-2, DF-6) (#41).
- The engine evaluates a step's skipWhen condition (a JSON Logic expression) and skips the step when true, recording the skip on the timeline (WF-1, FM-5) (#42).
- The engine starts and submits a submission: a start requires a signed-in principal with instance.start, and a submit records the assignment email in the same transaction (ID-2, SE-1, I2) (#43).
- The engine resolves the six target kinds to assignees: groups and teams resolve live, dynamic targets resolve once with a snapshot, and an empty resolution routes to Unroutable with an owner alert (AS-1, AS-4, AS-5) (#45).
- The engine claims and completes a task: exactly one concurrent claim succeeds, a completion requires the step.outcome scope, and a stale version is rejected (AS-2, AC-4, I5) (#46).
- The engine takes over a claimed task after an idle timeout: it reassigns the holder, records who/from whom/when/why, and notifies the previous holder (AS-3, WF-5, I14) (#47).
- The engine sends a task back for revision: a holder returns it to a named step with a required comment, the step records the next revision, and the note commits in the same event (WF-3, AC-4, SE-2) (#48).
- The engine withdraws or cancels a submission: a starter withdraws their own, cancel needs instance.cancel, holders are notified, and an undo within the period restores the step and holder as a compensating event (WF-4, AC-5, I4) (#50).
- The engine reports a submission's status (step N of M, holder, state) and filters notes and restricted values by authorization, so a starter sees the status but not others' notes (VT-1, VT-2, VT-3, I8) (#51).
- The engine projects the log into an attributed change feed, filterable by flow and type, and connector calls show operation, time and outcome only (VT-5, VT-6, I13, I14) (#52).
- The engine undoes a mistake with a compensating event: the original stays in the log, already-sent side effects are marked 'Already sent' and not reversed, and the affected people are notified (WF-5, I4, D6) (#53).
- The flow definition gains an explicit anonymous-access setting: a flow with anonymous on lets a visitor open the form without signing in, while a start still requires sign-in (ID-3) (#71).
- The engine synchronizes group membership to the directory and releases a deprovisioned user's claimed tasks back to the pool, recording it on the log (ID-5) (#73).
- The engine models teams as attributed configuration operations: a user with org.teams creates and maintains them, and a team task resolves to current members (AS-6, AS-4, I14) (#81).
- The enform CLI ships flow init, validate and pull with --json output and exit codes (DX-3) (#38).
- The enform CLI ships flow push, publish, diff and dry-run with a local .enform store, and the flow run reports its side-effect intents (DX-3, DF-2, I7) (#38).
- The engine gives each side effect a deterministic key and delivers it at most once, so a retry, crash or redelivery is a no-op (I3) (#9).

## [0.0.0] - 2026-10-08

### Added

- `MVP.md`: scope, axioms, invariants, release plan, versioning and scope rules.
- `STORIES.md`: sixteen golden-path stories, the test method and the evidence table.
- `CONTRIBUTING.md` and `AGENTS.md`: the work procedure.
- ADR 0001 (record decisions as ADRs) and ADR 0002 (license).

[Unreleased]: https://github.com/4esv/enform/compare/v0.0.0...HEAD
[0.0.0]: https://github.com/4esv/enform/releases/tag/v0.0.0
