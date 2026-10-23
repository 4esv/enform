-- Issue #252, S08, I10, AS-5, I4: the Unroutable queue projection. A task
-- whose targets resolve to nobody records `queue:unroutable` on the start or
-- the completion that entered it, so the task is never dropped. The column is
-- derived state: a rebuild folds the queue from `instance.started@1` and
-- `step.completed@1` back into the same rows (I4). The instance keeps the
-- queue of its current step for the tracker and the task page, and the task
-- keeps it for the queue view.

alter table instances add column if not exists queue text;
alter table tasks add column if not exists queue text;

-- The queue view reads the open unroutable tasks in activity order.
create index if not exists tasks_queue_idx on tasks (queue) where queue is not null;

-- A seed group is a directory object, not a projection (DE-4, ID-6): the
-- record kind names it so `seed clear` deletes the Keycloak group.
alter table seed_records drop constraint if exists seed_records_kind_check;
alter table seed_records add constraint seed_records_kind_check
  check (kind in ('user', 'group', 'team', 'flow', 'instance', 'grant'));
