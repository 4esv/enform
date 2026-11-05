# CLI

The `enform` command (MVP.md 9.1, DX-3). Command groups: `login`, `flow`, `grant`, `instance`, `task`, `undo`, `log`. Each command accepts `--json`. Command names, flags, exit codes and `--json` output are a public surface.

The CLI uses only the public HTTP API (I12), through the client generated from `api/openapi.yaml` (DX-4). It holds no state transition and no authorization: it reads what it needs from the server, posts one client intent (ADR 0010) and reports what the engine answered. The exit code is 0 on success and 1 on a refusal or a bad command line; with `--json` a refusal is `{ "ok": false, "error": "<reason>" }`.

## Sign in

```sh
enform login --server https://forms.example.edu              # SSO device flow: open the URL, confirm the code
enform login --server https://forms.example.edu --username sam --password secret   # the local directory (ID-6), for scripts
enform logout
```

`login` asks the server which identity provider and client to use (`GET /api/v1/auth/cli`), signs in through the OAuth 2.0 device authorization flow, and stores the credential per server with its refresh token in `$ENFORM_CREDENTIALS`, else `$XDG_CONFIG_HOME/enform/credentials.json`, else `~/.config/enform/credentials.json` (owner-readable only). A stale credential is refreshed before a command uses it. The server of a command is `--server <url>`, else `$ENFORM_SERVER`, else the server of the last sign-in.

## Flows (S01, S03, S04)

```sh
enform flow init course-overload                 # writes course-overload.flow.json in canonical form
enform flow validate course-overload.flow.json   # schema and rule compilation; changes nothing
enform flow push course-overload.flow.json       # the file becomes the draft (creates the flow on the first push)
enform flow pull course-overload                 # writes the draft as the canonical file, byte for byte
enform flow diff course-overload --from 1 --to draft
enform flow publish course-overload              # version n+1, with its content hash
enform flow dry-run course-overload --data fixtures/sam.json               # the draft: the route, who each step goes to, the inbox
enform flow dry-run course-overload --data fixtures/sam.json --version 1 --advance P1D   # a version, one simulated day on (DR-4)
enform flow dry-run course-overload --data fixtures/sam.json --as user:sam  # as another person: needs org.impersonate, recorded (DR-5)
```

`push`, `pull`, `publish`, `diff` and `dry-run` go to the server once one is configured. Without a server they work on the local `.enform/<slug>.json` store, so a definition can be drafted and dry-run offline (`--as` then names the starter only). `init` and `validate` are file-based.

## Grants (S02)

```sh
enform grant add user:lee step.outcome:approve,step.outcome:reject flow:course-overload/step:registrar
enform grant list flow:course-overload
enform grant revoke user:lee step.outcome:reject flow:course-overload/step:registrar
```

A grant needs `org.grants` on `org` or `flow.grant` on the resource; `list` reads the grants of a flow and its steps.

## Instances (S06, S13, S14, S15)

```sh
enform instance start course-overload --data fixtures/sam.json   # a private draft; prints the id
enform instance edit <id> --data more.json
enform instance submit <id>                                      # validates the form and routes it
enform instance show <id>                                        # the status line and the step tracker
enform instance timeline <id> [--with-changes]                   # the events, with the flow's changes (instance.timeline)
enform instance withdraw <id> --reason "Dropped a class"         # the starter
enform instance cancel <id> --reason "Duplicate of #4411"        # instance.cancel
enform instance undo <id>                                        # undo a withdrawal or a cancel within the undo period
```

## Tasks (S09, S10, S11)

```sh
enform task list --available | --mine | --started
enform task claim <id>
enform task complete <id> --outcome approve [--data values.json] [--comment "Within policy"]
enform task complete <id> --outcome send_back --to request --comment "Attach your degree audit"
enform task takeover <id> --reason "Lee is out until 10/19"
enform task release <id> [--reason "..."]
enform task reassign <id> --to user:ana --reason "Ana knows the case"
```

## Undo and the log (S16)

```sh
enform log --instance <id> --limit 5
enform undo <event-seq> --instance <id> --reason "Approved the wrong request"
```

`log` shows the events the signed-in person may read (I8); `undo` appends a compensating event for the latest action on the instance and never rewrites the original.

## Service commands (ADR 0011)

`init`, `serve`, `migrate`, `worker`, `admin`, `seed` and `doctor` run the installation; see `enform help`.
