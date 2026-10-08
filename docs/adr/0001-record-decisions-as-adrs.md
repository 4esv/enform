# 0001: Record decisions as ADRs

| Field | Value |
|---|---|
| Status | Accepted |
| Date | 2026-10-08 |
| Refs | A8, `MVP.md` section 11.3 |

## Context

enform is a public project with a long life. Contributors and coding agents will ask why the project made a choice. If the reason is lost, people repeat old discussions or reverse good decisions by accident. Axiom A8 (no mysteries) applies to the project as well as to the product.

## Decision

Record each decision that is costly to reverse as an Architecture Decision Record in `docs/adr/NNNN-title.md`, with the template `0000-template.md`. An accepted ADR does not change. A new ADR supersedes it.

## Alternatives

- **Decisions in issues and pull requests only.** Rejected. They are hard to find, and they are not versioned with the code.
- **One design document that is edited over time.** Rejected. It hides the history and the reasons of each decision.

## Consequences

- Each costly decision has a short, permanent record next to the code.
- A contributor must write an ADR before or with the change. This adds a small cost to each such change.
- To reverse a decision, a contributor writes a new ADR and states the reason.
