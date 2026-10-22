-- Issue #234, DE-4, I4, I14: the operational record of what a seed profile
-- created. `enform seed demo` marks every user, team, flow, instance and grant
-- it creates; `enform seed clear` removes only those records. The table is not
-- a projection of the log and a rebuild never truncates it, so a rebuild can
-- re-apply every cleared record and never resurrects a cleared demo.

create table if not exists seed_records (
  profile text not null,
  kind text not null check (kind in ('user', 'team', 'flow', 'instance', 'grant')),
  id text not null,
  created_at bigint not null,
  cleared_at bigint,
  primary key (profile, kind, id)
);

create index if not exists seed_records_live_idx
  on seed_records (profile)
  where cleared_at is null;
