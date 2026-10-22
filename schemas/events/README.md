# Event type schemas

One schema for each event type version, for example `task.claimed@1` (MVP.md 9.1, 9.3). The engine never rewrites an event. A changed shape gets a new type version, and before the first tagged release it extends the current type version in place, because no event of the old shape was ever written and there is nothing to convert (MVP.md 9.3, #188).

A type is published when the interface needs it (MVP.md 9.1, ADR 0004). The three event types that the interface needs today are published:

- `instance.started@1`
- `instance.submitted@1`
- `config.flow.title@1` (#220)

The other event types follow when the interface needs them.
