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

## [0.0.0] - 2026-10-08

### Added

- `MVP.md`: scope, axioms, invariants, release plan, versioning and scope rules.
- `STORIES.md`: sixteen golden-path stories, the test method and the evidence table.
- `CONTRIBUTING.md` and `AGENTS.md`: the work procedure.
- ADR 0001 (record decisions as ADRs) and ADR 0002 (license).

[Unreleased]: https://github.com/4esv/enform/compare/v0.0.0...HEAD
[0.0.0]: https://github.com/4esv/enform/releases/tag/v0.0.0
