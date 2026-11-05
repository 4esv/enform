# CLI reference

<!-- description: The enform command line: service commands (init, serve, migrate, worker, admin, seed, doctor, version), flow commands (init, validate, pull, push, publish, diff, dry-run) and the story commands (login, grant, instance, task, undo, log) with --json output. -->

One executable, `enform`, runs the service and drives the engine. Every command accepts `--json` for one JSON object on standard output, so scripts never parse prose. Exit code 0 means success; a refusal or an error exits non-zero and names the reason.

In a source checkout, `enform` is `pnpm exec node --experimental-strip-types cli/main.ts`. In the container image and the bare-metal install it is `enform`.

## Service commands

These read the configuration file, the `ENFORM_*` environment and the flags; a flag wins over the environment, which wins over the file, which wins over the default.

| Command | Does |
|---|---|
| `enform init --admin-email <email> --admin-password <password> [--config <path>] [--smtp-url <url>] [--mail-from <address>] [--no-serve] [--no-open]` | Writes the configuration, creates the database, migrates, creates the first administrator and serves. |
| `enform serve [--auto-migrate]` | Serves the public URL: the interface at the root and the API under `/api/v1`. |
| `enform migrate [--status]` | Applies the pending schema migrations and reports the ones it applied; `--status` lists applied and pending. |
| `enform worker` | Delivers the outbox through SMTP with retries and backoff, fires due timers, and runs the scheduled directory sync. |
| `enform admin create --admin-email <email> --admin-password <password>` | Creates the first administrator. |
| `enform admin rebuild` | Folds every projection out of the log again. |
| `enform admin sync` | Synchronizes every known account with the directory once (ID-5). |
| `enform admin deprovision <user-id>` | Deprovisions a directory user through the server: the account is disabled and the tasks the person holds return to the pool. Sign in first. |
| `enform admin backup --out <file>` | Writes the log and the operational state beside it to one file. |
| `enform admin restore <file> [--database-url <url>]` | Loads a backup into an empty store and rebuilds the projections. |
| `enform seed demo` | Loads the idempotent demo organization and prints its credentials once. |
| `enform seed clear --yes` | Removes only the records the seed created. |
| `enform doctor` | Reports the version and checks the configuration, the session key, the database, the identity provider and email. |
| `enform version` | Prints `enform <version>`. |

Backup, restore and upgrade are described step by step in [Operations](operations.md).

## Flow commands

Flow commands work on a definition file and on the draft of a flow on the server. Sign in first with `enform login`.

| Command | Does |
|---|---|
| `enform flow init <slug>` | Writes `<slug>.flow.json`, a canonical definition with one request step. |
| `enform flow validate <file>` | Validates the file against the schema, compiles its rules and resolves its targets. Exits non-zero and names each error by path. Changes nothing on the server. |
| `enform flow pull <slug>` | Writes the draft to `<slug>.flow.json` in canonical form. A pull after a push gives the same bytes. |
| `enform flow push <file>` | Turns the differences between the file and the draft into operations on the draft. A structural change needs `flow.build`; a label change needs `flow.edit`. |
| `enform flow publish <slug>` | Publishes the draft as the next version with its content hash. |
| `enform flow diff <slug> --from <v\|draft> --to <v\|draft>` | The field-level difference between two versions, or a version and the draft. |
| `enform flow dry-run <slug> --data <file> [--version <v\|draft>] [--as <principal>] [--advance <P1D\|PT4H>]` | Runs a version or the draft against the data file: the route with the skipped steps and their conditions, the assignees of each step and the target they resolve through, the preview inbox, and the timers a moved clock fires. `--as` needs `org.impersonate` and is logged. |

```sh
enform flow init course-overload
# edit course-overload.flow.json
enform flow validate course-overload.flow.json
enform flow push course-overload.flow.json
enform flow dry-run course-overload --data fixtures/sam.json
enform flow publish course-overload
```

## Sign in

| Command | Does |
|---|---|
| `enform login [--server <url>]` | Signs in through the identity provider's device flow: the command shows a URL and a code, you approve in a browser, and the credential is stored per server and refreshed before each command. |
| `enform login --server <url> --username <name> --password <secret>` | A scripted sign-in against the local directory, for automation. |
| `enform logout` | Forgets the credential of the server. |

The server is `--server`, else `ENFORM_SERVER`, else the last sign-in. The credential file is `$ENFORM_CREDENTIALS` or `~/.config/enform/credentials.json`.

## Grants

| Command | Does |
|---|---|
| `enform grant add <principal> <scope[,scope]> <resource>` | Grants the scopes. `user:lee`, `group:CS-Chairs` or `team:registrar-office` on `org`, `flow:<slug>` or `flow:<slug>/step:<key>`. |
| `enform grant list <resource>` | Lists the grants on the resource as scopes. |
| `enform grant revoke <principal> <scope[,scope]> <resource>` | Revokes the scopes. |

```sh
enform grant add group:All-Students instance.start flow:course-overload
enform grant add user:jordan step.outcome:send_back flow:course-overload/step:registrar
enform grant list flow:course-overload
```

## Instances

| Command | Does |
|---|---|
| `enform instance start <slug> --data <file>` | Starts a submission with the values in the file. Prints the instance ID. |
| `enform instance edit <id> --data <file>` | Edits the draft values. |
| `enform instance submit <id> [--data <file>]` | Submits the draft. |
| `enform instance show <id>` | The instance as the current step sees it: values, status line, tracker. |
| `enform instance timeline <id> [--with-changes]` | The timeline; `--with-changes` adds the configuration changes in order. |
| `enform instance withdraw <id> --reason <text>` | Withdraws your own submission. |
| `enform instance cancel <id> --reason <text>` | Cancels a submission as a flow owner. |
| `enform instance undo <id>` | Undoes the withdrawal or the cancellation of the instance, so it reopens at the step it was closed at. |

## Tasks

| Command | Does |
|---|---|
| `enform task list [--available \| --mine \| --started]` | The inbox tabs. |
| `enform task show <id>` | One task. |
| `enform task claim <id>` | Claims it. |
| `enform task complete <id> --outcome <outcome> [--data <file>] [--comment <text>] [--to <step>]` | Completes it with an outcome; `--to` names the step a send back returns to. |
| `enform task takeover <id> --reason <text>` | Takes over a claimed task when the step allows it. |
| `enform task release <id> [--reason <text>]` | Releases it to the pool. |
| `enform task reassign <id> --to <principal> --reason <text>` | Reassigns it as a flow owner. |

## Undo and the log

| Command | Does |
|---|---|
| `enform undo <event-seq> --instance <id> --reason <text>` | Undoes one event of an instance by its sequence number. |
| `enform log [--instance <id>] [--limit <n>]` | The events you may read, in log order; filtered by instance, the newest `n`. |

## Exit codes and errors

| Code | Meaning |
|---|---|
| 0 | Done. |
| 1 | Refused or failed. The message names the reason: a missing scope and the scope that would allow it, a stale version, an invalid definition with its path, a server that is not reachable. |

With `--json` the error is `{"ok": false, "error": "<reason>"}` on standard output.
