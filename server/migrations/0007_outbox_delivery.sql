-- Issue #240, SE-1, SE-2, I2, I3, I4, ADR 0003, ADR 0011: the delivery state
-- of the outbox. The `outbox` row is a projection of the log (I4): the event
-- operation id and the entry index give its deterministic id, so a rebuild
-- re-creates the same rows (I3). The delivery columns are operational state
-- beside the log, not derived state: the worker updates them, a rebuild
-- restores them by id, and a delivered row stays delivered so a retry is a
-- no-op (I3, SE-1). The log stays the audit record of what was sent and why.
--
-- `effect` is the connector operation (`send-assignment`, `send-sent-back`,
-- ...), `payload` is the entry's payload, and `instance_id`/`flow_slug` let the
-- template build the `/app/?flow=<slug>&instance=<id>` link (SE-2).
--
-- A row is due when its status is `queued` or `failed` and `next_attempt_at`
-- has passed. `sending` is the short claim of a worker batch.

alter table outbox add column if not exists instance_id text;
alter table outbox add column if not exists flow_slug text;
alter table outbox add column if not exists status text not null default 'queued';
alter table outbox add column if not exists attempts integer not null default 0;
alter table outbox add column if not exists next_attempt_at bigint not null default 0;
alter table outbox add column if not exists last_error text;
alter table outbox add column if not exists sent_at bigint;

alter table outbox drop constraint if exists outbox_status_check;
alter table outbox add constraint outbox_status_check
  check (status in ('queued', 'sending', 'sent', 'failed'));

create index if not exists outbox_due_idx
  on outbox (next_attempt_at, created_at, seq)
  where status in ('queued', 'failed');
