-- Reduced tables for spike S2. The same history goes to every control database (decision 0005):
-- `custom_domains`, `domain_claims` and `outbox` are global tables, used only in GLOBAL;
-- `artifacts` and `handoffs` are regional, in GLOBAL for the default region and in DB_EU.

create table artifacts (
  id text primary key,
  owner_id text not null,
  access_mode text not null default 'restricted'
    check (access_mode in ('public', 'authenticated', 'restricted')),
  state text not null default 'active'
    check (state in ('active', 'archived', 'suspended', 'purging')),
  bar integer not null default 1,
  -- The authority for serving on a custom host: delivery on a custom host matches this column,
  -- so clearing it stops the host at the next request, whatever any cache says.
  custom_host text
);
create unique index artifacts_custom_host on artifacts (custom_host) where custom_host is not null;

-- A claim proves nothing yet. Several owners may hold a claim for one hostname at once, each with
-- its own token, so a squatter's claim never blocks whoever controls the DNS.
create table domain_claims (
  hostname text not null,
  owner_id text not null,
  artifact_id text not null,
  region text not null,
  token_hash text not null,
  expires_at integer not null,
  primary key (hostname, owner_id)
);

-- One row per hostname that passed the ownership proof. `cf_hostname_id` is Cloudflare's custom
-- hostname, which is Portifact's resource, not the owner's: a transfer keeps it.
create table custom_domains (
  hostname text primary key,
  owner_id text not null,
  artifact_id text not null,
  region text not null,
  state text not null check (state in ('provisioning', 'active', 'detaching')),
  token_hash text not null,
  cf_hostname_id text,
  verified_at integer not null,
  checked_at integer not null,
  missed_checks integer not null default 0
);
create index custom_domains_owner on custom_domains (owner_id, verified_at);

create table outbox (
  id integer primary key autoincrement,
  topic text not null,
  payload text not null
);

-- Read and review handoffs, reduced to what binds a code: kind, artifact and the exact host the
-- app sent it to.
create table handoffs (
  code_hash text primary key,
  kind text not null check (kind in ('read', 'review')),
  artifact_id text not null,
  host text not null,
  user_id text not null,
  expires_at integer not null,
  used_at integer
);
