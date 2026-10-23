# enform

The open-source multiplayer form builder for both users and developers.

enform is a self-hosted system for forms with steps, approvals and routing. People sign in with single sign-on, act on their work, and always know where their submissions are. Developers use the same engine through an API, a CLI and plain files.

## Principles

- Nobody blocks anybody.
- Manual actions are reversible. Everything is logged.
- The engine is the product. The interface is a client of its public API.
- No work is lost, also on a bad network.
- No mysteries. All changes are visible, attributed and in order.

## Quick start

```sh
make setup      # Node 26 and pnpm 10; installs the pinned dependencies
make stack      # the local PostgreSQL, Keycloak and Mailpit of deploy/compose.yaml
make init       # writes the configuration, migrates, creates the administrator and serves
make seed       # loads the DE-4 demo organization and prints its credentials once
make seed-clear # removes only the records that the seed created
```

`make init` serves `http://localhost:8080` until you stop it, so run `make seed`
and `make seed-clear` from a second terminal. `enform worker` delivers the
outbox through the configured SMTP URL; the Compose stack runs Mailpit as a
real SMTP sink at `http://localhost:8025` for development and CI. The configuration path, the
database URL and the administrator values are the `ENFORM_*` variables in
[`deploy/README.md`](deploy/README.md). The demo seed creates six users, two
teams, their grants, a published course-overload flow and four in-flight
instances; its passwords are printed once and enform stores none of them.

## Status

Version `0.0.0`. This version contains the specification only. There is no product code yet.

| Document | Content |
|---|---|
| [`MVP.md`](MVP.md) | Scope, axioms, invariants, release plan and versioning rules |
| [`STORIES.md`](STORIES.md) | Golden paths, acceptance tests and evidence |
| [`CONTRIBUTING.md`](CONTRIBUTING.md) | The procedure for each change |
| [`AGENTS.md`](AGENTS.md) | Instructions for coding agents |
| [`docs/adr/`](docs/adr/) | Architecture decisions |
| [`CHANGELOG.md`](CHANGELOG.md) | Changes by release |

## License

MIT. See [`LICENSE`](LICENSE).
