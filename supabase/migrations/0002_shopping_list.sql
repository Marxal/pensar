-- Round 3: the shopping list, and the catalogue it is tapped from.
--
-- Two tables, and they serve different purposes:
--
--   catalogue_items  the 300-odd grocery tiles you tap. Mostly a shared,
--                    read-only seed list, plus any word a household types that
--                    the seed didn't know about.
--   list_items       what is actually on the list right now. One row per item
--                    on the list; deleted when cleared, not archived.
--
-- The rule this file enforces, same as round 2: you only ever see rows
-- belonging to a household you are a member of. The seeded part of the
-- catalogue is the one deliberate exception — it belongs to nobody and
-- everybody can read it.
--
-- Run it once in the Supabase dashboard under SQL Editor. Safe to re-run.

-- ---------------------------------------------------------------------------
-- Catalogue
-- ---------------------------------------------------------------------------
-- household_id null means "seeded, shared by everyone". A row with a household
-- id is a word one household invented, visible only to them. That split is why
-- the select policy below has two arms.

create table if not exists public.catalogue_items (
  id uuid primary key default gen_random_uuid(),
  household_id uuid references public.households (id) on delete cascade,
  name text not null check (char_length(trim(name)) between 1 and 60),
  category text not null,
  -- Emoji tile. Null means the UI draws a first-letter tile instead, which is
  -- what a newly typed word gets until somebody picks an icon for it.
  icon text,
  -- Fixes the order categories appear in, so the grid doesn't reshuffle
  -- alphabetically into an order nobody walks a shop in.
  sort_order integer not null default 0,
  created_at timestamptz not null default now(),
  created_by uuid references auth.users (id) on delete set null
);

-- Stops the same word existing twice. Two partial indexes rather than one
-- constraint because null household_id (the seeded rows) doesn't compare equal
-- to itself in SQL, so a plain unique constraint would let duplicates through.
create unique index if not exists catalogue_items_seeded_name_idx
  on public.catalogue_items (lower(trim(name)))
  where household_id is null;

create unique index if not exists catalogue_items_household_name_idx
  on public.catalogue_items (household_id, lower(trim(name)))
  where household_id is not null;

create index if not exists catalogue_items_household_idx
  on public.catalogue_items (household_id);

-- ---------------------------------------------------------------------------
-- The list
-- ---------------------------------------------------------------------------

create table if not exists public.list_items (
  id uuid primary key default gen_random_uuid(),
  household_id uuid not null references public.households (id) on delete cascade,
  catalogue_item_id uuid not null references public.catalogue_items (id) on delete cascade,
  quantity numeric check (quantity is null or quantity > 0),
  unit text check (unit is null or char_length(trim(unit)) between 1 and 12),
  note text check (note is null or char_length(note) <= 200),
  urgent boolean not null default false,
  checked_at timestamptz,
  -- Who ticked it. Not shown anywhere yet (NIU.md §7 says store it, and we
  -- decided not to display it), but it is the raw material the learned shop
  -- order will need later, so it is recorded from the start.
  checked_by uuid references auth.users (id) on delete set null,
  added_at timestamptz not null default now(),
  added_by uuid not null references auth.users (id) on delete cascade
);

-- "An item can't be added twice; tapping it again does nothing" (NIU.md §4.1).
-- Enforced here rather than in the app so a double-tap on two phones at the
-- same moment still can't produce two rows.
create unique index if not exists list_items_unique_per_household_idx
  on public.list_items (household_id, catalogue_item_id);

create index if not exists list_items_household_idx
  on public.list_items (household_id);

alter table public.catalogue_items enable row level security;
alter table public.list_items enable row level security;

-- ---------------------------------------------------------------------------
-- Policies
-- ---------------------------------------------------------------------------
-- is_household_member() comes from 0001; it is security definer, so using it
-- here avoids the same policy recursion described in that file.

drop policy if exists "read the catalogue" on public.catalogue_items;
create policy "read the catalogue"
  on public.catalogue_items for select to authenticated
  using (household_id is null or public.is_household_member(household_id));

-- A household can invent a word, but only ever under its own name. The
-- with-check clause is what stops someone inserting a row with household_id
-- null and quietly editing the shared seed list for every other household.
drop policy if exists "add your own catalogue words" on public.catalogue_items;
create policy "add your own catalogue words"
  on public.catalogue_items for insert to authenticated
  with check (
    household_id is not null
    and public.is_household_member(household_id)
    and created_by = (select auth.uid())
  );

drop policy if exists "edit your own catalogue words" on public.catalogue_items;
create policy "edit your own catalogue words"
  on public.catalogue_items for update to authenticated
  using (household_id is not null and public.is_household_member(household_id))
  with check (household_id is not null and public.is_household_member(household_id));

drop policy if exists "read your list" on public.list_items;
create policy "read your list"
  on public.list_items for select to authenticated
  using (public.is_household_member(household_id));

drop policy if exists "add to your list" on public.list_items;
create policy "add to your list"
  on public.list_items for insert to authenticated
  with check (
    public.is_household_member(household_id)
    and added_by = (select auth.uid())
  );

-- Either of you can tick off or edit anything on the shared list — it is one
-- list for the household, not a per-person one.
drop policy if exists "change your list" on public.list_items;
create policy "change your list"
  on public.list_items for update to authenticated
  using (public.is_household_member(household_id))
  with check (public.is_household_member(household_id));

drop policy if exists "remove from your list" on public.list_items;
create policy "remove from your list"
  on public.list_items for delete to authenticated
  using (public.is_household_member(household_id));

-- ---------------------------------------------------------------------------
-- Realtime
-- ---------------------------------------------------------------------------
-- Puts list_items on the realtime stream so both phones stay in sync. RLS still
-- applies to realtime, so a household only receives its own changes.
-- Wrapped because adding a table twice raises an error.

do $$
begin
  alter publication supabase_realtime add table public.list_items;
exception
  when duplicate_object then null;
  when undefined_object then null;
end
$$;
