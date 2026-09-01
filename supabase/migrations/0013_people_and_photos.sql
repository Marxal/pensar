-- Round 11.2: people, including the ones without a phone.
--
-- Marçal's ask: "apart from the connected user, add the possibility to add
-- people manually, for example kids that don't have an account", plus real
-- photos instead of only emoji.
--
-- ## The model change, and why it is a change rather than an addition
--
-- Until now a person *was* a `household_members` row, which is a row about an
-- auth user. A child has no auth user, so the obvious move — a second table for
-- account-less people — would have meant every list of people being a union of
-- two tables and every attendee row pointing at one of two things.
--
-- So instead there is now one table of **people**, and `user_id` on it is
-- nullable. A person with an account and a person without are the same kind of
-- row; the account is a property, not a category. `household_members` keeps its
-- old job and only that job: it is the *access* record, the thing RLS reads to
-- decide what you may see. `household_people` is the *identity* record — the
-- name, the face, the colour — and it is what an event's attendees point at.
--
-- The two stay in step by trigger: joining a household makes you a person.
--
-- ## What can and cannot be edited
--
-- A person with no account belongs to the household: anyone in it can rename
-- them, dress them or remove them. A person *with* an account is themselves:
-- only they can edit their row, and nobody can delete it from here — leaving a
-- household is its own act, not something the other person does to you.
--
-- Run it once in the Supabase dashboard under SQL Editor. Safe to re-run.
-- **It also needs a Storage bucket** — see the note at the bottom.

-- ---------------------------------------------------------------------------
-- 1. People
-- ---------------------------------------------------------------------------

create table if not exists public.household_people (
  id uuid primary key default gen_random_uuid(),
  household_id uuid not null references public.households (id) on delete cascade,
  -- Null means "no account": a child, a grandparent, anybody who is part of the
  -- family's plans without being part of its logins.
  user_id uuid references auth.users (id) on delete cascade,

  display_name text
    check (display_name is null or char_length(trim(display_name)) between 1 and 40),
  colour text not null default 'sky',
  -- One emoji. The cheap face, and still the default.
  avatar text check (avatar is null or char_length(avatar) between 1 and 8),
  -- An object in the `avatars` Storage bucket, as `household_id/person_id.jpg`.
  -- Beats emoji when both are set.
  photo_path text,
  -- Google's own picture, kept as the address rather than the bytes. It is what
  -- makes a new account look like a person before anybody has done anything.
  photo_url text,
  email text,
  position int not null default 0,
  created_at timestamptz not null default now()
);

-- One person per account per household. The partial index is what lets every
-- account-less person share a null.
create unique index if not exists household_people_user_idx
  on public.household_people (user_id)
  where user_id is not null;

create index if not exists household_people_household_idx
  on public.household_people (household_id, position, created_at);

alter table public.household_people enable row level security;

drop policy if exists "read people in your household" on public.household_people;
create policy "read people in your household"
  on public.household_people for select to authenticated
  using (public.is_household_member(household_id));

-- Only account-less people can be added here. An account arrives by joining,
-- and the trigger below writes its person row — letting the app insert one with
-- a user_id would be a way to fake somebody else's identity into a household.
drop policy if exists "add people to your household" on public.household_people;
create policy "add people to your household"
  on public.household_people for insert to authenticated
  with check (public.is_household_member(household_id) and user_id is null);

drop policy if exists "edit people in your household" on public.household_people;
create policy "edit people in your household"
  on public.household_people for update to authenticated
  using (
    public.is_household_member(household_id)
    and (user_id is null or user_id = (select auth.uid()))
  )
  with check (
    public.is_household_member(household_id)
    and (user_id is null or user_id = (select auth.uid()))
  );

drop policy if exists "remove people from your household" on public.household_people;
create policy "remove people from your household"
  on public.household_people for delete to authenticated
  using (public.is_household_member(household_id) and user_id is null);

do $$
begin
  alter publication supabase_realtime add table public.household_people;
exception
  when duplicate_object then null;
  when undefined_object then null;
end
$$;

-- ---------------------------------------------------------------------------
-- Membership makes you a person
-- ---------------------------------------------------------------------------
-- By trigger rather than in join_household(), so that every route in — the
-- first sign-in, a join, a row added by hand in the dashboard — produces the
-- same result. `on conflict do nothing` makes rejoining harmless.

create or replace function public.person_for_member()
returns trigger
language plpgsql
security definer
set search_path = ''
as $$
begin
  insert into public.household_people (household_id, user_id, display_name, colour, avatar, email)
  select new.household_id, new.user_id, m.display_name, m.colour, m.avatar, m.email
  from public.household_members m
  where m.household_id = new.household_id and m.user_id = new.user_id
  on conflict (user_id) where user_id is not null do nothing;

  return new;
end;
$$;

drop trigger if exists household_members_person on public.household_members;
create trigger household_members_person
  after insert on public.household_members
  for each row execute function public.person_for_member();

-- ---------------------------------------------------------------------------
-- 2. Carry round 11's profiles across
-- ---------------------------------------------------------------------------
-- The name, colour, avatar and email columns 0012 put on household_members move
-- here. They are left in place on the old table rather than dropped: an app
-- version still in a phone's cache reads them, and four unread columns cost
-- nothing. Nothing writes them from round 11.2 on.

insert into public.household_people (household_id, user_id, display_name, colour, avatar, email)
select m.household_id, m.user_id, m.display_name, m.colour, m.avatar, m.email
from public.household_members m
on conflict (user_id) where user_id is not null do nothing;

-- ---------------------------------------------------------------------------
-- 3. Attendees point at people, not accounts
-- ---------------------------------------------------------------------------
-- The whole reason for the round: "who goes" has to be able to name a child.
--
-- Done as add-backfill-drop inside one migration so there is never a moment
-- with two sources of truth. The confirmations table is deliberately *not*
-- touched: only somebody with an account can be asked to confirm anything, so
-- it stays keyed on auth users.

alter table public.event_attendees
  add column if not exists person_id uuid references public.household_people (id) on delete cascade;

update public.event_attendees a
   set person_id = p.id
  from public.household_people p
 where a.person_id is null
   and p.user_id = a.user_id
   and p.household_id = a.household_id;

-- Anything that could not be matched had no person to match — an attendee whose
-- account left the household. Drop those rather than carry a dangling row.
delete from public.event_attendees where person_id is null;

alter table public.event_attendees
  alter column person_id set not null;

-- The old primary key was (event_id, user_id). Swap it for the new pair.
alter table public.event_attendees
  drop constraint if exists event_attendees_pkey;

alter table public.event_attendees
  drop column if exists user_id;

do $$
begin
  if not exists (
    select 1 from pg_constraint
    where conrelid = 'public.event_attendees'::regclass and contype = 'p'
  ) then
    alter table public.event_attendees
      add constraint event_attendees_pkey primary key (event_id, person_id);
  end if;
end
$$;

-- ---------------------------------------------------------------------------
-- 4. Photos
-- ---------------------------------------------------------------------------
-- ## The bucket has to be made by hand, once
--
-- In the Supabase dashboard: **Storage → New bucket**, named exactly `avatars`,
-- and **not public**. Then run this file, which writes its policies.
--
-- Private rather than public, deliberately. These are photographs of a family
-- including children; a public bucket means anyone holding the address can view
-- them forever. Private means the app asks for a signed link that expires, which
-- costs one extra call on load and is the right way round for this content.
--
-- ## The path is the permission
--
-- Every object is `household_id/person_id.jpg`. The first folder is therefore
-- the household, and every policy below is the same sentence: you may touch an
-- object whose first folder is a household you belong to. That is why the path
-- convention is not a convention — it is the security model, and changing it in
-- the app without changing it here would open the bucket up.

-- Reads the household out of an object's path, or null if the path is not that
-- shape. A plain `::uuid` cast would *throw* on anything else, and a policy that
-- throws fails the whole query — including for objects in other buckets, since
-- SQL does not promise to test `bucket_id` first. Returning null instead makes
-- is_household_member() answer false, which is the right answer.
create or replace function public.avatar_household(object_name text)
returns uuid
language sql
immutable
set search_path = ''
as $$
  select case
    when (storage.foldername(object_name))[1] ~
         '^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$'
    then ((storage.foldername(object_name))[1])::uuid
  end;
$$;

grant execute on function public.avatar_household(text) to authenticated;

drop policy if exists "read avatars in your household" on storage.objects;
create policy "read avatars in your household"
  on storage.objects for select to authenticated
  using (
    bucket_id = 'avatars'
    and public.is_household_member(public.avatar_household(name))
  );

drop policy if exists "upload avatars in your household" on storage.objects;
create policy "upload avatars in your household"
  on storage.objects for insert to authenticated
  with check (
    bucket_id = 'avatars'
    and public.is_household_member(public.avatar_household(name))
  );

drop policy if exists "replace avatars in your household" on storage.objects;
create policy "replace avatars in your household"
  on storage.objects for update to authenticated
  using (
    bucket_id = 'avatars'
    and public.is_household_member(public.avatar_household(name))
  )
  with check (
    bucket_id = 'avatars'
    and public.is_household_member(public.avatar_household(name))
  );

drop policy if exists "delete avatars in your household" on storage.objects;
create policy "delete avatars in your household"
  on storage.objects for delete to authenticated
  using (
    bucket_id = 'avatars'
    and public.is_household_member(public.avatar_household(name))
  );
