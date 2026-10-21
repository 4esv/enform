# 0011: One enform binary, explicit configuration, and Unix service integration

| Field | Value |
|---|---|
| Status | Accepted |
| Date | 2026-10-20 |
| Refs | DE-2, DE-3, DE-5, DX-3, ADR 0003 |

## Context

The only HTTP server today is the test harness. The compose server and worker images do not exist. There is no configuration loader, migration path, health endpoint, signal handling or service unit, so the `0.1.0` demonstration cannot start an installation. DE-2 requires one executable and one configuration surface. DE-3 requires a systemd unit and a container image that run as an unprivileged user, log to stderr, drain on SIGTERM, refuse invalid configuration and expose liveness and readiness endpoints. DE-5 requires migration, backup, restore and doctor procedures. DX-3 makes the CLI a public surface, so a second internal process would become a second entry point that nothing documents. ADR 0003 fixes PostgreSQL as the only datastore and job queue, so the worker, the migrations and the backup procedure all run against that database.

## Decision

One executable, `enform`, with subcommands `serve`, `worker`, `migrate`, `admin`, `seed`, `doctor` and `version`. There is no `enformd`. Configuration is the file `/etc/enform/enform.toml`, the `ENFORM_*` environment and command-line flags; precedence is flag, environment, file, default. Migrations are embedded and versioned, and `migrate` runs them. `serve` refuses to start with pending migrations unless `--auto-migrate`.

Health is at `/healthz` and `/readyz`; the version is at `/version`. SIGTERM drains the server and exits 0. Logs go to stderr. The repository ships `enform.service` and `enform-worker.service`, both running the same binary as an unprivileged user with `Restart=on-failure` and hardening directives. One container image provides both commands. TLS terminates at the edge, and the repository ships an example.

## Alternatives

- **A separate `enformd` daemon plus a CLI.** Rejected. It creates two artifacts and duplicated code, and systemd manages either shape equally well.
- **A separate admin binary.** Rejected for the same reason.
- **Environment-only configuration.** Rejected. A file is reviewable in version control and in deployment, and systemd can read it directly.
- **Auto-migrate on every start by default.** Rejected. A schema change should be a deliberate step. Tiny installations get an explicit opt-in.
- **Log files written by the process.** Rejected. journald or the container runtime owns logs.
- **Running as root.** Rejected. The service needs no privileged operation.

## Consequences

- Easier: one artifact to build, ship and sign, one configuration model, and one place for the health, version, migration and doctor surfaces.
- Harder: packaging and documentation. The unit files, the image, the configuration example and the upgrade procedure become part of the release.
- Constraint: the test harness remains test-only and is never the production server. `make init` and the unit files are part of the definition of done.
