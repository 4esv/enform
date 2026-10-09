# 0005: Keycloak as identity broker

| Field | Value |
|---|---|
| Status | Accepted |
| Date | 2026-10-08 |
| Refs | ID-1, ID-2, ID-3, ID-4, ID-5 |

## Context

ID-1 fixes sign-in as OIDC through Keycloak, which connects to on-premises Active Directory and to Microsoft Entra ID. ID-2 sends a visitor who is not signed in to SSO and back to the same location. ID-3 makes anonymous access an explicit per-flow setting with a visible label. ID-4 states that immutable directory IDs identify people and groups, not names or email addresses. ID-5 synchronizes group membership at sign-in and on a schedule, returns the claimed tasks of a deprovisioned user to the pool, and records that in the log. Milestone 0.1.0 names "Keycloak with AD and Entra ID (ID-1, ID-4)". Axiom A3 keeps correctness, authorization and state transitions in the engine, so the interface and the engine use only the public API.

## Decision

Keycloak is the identity broker. enform delegates authentication to Keycloak over OIDC, Keycloak federates on-premises Active Directory and Microsoft Entra ID, and enform treats directory IDs as immutable identifiers while synchronizing group membership from the broker.

## Alternatives

- **Direct OIDC to Active Directory and Entra ID without a broker.** Rejected. enform would integrate two provider protocols itself, and no single OIDC surface would remain for ID-1.
- **A password table managed by enform.** Rejected. ID-1 fixes OIDC through Keycloak, and A3 keeps identity out of the engine.
- **A SaaS identity provider, such as Auth0 or Okta.** Rejected. Federating on-premises Active Directory needs a broker inside the network, which self-hosted Keycloak can reach and a cloud service cannot.

## Consequences

- Easier: one OIDC surface for the engine, federation of AD and Entra ID in one place, and scheduled group sync from the broker.
- Harder: operating a Keycloak deployment becomes part of the system.
- Constraint: enform never stores credentials and relies only on immutable directory IDs from the broker.
