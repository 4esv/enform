-- Issue #248, S12, SE-3, SE-4, SE-5, I2, I3, I4, ADR 0003, ADR 0011: the
-- durable timers of a task. `timers` is a projection of the log (I4): the row
-- id is the engine's I3 side-effect key for the timer, so a rebuild inserts the
-- same rows and a replay is a no-op (I3). `fire_at` is the absolute time the
-- timer fires, `cancelled_at` records the event that closed the task before the
-- timer fired (SE-5), and `fired_at` records the `timer.fired@1` event that
-- claimed it, so a fired timer never fires again (I3).
--
-- `instance_id`, `step` and `kind` name the task and the timer: a reminder or
-- the escalation. `recipient` is the principal that the timer notifies, and
-- `payload` is the outbox entry's payload, so the worker rebuilds the side
-- effect from the row without deciding anything (SE-1).

alter table timers add column if not exists instance_id text;
alter table timers add column if not exists step text;
alter table timers add column if not exists fired_at bigint;
alter table timers add column if not exists recipient text;
alter table timers add column if not exists payload jsonb not null default '{}'::jsonb;

alter table timers drop constraint if exists timers_kind_check;
alter table timers add constraint timers_kind_check check (kind in ('reminder', 'escalation'));

-- The worker claims the due timers in fire order (SE-1, I3).
create index if not exists timers_claim_idx
  on timers (fire_at, id)
  where cancelled_at is null and fired_at is null;

-- The projection cancels the timers of one task in the event that closes it.
create index if not exists timers_task_idx on timers (instance_id, step);

-- A seed clear removes the timers of the instances it removes (DE-4, I4).
create index if not exists timers_instance_idx on timers (instance_id)
  where instance_id is not null;
