# Routing

<!-- description: How enform routes a task to real, current people: target types, live resolution of groups and teams, dynamic targets, takeover policies, reminders and escalation on durable timers, and the Unroutable queue. -->

A step targets people, not names. The engine resolves the targets to immutable directory IDs, records who received the task and why, and never leaves a task waiting for a person who does not exist.

## Target types

| Target | Resolves to | When |
|---|---|---|
| `user:<id>` | That person. | At task creation. |
| `group:<name>` | The members of the directory group. | Live: when a person views or claims the task. |
| `team:<name>` | The members of the team. | Live. |
| `starter` | The person who started the submission. | At task creation. |
| `field:<key>` | The person chosen in the user field `<key>` of the form. | At task creation. |
| `manager-of:starter` | The manager of the starter, from the directory. | At task creation. |

Live resolution means that a person who joins a team while a task is open sees it in their Available tab at once, and no publication is needed. The instance records both the resolved assignees and the membership at the time of resolution, so the timeline can always answer "who could have claimed this, and why".

## Teams, groups and users

The built-in directory is the default: administrators create users, groups and teams in enform, and users sign in against the local Keycloak user store. There is no self-signup. Users with the `org.teams` scope create and maintain teams at `/?groups=1`; a team change is an attributed operation like any other.

Group membership synchronizes from the identity provider at sign-in and on a schedule. When a user is deprovisioned, every task they hold goes back to the pool and the log records it.

## Claiming and takeover

The first eligible person to claim a task holds it. Each step sets when another eligible person may take it over: always, after an idle period (the default is one hour), or never. The person who takes over must give a reason; the previous holder is told, and either of them, or a flow owner, can undo it.

A holder can **release** a task back to the pool. A flow owner (a holder of `task.reassign`) can **reassign** it to a person with a reason.

## Reminders and escalation

Each step can set a reminder interval and a deadline from the task's start. Reminders go to the holder, or to the assignees while nobody holds the task, at the interval, and stop at the deadline. At the deadline the escalation notifies a person or adds targets; it never removes the current owner.

Timers are durable jobs in PostgreSQL. The engine creates and cancels them in the same transaction as the task they belong to, so a task completed before the deadline cancels its timers atomically, and a worker that stops and restarts near the deadline fires the escalation exactly once.

In a dry run the clock is simulated: "advance one day" fires the reminder and "advance three days" fires the escalation, and both show in the preview inbox. See [The builder](builder.md).

## The Unroutable queue

A task nobody can receive, because a field names a deprovisioned user, a team is empty, or the starter has no manager, goes to the Unroutable queue (`/?queue=1`) instead of waiting in silence. The flow owners get an email, the timeline gives the reason, and a flow owner reassigns the task from the queue. The step tracker shows the task as unroutable until then.

## Explaining a route

`enform flow dry-run <slug> --data <file>` prints each step with its assignees and the target each one resolved through:

```text
advisor    field:advisor         user:okafor       resolved at creation
chair      group:CS-Chairs       skipped: overload_credits <= 2
registrar  team:registrar-office lee, ana, jordan  resolved live
```

The builder's dry-run panel shows the same for each step.
