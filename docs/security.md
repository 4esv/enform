# Security and privacy

<!-- description: How enform authenticates, authorizes and protects data: OIDC sign-in, server-side sessions, scopes evaluated only in the engine, private drafts, sealed device copies, an append-only attributed log, redaction as the one deletion, and the rules sandbox. -->

## Sign-in

Every flow URL requires sign-in by default. A visitor who is not signed in goes to the identity provider and returns to the same location. Sign-in is OIDC through Keycloak; the built-in user store is the default and there is no self-signup. Anonymous access is an explicit per-flow setting with a visible label in the builder and on the form.

People and groups are identified by immutable directory IDs, never by names or email addresses, so a renamed person keeps their history and a reused address grants nothing.

## Sessions

Browser sessions are server-side, with an idle limit (30 minutes by default) and an absolute limit (12 hours), a CSRF token on every write, and a cookie that scripts cannot read. Stored refresh tokens are sealed with a per-installation key that `enform init` writes. The CLI holds a bearer token per server and refreshes it before each command. Sign-out revokes the session and destroys the device's sealed drafts and their key.

## Authorization

Authorization is a pure function of grants, scope and resource, and only the engine evaluates it. The interface and the CLI never decide; they show the server's answer, and a refusal names the scope that would allow the action. Presets in the interface expand to scopes when a grant is made; the engine stores and lists only scopes.

A target of a step may claim its tasks; the `step.outcome:` scopes decide which outcomes the holder may choose. A starter can always read their own submissions. An administrator holds `org.grants` on the organization.

## Drafts are private

A draft submission is private to its author until it is submitted. Others see activity status ("In progress by Sam, last active 2 minutes ago"), never the contents. On the author's device each edit is sealed with a session key (AES-256-GCM through Web Crypto) before it is stored, and thirty idle minutes or a sign-out destroy the key and every ciphertext.

## The server does not trust the client

Every rule and every validation runs again on the server at each submission. The fields a step does not show are not sent to its holder. A step completion records only the values of the fields the step made editable.

## The log

Every change is attributed, versioned and appended to one log in one global order. Nothing is edited in place and nothing is deleted: an undo adds a compensating event. The log is the audit record, and the timeline and the change feed are views of it. Reads of the log are authorized per event: a person reads the events of the instances they may read, the configuration changes of the flows they may follow, and everything with `org.grants`.

The one exception the design reserves is **redaction**: a legal deletion is a redaction event that requires `org.redact`, is attributed, and is not reversible. The event type is defined; no command or route issues it yet.

## Dry runs

A dry run stores nothing of its run and never shows in live views. Running as another person requires `org.impersonate`, and the log records each use, so impersonation is always visible.

## Rules

Conditions are JSON expression trees evaluated by a pure function of the engine: no I/O, no clock, no network. The TypeScript rule node with its sandbox is part of the design (ADR 0008) and not yet in the engine.

## Deployment

The service runs as an unprivileged user, refuses to start on an invalid configuration, and keeps secrets in the configuration file (mode `0600`) or the environment, never in the repository. Change every default password of the Compose stack before it faces a network, terminate TLS at a reverse proxy, and back up Keycloak with the store. See [Deployment](deployment.md).

## Reporting a vulnerability

Open a private security advisory on the [GitHub repository](https://github.com/4esv/enform/security/advisories/new). Do not open a public issue for a vulnerability.
