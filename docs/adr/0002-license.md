# 0002: License the project under MIT

| Field | Value |
|---|---|
| Status | Accepted |
| Date | 2026-10-08 |
| Refs | D8 |

## Context

enform is for institutions, such as universities, that run it on their own servers. Their legal teams must approve the license before they can use it. The project wants a low barrier to adoption and contribution.

## Decision

License all code and documentation under the MIT License. See `LICENSE`.

## Alternatives

- **AGPL-3.0.** It prevents closed hosted forks. Rejected. Many institutions do not approve AGPL software, and adoption is the priority.
- **Apache-2.0.** It gives an explicit patent grant. Rejected for now. MIT is simpler and is already in the repository. A future ADR can change this if patent risk becomes a concern.

## Consequences

- Institutions and individuals can use, change and redistribute enform with few conditions.
- Others can make closed forks or hosted services from enform. The project accepts this.
- Each dependency must have a license that is compatible with MIT.
