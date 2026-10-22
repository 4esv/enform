-- Issue #222, I4, I5, I13, ADR 0013: the instance, task and submission
-- projections of a live journey. The log is the source of truth; these columns
-- are the derived state that a rebuild folds from instance.started@1,
-- step.claimed@1, step.completed@1 and instance.submitted@1. `instances.version`
-- is the same counter the engine advances for I5, so a read and a rebuild agree.

alter table instances add column if not exists holder text;
alter table instances add column if not exists submitted boolean not null default false;
alter table instances add column if not exists done boolean not null default false;

alter table tasks add column if not exists assignees jsonb not null default '[]'::jsonb;
alter table tasks add column if not exists last_activity_at bigint not null default 0;
