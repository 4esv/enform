# 0008: Rules sandbox

| Field | Value |
|---|---|
| Status | Accepted |
| Date | 2026-10-08 |
| Refs | FM-5, I6, A3 |

## Context

FM-5 fixes one expression format for all rules: a JSON expression tree. The visual condition builder writes it, and a TypeScript rule is one node type of the tree, run in a sandbox with CPU, memory and time limits and no network access. I6 requires determinism: the same definition, events, clock and ID source give the same result. A3 makes the engine the product, with the API, the definition format and the realtime protocol as first class surfaces. Story S05 uses JSON Logic as its rule syntax example, and MVP.md line 476 records that FM-5 and S05 pointed at different formats in issue #103.

## Decision

All rules use one format, a JSON expression tree in JSON Logic syntax. A TypeScript rule is one node type of the tree, and it runs in a sandbox of QuickJS compiled to WebAssembly, with memory and interrupt limits and no I/O by construction.

## Alternatives

- **Multiple rule formats or an ad-hoc JavaScript subset.** Rejected. FM-5 fixes one format, and I6 needs a deterministic evaluator, which a free JavaScript engine cannot guarantee.
- **A custom domain-specific language.** Rejected. JSON Logic already matches S05, and reinventing a language adds cost with no benefit.
- **Running rules in the server's Node process directly.** Rejected. It has no sandbox and no CPU, memory or time limits, and it would read the system clock, breaking FM-5 and I6.

## Consequences

- Easier: one deterministic format, portable and auditable rules, and a sandbox with no I/O by construction.
- Harder: building and maintaining the QuickJS-to-WASM sandbox and its limits.
- Constraint: rules run only in the sandbox, with no network or filesystem access.
