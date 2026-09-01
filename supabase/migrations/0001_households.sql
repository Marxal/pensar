-- Round 2: households, and the Row Level Security that makes them mean something.
--
-- The rule this file enforces: you can only see a household you belong to, and
-- you can only see the member list of a household you belong to. The app is
-- never what keeps two families' data apart — this is.
--
-- Run it once, in the Supabase dashboard under SQL Editor. It is safe to run
-- again; every statement is written to be idempotent.

-- ---------------------------------------------------------------------------
-- Tables
-- ---------------------------------------------------------------------------

create table if not exists public.households (
  id uuid primary key default gen_random_uuid(),
  name text not null check (char_length(trim(name)) between 1 and 60),
  created_at timestamptz not null default now(),
  created_by uuid not null references auth.users (id) on delete cascade
);

create table if not exists public.household_members (
  household_id uuid not null references public.households (id) on delete cascade,
  user_id uuid not null references auth.users (id) on delete cascade,
  role text not null default 'member' check (role in ('owner', 'member')),
  joined_at timestamptz not null default now(),
  primary key (household_id, user_id)
);

-- "which households am I in" runs on every load; without this it's a table scan.
create index if not exists household_members_user_id_idx
  on public.household_members (user_id);

alter table public.households enable row level security;
alter table public.household_members enable row level security;

-- ---------------------------------------------------------------------------
-- Membership test
-- ---------------------------------------------------------------------------
-- The obvious policy on household_members — "you may read rows of a household
-- you're a member of" — has to read household_members to decide, which makes
-- Postgres re-run the policy on itself and fail with infinite recursion.
--
-- security definer breaks the loop: the function runs as its owner, so RLS is
-- not applied inside it. It is deliberately tiny and read-only, and takes the
-- household id from the caller, so it cannot leak anything the caller could not
-- already ask about directly.
--
-- search_path is pinned to empty so a caller cannot shadow `household_members`
-- with their own table and trick the function into reading that instead.

create or replace function public.is_household_member(hid uuid)
returns boolean
language sql
security definer
set search_path = ''
stable
as $$
  select exists (
    select 1
    from public.household_members m
    where m.household_id = hid
      and m.user_id = (select auth.uid())
  );
$$;

revoke all on function public.is_household_member(uuid) from public;
grant execute on function public.is_household_member(uuid) to authenticated;

-- ---------------------------------------------------------------------------
-- Policies
-- ---------------------------------------------------------------------------
-- Postgres has no "create policy if not exists", so each is dropped first to
-- keep this file re-runnable.

drop policy if exists "read households you belong to" on public.households;
create policy "read households you belong to"
  on public.households for select to authenticated
  using (public.is_household_member(id));

drop policy if exists "rename households you belong to" on public.households;
create policy "rename households you belong to"
  on public.households for update to authenticated
  using (public.is_household_member(id))
  with check (public.is_household_member(id));

drop policy if exists "read members of your households" on public.household_members;
create policy "read members of your households"
  on public.household_members for select to authenticated
  using (public.is_household_member(household_id));

-- Deliberately absent: insert and delete policies. Creating a household is done
-- through ensure_household() below, and there is no way to add or remove a
-- member yet — that arrives with the invite flow. No policy means no access,
-- which is the safe direction to be wrong in.

-- ---------------------------------------------------------------------------
-- Getting your first household
-- ---------------------------------------------------------------------------
-- Called on first sign-in. Idempotent on purpose: if you already belong to a
-- household it returns that one rather than making a second. Two devices
-- signing in at the same moment therefore can't leave you with two homes.

create or replace function public.ensure_household(household_name text default 'Our home')
returns uuid
language plpgsql
security definer
set search_path = ''
as $$
declare
  existing_id uuid;
  new_id uuid;
  uid uuid := (select auth.uid());
begin
  if uid is null then
    raise exception 'not authenticated';
  end if;

  select m.household_id into existing_id
  from public.household_members m
  where m.user_id = uid
  order by m.joined_at
  limit 1;

  if existing_id is not null then
    return existing_id;
  end if;

  insert into public.households (name, created_by)
  values (coalesce(nullif(trim(household_name), ''), 'Our home'), uid)
  returning id into new_id;

  insert into public.household_members (household_id, user_id, role)
  values (new_id, uid, 'owner');

  return new_id;
end;
$$;

revoke all on function public.ensure_household(text) from public;
grant execute on function public.ensure_household(text) to authenticated;
