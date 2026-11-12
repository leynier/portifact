-- A reduced schema for the acceptance claim of decision 0027: only the columns the claim reads.
create table artifacts (id text primary key, current_version text not null);
create table suggestions (id text primary key, artifact_id text not null, state text not null, attempt text);
create table drafts (artifact_id text not null, user_id text not null, revision integer not null, primary key (artifact_id, user_id));
create table change_items (id integer primary key, artifact_id text not null, state text not null, envelope text not null);
create table acceptance_claims (attempt text primary key, run_token text not null, artifact_id text not null);
