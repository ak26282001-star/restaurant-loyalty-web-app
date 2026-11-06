-- Minimal stand-in for Supabase's auth schema so migrations can be tested on plain Postgres.
create schema if not exists auth;
create table if not exists auth.users (id uuid primary key, phone text, email text);
create or replace function auth.uid() returns uuid language sql stable as $$ select null::uuid $$;
do $$ begin
  if not exists (select 1 from pg_roles where rolname = 'anon') then create role anon; end if;
  if not exists (select 1 from pg_roles where rolname = 'authenticated') then create role authenticated; end if;
end $$;
