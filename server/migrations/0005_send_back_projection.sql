-- Issue #236, S11, WF-3, I4, I5: the revision that a send back records. The
-- column is derived state: a rebuild folds `step.sent-back@1` events into it,
-- and the engine reads it back on the instance as `revisions`. The first time
-- an instance enters a step is revision 1; each send back to that step records
-- the next revision in the payload and here.

alter table instances add column if not exists revisions jsonb not null default '{}'::jsonb;
