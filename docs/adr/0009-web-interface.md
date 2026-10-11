# 0009: Web interface stack

| Field | Value |
|---|---|
| Status | Accepted |
| Date | 2026-10-11 |
| Refs | A9, I12, DX-4, FM-1, MVP.md 9.1, 11.3 |

## Context

A9 makes the engine the product: it decides, and the CLI and the GUI are replaceable clients of the public API. Section 9.1 lists the flow definition format, the HTTP API, the realtime protocol and the event types as the public surfaces, and states that database tables, internal modules and interface markup are not public, so the web interface has no published contract of its own. STORIES.md Test method defines `gui` mode: the scenario runs the same steps in a browser as in `api`, `cli` and `dry`, each GUI step must map to an engine step, and where the modes overlap the results must be equal. Section 8 starts the web interface at milestone `0.4.0`, with the generated API client (DX-4, I12) and the form, and its demonstration is "A dynamic form shows, validates on the server and prints". DX-4 and I12 are done in #93: `interface/client/client.ts` is generated from `api/openapi.yaml`, and `tools/public-api-rule.mjs` makes it the only interface file that may name an API path. Before this issue the repository had no HTML, no interface framework and no browser driver.

## Decision

The interface is plain TypeScript and DOM under `interface/`, with no UI framework and no build step for markup. Playwright drives the browser in `gui` mode.

## Alternatives

- **React.** Rejected. It adds a runtime and a toolchain for a form that is a sequence of API calls, and A9 keeps the decisions in the engine, so there is little client state for a framework to own.
- **Svelte.** Rejected. It compiles markup, so it adds a compiler and a build step for markup.
- **Lit.** Rejected. It adds a component model and a runtime dependency, for the same reason.
- **Vitest browser mode as the driver of `gui` mode.** Rejected. The scenario runner must drive pages itself, so it still needs a browser automation API, which Vitest browser mode does not replace.

## Consequences

- Easier: no build step for markup, no framework to track, and one pinned devDependency for the browser.
- Harder: the interface does its own DOM updates and event handling, and `make setup` downloads the Chromium build.
- Constraint: the interface stays a client of the public API (A9, I12), and `gui` mode drives the browser through Playwright.
