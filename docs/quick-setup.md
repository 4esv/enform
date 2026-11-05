# Quick setup

<!-- description: Install enform from a copy of the repository with one command, load the demo organization and open your first flow in under ten minutes. Docker, Node 26 and pnpm 10 are all you need. -->

This page takes a fresh machine to a running enform with a demo organization. It needs Docker with Compose, Node 26 and pnpm 10, and a copy of the repository.

## 1. Get the code

```sh
git clone https://github.com/4esv/enform.git
cd enform
make setup
```

`make setup` installs the pinned dependencies. It also installs the Chromium build that the browser test suite uses; that download is the slow part.

## 2. Start it

```sh
make init
```

This is the one documented bootstrap command. It starts PostgreSQL, Keycloak and Mailpit from `deploy/compose.yaml` when they are not reachable, then runs `enform init`, which writes the configuration file, creates the database, applies the schema migrations, creates the first administrator and serves `http://localhost:8080` until you stop it.

The defaults are development values. Each one is an `ENFORM_*` variable you can set before the command; the table is in [Deployment](deployment.md).

| What | Default |
|---|---|
| Public URL | `http://localhost:8080` |
| Administrator | `admin@example.com` / `admin-dev-password` |
| Keycloak | `http://localhost:8081`, realm `enform-local`, admin `admin` / `admin` |
| Email | `smtp://127.0.0.1:1025`, the Mailpit of the stack, read at `http://localhost:8025` |
| Configuration file | `~/.config/enform/enform.toml` |

## 3. Load the demo organization

From a second terminal:

```sh
make seed
```

`enform seed demo` creates six users, two teams, their grants, a published course-overload flow and four submissions at different steps. It prints each demo email, its generated password and the flow URL once. enform stores no password; if you lose them, run `make seed-clear` and `make seed` again.

Open the flow URL it printed, sign in as the student it names, and you are looking at a form that routes to an advisor, a department chair and the registrar's office. Sign in as the advisor in a private window to see the task in the inbox.

## 4. Send email (optional)

The Compose stack runs Mailpit as a real SMTP sink, and `make init` configured its SMTP URL. To see the assignment, reminder and escalation emails, run the worker from a third terminal and open `http://localhost:8025`:

```sh
make worker
```

Without an SMTP URL the worker logs each queued side effect once and sends nothing, so an installation without a mail server still runs.

## 5. Check the installation

```sh
make doctor
```

`enform doctor` reports the version and checks the configuration, the session key, the database and its migrations, the identity provider and the mail transport. Every line says `ok` or `fail` with the reason.

## 6. Remove the demo

```sh
make seed-clear
```

Only the seeded records go. The append-only log keeps their events as the audit record, and a rebuild of the projections never brings the demo back.

## Next

- Build your own flow in the browser: [The builder](builder.md).
- Or write it as a file and push it from the terminal: [CLI reference](cli.md), starting with `enform flow init`.
- Put it on a server: [Deployment](deployment.md).
