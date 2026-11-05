# Event type schemas

One schema for each event type version, for example `task.claimed@1` (MVP.md 9.1, 9.3). The engine never rewrites an event. A changed shape gets a new type version, and before the first tagged release it extends the current type version in place, because no event of the old shape was ever written and there is nothing to convert (MVP.md 9.3, #188).

A type is published when the interface needs it (MVP.md 9.1, ADR 0004). The event types that the interface needs today are published:

- `instance.started@1`
- `instance.submitted@1`
- `draft.edited@1` (#256, ADR 0014)
- `event.undone@1` (#256, S16)
- `task.released@1` (#256, WF-5)
- `task.reassigned@1` (#256, WF-5)
- `draft.rebound@1` (#256, RT-6)
- `instance.withdrawn@1` (#238)
- `instance.cancelled@1` (#238)
- `instance.undone@1` (#238)
- `step.taken-over@1` (#242)
- `config.flow.title@1` (#220)
- `user.deprovisioned@1` (#267, ID-5)

The other event types follow when the interface needs them. `seed.cleared@1` stays internal: it is operational state for the demo seed and clear (DE-4), and no interface reads it. `timer.fired@1` (#248) is the worker's record of one durable timer firing (SE-3, SE-4, SE-5, I2, I3); the timeline shows it, but no client posts it. `dryrun.ran@1` (#264) is the server's record of a dry run that ran as another person (DR-5, I14): it names the flow, the version and the person, and no client posts it. `user.provisioned@1` (#267) is the directory synchronization's record that a deprovisioned person is held by the directory again (ID-5): it names the principal, and no client posts it.
