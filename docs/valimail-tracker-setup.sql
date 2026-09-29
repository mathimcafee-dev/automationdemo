-- DMARC Essentials partner launch tracker: one-time setup
-- Run once in Supabase: Dashboard > SQL Editor > New query > paste > Run.

create extension if not exists pgcrypto with schema extensions;

create table if not exists public.valimail_tracker (
  id int primary key default 1 check (id = 1),
  data jsonb not null,
  version int not null default 1,
  updated_at timestamptz not null default now(),
  updated_by text
);
create table if not exists public.valimail_tracker_secret (
  id int primary key default 1 check (id = 1),
  code_hash text not null
);
-- Lock both tables: no direct access from the browser. Access only via the functions below.
alter table public.valimail_tracker enable row level security;
alter table public.valimail_tracker_secret enable row level security;
revoke all on public.valimail_tracker, public.valimail_tracker_secret from anon, authenticated;

-- Set (or change) the passcode. To change it later, rerun just this statement with a new passcode.
insert into public.valimail_tracker_secret (id, code_hash)
values (1, extensions.crypt('CHOOSE-A-LONG-PASSCODE', extensions.gen_salt('bf')))
on conflict (id) do update set code_hash = excluded.code_hash;

create or replace function public.valimail_get(p_code text)
returns jsonb language plpgsql security definer set search_path = public, extensions as $$
declare h text; r public.valimail_tracker;
begin
  select code_hash into h from public.valimail_tracker_secret where id = 1;
  if h is null or extensions.crypt(p_code, h) <> h then raise exception 'invalid_code'; end if;
  select * into r from public.valimail_tracker where id = 1;
  if r.id is null then return null; end if;
  return jsonb_build_object('data', r.data, 'version', r.version, 'updated_at', r.updated_at, 'updated_by', r.updated_by);
end $$;

create or replace function public.valimail_save(p_code text, p_data jsonb, p_by text, p_version int)
returns jsonb language plpgsql security definer set search_path = public, extensions as $$
declare h text; r public.valimail_tracker;
begin
  select code_hash into h from public.valimail_tracker_secret where id = 1;
  if h is null or extensions.crypt(p_code, h) <> h then raise exception 'invalid_code'; end if;
  select * into r from public.valimail_tracker where id = 1 for update;
  if r.id is not null and r.version <> p_version then
    return jsonb_build_object('conflict', true, 'data', r.data, 'version', r.version, 'updated_at', r.updated_at, 'updated_by', r.updated_by);
  end if;
  insert into public.valimail_tracker (id, data, version, updated_at, updated_by)
  values (1, p_data, 1, now(), left(p_by, 60))
  on conflict (id) do update set data = excluded.data, version = public.valimail_tracker.version + 1, updated_at = now(), updated_by = excluded.updated_by
  returning * into r;
  return jsonb_build_object('conflict', false, 'version', r.version, 'updated_at', r.updated_at, 'updated_by', r.updated_by);
end $$;

revoke all on function public.valimail_get(text), public.valimail_save(text, jsonb, text, int) from public;
grant execute on function public.valimail_get(text), public.valimail_save(text, jsonb, text, int) to anon, authenticated;
