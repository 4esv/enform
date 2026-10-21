# 0012: Make the local directory the default and hold sessions on the server

| Field | Value |
|---|---|
| Status | Accepted |
| Date | 2026-10-20 |
| Refs | ID-1, ID-4, ID-5, ID-6, DX-3, ADR 0005, ADR 0011 |

## Context

ID-1 fixes sign-in as OIDC through Keycloak. ID-6 makes the built-in user store the default directory and makes federation with Active Directory and Microsoft Entra ID optional per installation, with no self-signup. ID-4 states that immutable directory IDs identify people and groups, never names or email addresses. ID-5 synchronizes group membership at sign-in and on a schedule and returns the claimed tasks of a deprovisioned user to the pool. DX-3 makes the CLI a public surface, and it lists `login` as a command group, so the CLI needs a credential of its own. ADR 0005 fixes Keycloak as the broker and forbids enform from storing credentials. ADR 0011 makes one `enform` binary the whole process model, so the browser and the CLI talk to the same server and the same configuration.

Today no sign-in exists on either path. The browser takes its principal from the `?actor=` query parameter of the test harness, and the CLI has no login and no credential store. A release installation therefore has no way to know who a request belongs to, and no way to end a browser session: a bearer token in the browser cannot be revoked, and nothing records the membership that ID-5 synchronizes.

## Decision

Keycloak is the only identity provider. Its built-in user store is the default directory, and AD and Entra ID are optional federations that each installation configures. The immutable principal ID is the Keycloak subject (`sub`). enform caches the display name, the email address and the group memberships for display and for membership resolution, but a name or an email address never identifies a principal.

Users are created by an administrator through enform's admin API, which calls the Keycloak Admin API with a dedicated service account. The user receives a one-time invite or a temporary credential and sets a password on first sign-in. There is no public self-signup. Groups are Keycloak groups; teams are enform's own (AS-6) and may contain users and groups. Membership synchronizes at sign-in and on a schedule, and a deprovisioned user's claimed tasks return to the pool (ID-5).

The browser session is OIDC authorization code with PKCE. The server validates the issuer, the audience, the nonce, the signature through the JWKS and the expiry, then creates a server-side session row in PostgreSQL and sets an `HttpOnly`, `Secure`, `SameSite=Lax` cookie. The session ID rotates at login, a CSRF token guards every state-changing request, and idle and absolute timeouts apply. Logout revokes the session row and ends the Keycloak session. No token is stored in `localStorage`.

`enform login` uses the OIDC device authorization grant, or a loopback redirect with PKCE when a browser is available. It stores the credential in a `0600` file under `$XDG_CONFIG_HOME/enform/`, with `ENFORM_TOKEN` as the automation override. The server accepts the session cookie for the browser and a bearer access token for the CLI, and maps both to the same principal and the same session row.

The `?actor=` harness seam stays in the test harness only. It is absent from the production binary.

## Alternatives

- **A password store owned by enform.** Rejected. ID-6 asks for a default directory, not a second credential implementation, and a password table would put credential handling, reset and rate limiting into the engine, against ADR 0005 and axiom A3.
- **Public self-signup on the local directory.** Rejected by ID-6. An installation decides who belongs to the organization.
- **A JWT held in `localStorage`.** Rejected. Any script on the page can read it, and nothing can revoke it before it expires.
- **Server-side sessions without OIDC, keyed by a password form.** Rejected. ID-1 fixes OIDC through Keycloak, and Keycloak already provides the federation, the password policy and the group store.
- **Magic links only.** Rejected. It makes the mail transport a hard dependency of every sign-in, and DE-5 lists the mail transport as something `doctor` checks, not as something the installation cannot run without.
- **Direct LDAP from enform.** Rejected by ADR 0005. enform integrates one OIDC surface, and Keycloak owns the directory protocol.
- **A bearer access token for the browser on every request.** Rejected. It gives no server-side revocation, so logout and deprovisioning cannot end a session (ID-5).
- **A second session store, such as Redis.** Rejected by ADR 0003. One database holds the session, so revoking a session and revoking membership commit in one place.

## Consequences

- Easier: one principal model for the browser and the CLI, a session that can be revoked on logout and on deprovisioning, and a default directory that works before any federation exists.
- Harder: an installation runs Keycloak with a realm, a client and an admin service account, and `doctor` must check the identity provider (DE-5). Sign-in, logout, the account page and the CLI login become surfaces with their own tests, and the integration tests need a real Keycloak.
- Constraint: new tables for sessions and CSRF tokens, and those two are operational state, not events on the log (see ADR 0013). The engine still authorizes every read and write (I8) from the principal that the session names.
