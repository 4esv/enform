# Event type schemas

One schema for each event type version, for example `task.claimed@1` (MVP.md 9.1, 9.3). The engine never rewrites an event. A changed shape gets a new type version, and before the first tagged release it extends the current type version in place, because no event of the old shape was ever written and there is nothing to convert (MVP.md 9.3, #188).

A type is published when the interface needs it (MVP.md 9.1, ADR 0004). The event types that the interface needs today are published:

- `instance.started@1`
- `instance.submitted@1`
- `instance.withdrawn@1` (#238)
- `instance.cancelled@1` (#238)
- `instance.undone@1` (#238)
- `step.taken-over@1` (#242)
- `config.flow.title@1` (#220)

The other event types follow when the interface needs them. `seed.cleared@1` stays internal: it is operational state for the demo seed and clear (DE-4), and no interface reads it.
