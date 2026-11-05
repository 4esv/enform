# enform

<!-- description: enform is the open-source, self-hosted multiplayer form builder with steps, approvals and routing. People sign in once, act on their work and always know where a submission is. Developers use the same engine through an API, a CLI and plain files. -->

enform is a self-hosted system for forms with steps, approvals and routing. A person starts a submission, the engine routes it to the right people, each of them acts on it, and everyone can see where it is and why. The same engine serves a web interface, an HTTP API, a command-line tool and plain JSON files, so a flow can be built by a coordinator in the browser or by a developer in a text editor, and both edit the same thing at the same time.

## What it does

- **Forms with steps.** A flow is a sequence of steps. Each step shows a form, decides who may act, and offers outcomes such as approve, reject or send back.
- **Routing to real people.** A step targets a user, a directory group, a team, the person named in a field, or the manager of the starter. Groups and teams resolve live, so a task reaches whoever is on the team today.
- **Reversible actions.** Every manual action is an attributed, versioned operation in one append-only log. A claim, an approval, a takeover or a grant can be undone, and the undo is itself logged.
- **Nobody blocks anybody.** Two people edit one flow at the same time with presence. A draft form is private to its author until submission, and the author keeps working without a connection.
- **Dry runs.** Any version of a flow runs against sample data without side effects: the route, the assignees, the emails and the timers show in a preview, with a simulated clock.
- **One engine, three clients.** The web interface, the CLI and the API share one generated client of one OpenAPI document. Correctness and authorization live in the engine only.

## Start here

- [Quick setup](quick-setup.md): a running installation with a demo organization in under ten minutes.
- [Concepts](concepts.md): flows, steps, targets, scopes, instances and the log.
- [The builder](builder.md): design a flow in the browser, share it, dry-run it and publish it.
- [Forms and conditions](forms.md): the sixteen controls, sections, and the rules that show, require, lock or skip fields.
- [Routing](routing.md): targets, teams, live resolution, reminders, escalation and the Unroutable queue.
- [Acting on work](acting.md): the inbox, claiming, approving, sending back, takeover, release, reassign, withdraw and undo.
- [Realtime and offline](realtime-offline.md): what the interface does on a good, a bad and no connection.
- [CLI reference](cli.md) and [API reference](api.md): the developer path through the same engine.
- [Deployment](deployment.md), [Operations](operations.md) and [Security](security.md): installing, keeping and trusting an installation.

## Principles

1. Nobody blocks anybody.
2. Manual actions are reversible. Everything is logged.
3. The engine is the product. The interface is a client of its public API.
4. No work is lost, also on a bad network.
5. No mysteries. All changes are visible, attributed and in order.

The full scope, the axioms and the invariants are in the [MVP charter](../MVP.md), and the acceptance tests are the [user stories](../STORIES.md). enform is MIT licensed and developed in the open on [GitHub](https://github.com/4esv/enform).
