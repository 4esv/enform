-- Issue #214, I1, I4, I5, I14, ADR 0004, ADR 0012, ADR 0013: the first
-- migration of the one PostgreSQL database. `events` is the append-only log;
-- every other table is a projection that a rebuild folds out of it, except
-- `sessions` and `oidc_attempts`, which are operational state and expire
-- (ADR 0013). Migrations are versioned SQL files that `enform migrate` applies
-- in one transaction each.

create table if not exists schema_migrations (
  version text primary key,
  applied_at bigint not null
);

-- The log (I4): one global sequence, a unique client operation id (I1), the
-- versioned type, the injected-clock time and the attributed payload (I14).
create table if not exists events (
  seq bigint generated always as identity primary key,
  operation_id text not null unique,
  type text not null,
  at bigint not null,
  actor text,
  payload jsonb not null
);
create index if not exists events_type_idx on events (type);
create index if not exists events_at_idx on events (at);

-- One row per grant event (MVP.md 5.6). A rebuild reproduces every row from
-- `config.grant.changed@1` events in log order.
create table if not exists grants (
  principal text not null,
  resource text not null,
  scopes text[] not null,
  seq bigint not null,
  primary key (principal, resource, scopes)
);
create index if not exists grants_principal_idx on grants (principal);

-- The profile cache of ADR 0012. A name or an email address identifies nobody;
-- `id` is the immutable Keycloak subject (ID-4).
create table if not exists principals (
  id text primary key,
  display_name text not null default '',
  email text,
  groups jsonb not null default '[]'::jsonb,
  seq bigint
);

-- Server-side browser and bearer sessions (ADR 0012). The token hash is unique,
-- so a bearer request reuses one row for one token. A revoked or expired row
-- authenticates nothing.
create table if not exists sessions (
  id text primary key,
  principal_id text not null,
  token_hash text unique,
  csrf_token text not null,
  created_at bigint not null,
  expires_at bigint not null,
  last_seen_at bigint not null,
  revoked_at bigint,
  refresh_token text
);
create index if not exists sessions_principal_idx on sessions (principal_id);
create index if not exists sessions_expires_idx on sessions (expires_at);

-- The OIDC authorization-code attempts of ADR 0012. The state names the PKCE
-- verifier and the recorded return path; an expired attempt is not exchanged.
create table if not exists oidc_attempts (
  state text primary key,
  code_verifier text not null,
  return_to text not null,
  created_at bigint not null,
  expires_at bigint not null
);
create index if not exists oidc_attempts_expires_idx on oidc_attempts (expires_at);

-- The flow projections (DF-1, DF-2, DF-4). This slice writes no flow, but the
-- rebuild truncates and folds the tables, so the schema is in place.
create table if not exists flows (
  slug text primary key,
  title text,
  draft jsonb,
  draft_hash text,
  seq bigint
);

create table if not exists flow_versions (
  slug text not null,
  version integer not null,
  content_hash text not null,
  definition jsonb not null,
  published_at bigint not null,
  seq bigint not null,
  primary key (slug, version)
);
create index if not exists flow_versions_hash_idx on flow_versions (content_hash);

-- Instances pin a definition version and carry the optimistic `version` of I5.
create table if not exists instances (
  id text primary key,
  flow_slug text not null,
  definition_version text not null,
  current_step text,
  status text not null default 'open',
  starter text,
  values jsonb not null default '{}'::jsonb,
  version bigint not null default 0,
  seq bigint
);
create index if not exists instances_flow_idx on instances (flow_slug);
create index if not exists instances_starter_idx on instances (starter);

create table if not exists tasks (
  id text primary key,
  instance_id text not null,
  step text not null,
  holder text,
  state text not null default 'available',
  seq bigint
);
create index if not exists tasks_instance_idx on tasks (instance_id);
create index if not exists tasks_holder_idx on tasks (holder);

create table if not exists teams (
  slug text primary key,
  name text not null,
  seq bigint
);

create table if not exists team_members (
  team_slug text not null,
  principal text not null,
  seq bigint,
  primary key (team_slug, principal)
);

-- The outbox and its timers (I2, SE-5). The worker polls these tables; this
-- slice delivers no side effect, so it does not claim a row.
create table if not exists outbox (
  id text primary key,
  effect text not null,
  payload jsonb not null default '{}'::jsonb,
  created_at bigint not null,
  delivered_at bigint,
  seq bigint
);
create index if not exists outbox_pending_idx on outbox (created_at) where delivered_at is null;

create table if not exists timers (
  id text primary key,
  kind text not null,
  fire_at bigint not null,
  cancelled_at bigint,
  seq bigint
);
create index if not exists timers_due_idx on timers (fire_at) where cancelled_at is null;
