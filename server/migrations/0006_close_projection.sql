-- Issue #238, S13, WF-4, WF-5, I4, I5: the close projection. A withdrawal or
-- a cancellation closes the open task and records the step and holder that the
-- undo restores. The columns are derived state: a rebuild folds
-- instance.withdrawn@1, instance.cancelled@1 and instance.undone@1 back into
-- them, so a live append and a rebuild agree (I4).

alter table instances add column if not exists withdrawal text;
alter table instances add column if not exists previous_step text;
alter table instances add column if not exists previous_holder text;
alter table instances add column if not exists closed_at bigint;
alter table instances add column if not exists closed_by text;
