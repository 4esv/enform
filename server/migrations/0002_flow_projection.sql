-- Issue #220, I4, DF-2, DF-4: the flow list needs the draft version and the
-- time of the newest event that the flow recorded. Both are derived state: the
-- draft version is the newest published version plus one, and `updated_at` is
-- the greatest event time, which `server/db.ts` folds from the log. A rebuild
-- truncates `flows` and reproduces both columns.

alter table flows add column if not exists draft_version integer not null default 1;
alter table flows add column if not exists updated_at bigint not null default 0;
