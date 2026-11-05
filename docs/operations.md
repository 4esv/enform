# Operations

<!-- description: Keep an enform installation: the doctor check, backup with enform admin backup or pg_dump, restore into an empty store, schema migration, the upgrade procedure, rebuilding the projections, and what the worker does. Each procedure is tested in CI. -->

The log is canonical. Every projection folds out of it, and `enform admin rebuild` folds it again. That makes operations simple: back up the log, restore it into an empty store, rebuild, and the store answers exactly like before. The integration suite runs each procedure on this page against the real stack on every change.

## Check

```sh
enform doctor --config /etc/enform/enform.toml
```

```text
ok version: enform 0.1.0
ok config: /etc/enform/enform.toml -> https://forms.example.com
ok session encryption key: 32-byte key in base64
ok database: 9 migration(s) applied
ok identity provider: https://sso.example.com/realms/enform
ok email: smtp://mail.example.com:587
```

Every line says `ok` or `fail` with the reason, and `--json` gives the same as one object with `ok`, `version` and `checks`. Run it after an install, after an upgrade and when something looks wrong.

## Backup

Two procedures. Use the first for a portable archive of what enform owns, the second for a full copy of the database.

**enform backup.** Writes the log, the seed records and the delivery state of the outbox to one JSON file with mode `0600`:

```sh
enform admin backup --out /var/backups/enform/$(date +%F).json --config /etc/enform/enform.toml
```

The file names the enform version that wrote it. Sessions and sign-in attempts expire and are not included; a restored installation asks people to sign in again.

**pg_dump.** A full copy of the database, including sessions:

```sh
pg_dump --format=custom --file=/var/backups/enform/$(date +%F).dump "$ENFORM_DATABASE_URL"
```

Use a `pg_dump` of the same major version as the server. Keycloak keeps the users and their passwords; back it up with its own database or `kc.sh export`.

## Restore

**From an enform backup**, into an empty store. The command creates the database when it is missing, migrates it, loads the log, and rebuilds the projections. A store that already holds events is refused, because the log is append-only and two logs do not merge:

```sh
enform admin restore /var/backups/enform/2026-11-05.json \
  --config /etc/enform/enform.toml \
  --database-url postgres://enform:…@db.example.com:5432/enform_restored
```

Point the configuration at the restored database, run `enform doctor`, and start the services.

**From a pg_dump**:

```sh
createdb enform_restored
pg_restore --dbname=postgres://enform:…@db.example.com:5432/enform_restored /var/backups/enform/2026-11-05.dump
enform migrate --database-url postgres://enform:…@db.example.com:5432/enform_restored
```

## Schema migration

Migrations are versioned SQL files that `enform migrate` applies in one transaction each. `enform migrate --status` lists the applied and the pending versions, and `enform migrate` on a migrated store applies nothing and says so. The server refuses to serve a store with pending migrations unless it runs with `--auto-migrate`, which the Compose service does.

## Upgrade

1. Read the changelog of the new version. A breaking change lists its migration steps under Breaking.
2. Stop the worker, then the server: `systemctl stop enform-worker enform`, or scale the Compose services to zero.
3. Back up: `enform admin backup --out …` or `pg_dump`.
4. Install the new version: pull the new image, or check out the tag and run `make setup` and `pnpm build`.
5. Migrate: `enform migrate --config /etc/enform/enform.toml`.
6. Check: `enform doctor`. The version line names the new version.
7. Start the server, then the worker. Open the public URL and sign in.

To roll back, stop the services, restore the backup into an empty store with the old version, and start the old version against it.

## Rebuild

```sh
enform admin rebuild --config /etc/enform/enform.toml
```

Truncates every projection and folds the log again, in one transaction. It keeps the delivery state of the outbox, so a sent email is never sent twice, and it re-applies every clear of a demo seed, so a cleared demo never comes back. Run it after a restore (the restore command does), or when a projection is suspected to be wrong.

## The worker

`enform worker` runs beside the server and does three things on a schedule: delivers the outbox through SMTP with retries and exponential backoff, recording `queued`, `sent` or `failed` with the attempt count and the last error on each message; fires the timers that are due, exactly once each; and synchronizes group membership from the identity provider. A flow owner sends a message again from the task page ("Send again"), or through `POST /api/v1/instances/{id}/mail/{mailId}/resend`: the row is queued again and the log records the resend. More than one worker may run; the store is the only queue, and a row is claimed in a transaction.

## Directory sync and deprovisioning

The worker synchronizes every known account with the identity provider every `ENFORM_DIRECTORY_SYNC_SECONDS` (300 by default; `0` disables the schedule). A sign-in synchronizes the person who signs in, and `enform admin sync` runs one pass by hand. A user disabled or deleted in the directory is deprovisioned: every task they hold returns to the pool with the reason on the timeline, and the log records `user.deprovisioned@1`. An administrator deprovisions a user directly with `enform admin deprovision <user-id>` (after `enform login`) or `POST /api/v1/admin/users/{id}/deprovision`, and a re-enabled user is provisioned again on the next sync.

## Demo seed

`enform seed demo` loads an idempotent demo organization, and `enform seed clear --yes` removes only its records. See [Quick setup](quick-setup.md).

## Logs

The server and the worker log to stderr, one line per event, at the level `ENFORM_LOG_LEVEL` sets. Under systemd the journal keeps them; under Compose the container runtime does.
