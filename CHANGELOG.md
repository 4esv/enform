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

## [0.0.0] - 2026-10-08

### Added

- `MVP.md`: scope, axioms, invariants, release plan, versioning and scope rules.
- `STORIES.md`: sixteen golden-path stories, the test method and the evidence table.
- `CONTRIBUTING.md` and `AGENTS.md`: the work procedure.
- ADR 0001 (record decisions as ADRs) and ADR 0002 (license).

[Unreleased]: https://github.com/4esv/enform/compare/v0.0.0...HEAD
[0.0.0]: https://github.com/4esv/enform/releases/tag/v0.0.0
