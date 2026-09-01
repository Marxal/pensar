-- Round 8: dishes — the bridge between the shopping list and the meal planner.
--
-- NIU.md §4.2: "There is only one concept: a dish." A dish is a name, a picture,
-- a slot, how much cooking it takes, and *optionally* a list of shopping items.
-- With no items it is still a perfectly good dish — just one you can only plan a
-- meal with. With items it also becomes a bundle in the shopping list, which is
-- the half this round builds.
--
-- Two tables:
--
--   dishes       the library. One row per dish, owned by a household.
--   dish_items   which catalogue items a dish is made of. A join table, because
--                the same tomatoes belong to four dishes and to nobody.
--
-- Unlike catalogue_items there is no shared seed here and there should never be
-- one: a household's dishes are theirs, and a starter set of dishes nobody in
-- this house cooks would be clutter on day one. household_id is therefore not
-- null, and the select policy has one arm rather than two.
--
-- Run it once in the Supabase dashboard under SQL Editor. Safe to re-run.

-- ---------------------------------------------------------------------------
-- The dishes
-- ---------------------------------------------------------------------------
-- Two enumerations, both kept as checked text rather than a Postgres enum type,
-- because adding a value to an enum type needs a migration and a lock while
-- adding one to a check constraint is a one-line replace.
--
--   slot  which part of a meal this is (§4.2: protein / carbs / vegetables /
--         other). Round 9's planner sorts its slot pickers by it; this round
--         only stores and shows it.
--
--   cook  §4.2 lists four flags — needs cooking, fast cook, slow cook, no cook —
--         but they are one question with three answers, not four independent
--         booleans: "needs cooking" is exactly "fast or slow". Collapsed here on
--         purpose. If a genuinely independent flag ever turns up (freezer,
--         oven-only), it gets its own column rather than being squeezed in.
--
-- icon holds the same format as catalogue_items.icon — see src/lib/icon-ref.ts.
-- There is no emoji column: a catalogue item's emoji is a *default* the icon
-- style preference may reinterpret, and a dish has no such default. If someone
-- picks an emoji for a dish it is a deliberate choice and lands in icon as
-- 'emoji:🍕'.
--
-- times_added / last_added_at count taps from the shopping side, so the library
-- and the Dishes tiles can lead with what this household actually cooks. The
-- planner's own times_planned / last_planned_at (§7) are deliberately not here:
-- planning a dish and shopping for it are different events, nothing would write
-- them this round, and a column nothing writes is a column that quietly lies.

create table if not exists public.dishes (
  id uuid primary key default gen_random_uuid(),
  household_id uuid not null references public.households (id) on delete cascade,
  name text not null check (char_length(trim(name)) between 1 and 60),
  icon text,
  slot text not null default 'other'
    check (slot in ('protein', 'carbs', 'vegetables', 'other')),
  cook text not null default 'none'
    check (cook in ('none', 'fast', 'slow')),
  times_added integer not null default 0,
  last_added_at timestamptz,
  created_at timestamptz not null default now(),
  created_by uuid references auth.users (id) on delete set null
);

-- One "Lasagne" per household. Same shape as the catalogue's own index, so the
-- two behave the same way when you type a name that already exists.
create unique index if not exists dishes_household_name_idx
  on public.dishes (household_id, lower(trim(name)));

create index if not exists dishes_household_idx on public.dishes (household_id);

-- ---------------------------------------------------------------------------
-- What a dish is made of
-- ---------------------------------------------------------------------------
-- household_id is carried here rather than reached through dish_id, exactly as
-- item_shop_order carries it in 0007: a policy that has to join back to the
-- parent row to decide runs that join on every row of every read, and this
-- table is read on every load.
--
-- The primary key is what stops the same item being added to one dish twice,
-- which matters because the editor writes the ingredient list as a diff.

create table if not exists public.dish_items (
  dish_id uuid not null references public.dishes (id) on delete cascade,
  catalogue_item_id uuid not null references public.catalogue_items (id) on delete cascade,
  household_id uuid not null references public.households (id) on delete cascade,
  added_at timestamptz not null default now(),
  primary key (dish_id, catalogue_item_id)
);

create index if not exists dish_items_household_idx on public.dish_items (household_id);

alter table public.dishes enable row level security;
alter table public.dish_items enable row level security;

-- ---------------------------------------------------------------------------
-- Policies
-- ---------------------------------------------------------------------------
-- A household owns its dishes outright: either of you can write, edit and throw
-- away any of them, the same as the shared list. There is no per-person
-- ownership here and there shouldn't be — "my dishes" and "her dishes" is not
-- how a kitchen works.

drop policy if exists "read your dishes" on public.dishes;
create policy "read your dishes"
  on public.dishes for select to authenticated
  using (public.is_household_member(household_id));

drop policy if exists "add a dish" on public.dishes;
create policy "add a dish"
  on public.dishes for insert to authenticated
  with check (
    public.is_household_member(household_id)
    and created_by = (select auth.uid())
  );

drop policy if exists "change your dishes" on public.dishes;
create policy "change your dishes"
  on public.dishes for update to authenticated
  using (public.is_household_member(household_id))
  with check (public.is_household_member(household_id));

drop policy if exists "remove your dishes" on public.dishes;
create policy "remove your dishes"
  on public.dishes for delete to authenticated
  using (public.is_household_member(household_id));

drop policy if exists "read your dish items" on public.dish_items;
create policy "read your dish items"
  on public.dish_items for select to authenticated
  using (public.is_household_member(household_id));

-- The dish itself must belong to you too, not just the household_id written on
-- the row. Without the second clause a member could staple an ingredient onto
-- another household's dish by passing its id with their own household_id.
drop policy if exists "add dish items" on public.dish_items;
create policy "add dish items"
  on public.dish_items for insert to authenticated
  with check (
    public.is_household_member(household_id)
    and exists (
      select 1 from public.dishes d
      where d.id = dish_id and d.household_id = dish_items.household_id
    )
  );

drop policy if exists "remove dish items" on public.dish_items;
create policy "remove dish items"
  on public.dish_items for delete to authenticated
  using (public.is_household_member(household_id));

-- ---------------------------------------------------------------------------
-- Tapping a dish: everything it needs, onto the list, at once
-- ---------------------------------------------------------------------------
-- "Tapping a dish adds all its items to the list at once" (§4.1). One function
-- rather than one insert per ingredient, for three reasons: it is a single round
-- trip on a phone with one bar of signal, `on conflict do nothing` sorts out the
-- half of the ingredients already on the list without the app having to work out
-- which half, and the count it returns is the truth about what happened rather
-- than the app's guess.
--
-- Deliberately *not* security definer, unlike record_shop(). It needs no
-- privilege the caller hasn't got: RLS on dishes hides other households' dishes,
-- so the lookup below simply finds nothing, and every insert goes through the
-- list's own insert policy. A function that doesn't need to escalate shouldn't.

create or replace function public.add_dish_to_list(dish uuid)
returns integer
language plpgsql
set search_path = ''
as $$
declare
  uid uuid := (select auth.uid());
  hh uuid;
  added integer;
begin
  if uid is null then
    raise exception 'not authenticated';
  end if;

  -- Invisible dish (wrong household, or deleted a second ago) means nothing to
  -- add. Returning 0 rather than raising keeps the app's fail-soft promise: the
  -- worst case is a message saying nothing was added, which is true.
  select d.household_id into hh from public.dishes d where d.id = dish;
  if hh is null then
    return 0;
  end if;

  insert into public.list_items (household_id, catalogue_item_id, added_by)
  select hh, di.catalogue_item_id, uid
  from public.dish_items di
  where di.dish_id = dish
  on conflict (household_id, catalogue_item_id) do nothing;

  get diagnostics added = row_count;

  update public.dishes
     set times_added = times_added + 1,
         last_added_at = now()
   where id = dish;

  return added;
end;
$$;

revoke all on function public.add_dish_to_list(uuid) from public;
grant execute on function public.add_dish_to_list(uuid) to authenticated;

-- ---------------------------------------------------------------------------
-- Realtime
-- ---------------------------------------------------------------------------
-- Both tables go on the stream: a dish invented on one phone should appear on
-- the other, and so should an ingredient added to it, because the tile that
-- claims to add four things has to be right about the four.

do $$
begin
  alter publication supabase_realtime add table public.dishes;
exception
  when duplicate_object then null;
  when undefined_object then null;
end
$$;

do $$
begin
  alter publication supabase_realtime add table public.dish_items;
exception
  when duplicate_object then null;
  when undefined_object then null;
end
$$;
