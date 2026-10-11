# Event type schemas

One schema for each event type version, for example `task.claimed@1` (MVP.md 9.1, 9.3). The engine never rewrites an event. A changed shape gets a new type version.

A type is published when the interface needs it (MVP.md 9.1, ADR 0004). The two types that the form writes today are published:

- `instance.started@1`
- `instance.submitted@1`

The other eleven event types follow when the interface needs them.
