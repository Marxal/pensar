-- Round 10: the meal planner — a week of days, and the two directions between
-- the plan and the shopping list.
--
-- One table does the whole plan:
--
--   meal_entries   one thing planned into one meal on one day.
--
-- "One thing" rather than "one slot", and that is the decision this migration
-- rests on. NIU.md §4.2 was written before round 9 and asks for fixed slots
-- inside each meal, defaulting to protein / carbs / vegetables. Round 9 turned
-- exactly those three words into *dish tags* — free-form, household-owned, and
-- several per dish, because a lasagne is protein and carbs at once. Building
-- slots as well would be two systems for the same idea, and would force every
-- lasagne to pick one home.
--
-- So a meal is a bag: it holds any number of entries, in the order you put them
-- there, and each entry carries its own colour from its dish's tags. "A protein,
-- a carb and a vegetable" becomes something you can *see* rather than a shape
-- you must fill. Marçal's call, 26 Aug 2026.
--
-- An entry is one of four things, which is what `kind` says:
--
--   dish       cook this. Points at a dish.
--   item       a plain catalogue item — "broccoli on Tuesday" is a complete
--              thought and shouldn't need a dish written for it first (§4.2,
--              added after round 8).
--   leftovers  eat it again. May point at the dish it is left over from, or at
--              nothing when it is left over from something that was never
--              planned. Never contributes to the shopping list.
--   out        eating out. Nothing to cook, nothing to buy.
--
-- Run it once in the Supabase dashboard under SQL Editor. Safe to re-run.

-- ---------------------------------------------------------------------------
-- Which meals a day has
-- ---------------------------------------------------------------------------
-- §4.2: "meals per day are configurable, defaulting to lunch and dinner". It is
-- a household setting rather than a device one — unlike the display preferences
-- in prefs.svelte.ts — because both phones look at the same plan and a day that
-- had three meals on one and two on the other would be a plan with a hole in it.
--
-- An array on households rather than a table of its own: this is a choice from
-- a fixed set of three, not a list the household writes. The check constraint is
-- what keeps it that way; a fourth meal is one word here and one line in
-- src/lib/plan.ts.

alter table public.households
  add column if not exists planner_meals text[] not null default array['lunch', 'dinner'];

do $$
begin
  alter table public.households
    add constraint households_planner_meals_check
    check (
      planner_meals <@ array['breakfast', 'lunch', 'dinner']
      and array_length(planner_meals, 1) between 1 and 3
    );
exception
  when duplicate_object then null;
end
$$;

-- ---------------------------------------------------------------------------
-- What a dish's planning history is
-- ---------------------------------------------------------------------------
-- Deferred from round 8 with the note that "a column nothing writes is a column
-- that quietly lies". The planner writes them, so they arrive now.
--
-- Deliberately separate from times_added / last_added_at, which count taps on
-- the *shopping* side. Planning a dish and shopping for it are different events
-- and the picker orders by the first while the Dishes category orders by the
-- second. Merging them would make both numbers mean less.

alter table public.dishes
  add column if not exists times_planned integer not null default 0;
alter table public.dishes
  add column if not exists last_planned_at timestamptz;

-- ---------------------------------------------------------------------------
-- The plan
-- ---------------------------------------------------------------------------
-- `on_date` rather than `date`, which is a type name and reads badly in every
-- query that touches it.
--
-- No unique index on (day, meal, dish). A bag may hold the same thing twice —
-- that is what a bag is — and an index that refused it would make dragging a
-- dish onto a meal that already has it fail for a reason nobody could see.
--
-- Both foreign keys cascade. Deleting a dish therefore takes it off every day it
-- was planned on, which is the honest behaviour: an entry pointing at a dish
-- that no longer exists is a blank card. The delete confirmation says so.

create table if not exists public.meal_entries (
  id uuid primary key default gen_random_uuid(),
  household_id uuid not null references public.households (id) on delete cascade,
  on_date date not null,
  meal text not null check (meal in ('breakfast', 'lunch', 'dinner')),
  -- Order within one meal. Not unique: two entries racing to the same number is
  -- untidy, not broken, and the tie breaks on created_at.
  position integer not null default 0,
  kind text not null check (kind in ('dish', 'item', 'leftovers', 'out')),
  dish_id uuid references public.dishes (id) on delete cascade,
  catalogue_item_id uuid references public.catalogue_items (id) on delete cascade,
  note text check (note is null or char_length(note) <= 120),
  created_at timestamptz not null default now(),
  created_by uuid references auth.users (id) on delete set null,
  -- The one rule that keeps the four kinds honest: each points at what it says
  -- it points at, and at nothing else. Without this a 'dish' entry with a null
  -- dish_id is a card with no name on it, and nothing in the app could tell you
  -- how it got there.
  constraint meal_entries_shape check (
    (kind = 'dish' and dish_id is not null and catalogue_item_id is null)
    or (kind = 'item' and catalogue_item_id is not null and dish_id is null)
    or (kind = 'leftovers' and catalogue_item_id is null)
    or (kind = 'out' and dish_id is null and catalogue_item_id is null)
  )
);

-- The planner reads one week at a time, so the date is what the index is for.
create index if not exists meal_entries_household_date_idx
  on public.meal_entries (household_id, on_date);

alter table public.meal_entries enable row level security;

-- ---------------------------------------------------------------------------
-- Policies
-- ---------------------------------------------------------------------------
-- Same posture as dishes and the list: a household owns its plan outright.
--
-- The insert policy checks both ends the same way dish_items does in 0008 —
-- without those two clauses a member could plan *another household's* dish onto
-- their own week by passing its id alongside their own household_id, and the
-- dish's name would then leak into their planner.

drop policy if exists "read your plan" on public.meal_entries;
create policy "read your plan"
  on public.meal_entries for select to authenticated
  using (public.is_household_member(household_id));

drop policy if exists "plan something" on public.meal_entries;
create policy "plan something"
  on public.meal_entries for insert to authenticated
  with check (
    public.is_household_member(household_id)
    and created_by = (select auth.uid())
    and (
      dish_id is null
      or exists (
        select 1 from public.dishes d
        where d.id = dish_id and d.household_id = meal_entries.household_id
      )
    )
    and (
      catalogue_item_id is null
      or exists (
        select 1 from public.catalogue_items c
        where c.id = catalogue_item_id
          and (c.household_id is null or c.household_id = meal_entries.household_id)
      )
    )
  );

-- Moving an entry is an update of on_date / meal / position, which is the whole
-- point of dragging one. The with-check arm stops a move from also rewriting
-- household_id and posting the entry into someone else's week.
drop policy if exists "change your plan" on public.meal_entries;
create policy "change your plan"
  on public.meal_entries for update to authenticated
  using (public.is_household_member(household_id))
  with check (public.is_household_member(household_id));

drop policy if exists "unplan something" on public.meal_entries;
create policy "unplan something"
  on public.meal_entries for delete to authenticated
  using (public.is_household_member(household_id));

-- ---------------------------------------------------------------------------
-- Planning a dish counts as planning it
-- ---------------------------------------------------------------------------
-- A trigger rather than a second call from the app, so nothing that writes an
-- entry can forget to do it.
--
-- Security *invoker*, deliberately, and worth saying why after round 9's bug:
-- the row it updates is a dish in a household the caller belongs to — the insert
-- policy above has already proved that — and the "change your dishes" policy
-- from 0008 lets a member update it. So this needs no privilege the caller
-- hasn't got, and the silent-zero-rows failure that made add_dish_to_list()
-- definer cannot happen here.
--
-- Only 'dish' entries count. Leftovers are the same dish a second time and
-- counting them would make the picker's "most planned" order reward repeats
-- twice over.

create or replace function public.bump_dish_planned()
returns trigger
language plpgsql
set search_path = ''
as $$
begin
  if new.kind = 'dish' and new.dish_id is not null then
    update public.dishes
       set times_planned = times_planned + 1,
           last_planned_at = now()
     where id = new.dish_id;
  end if;
  return new;
end;
$$;

drop trigger if exists meal_entries_bump_dish on public.meal_entries;
create trigger meal_entries_bump_dish
  after insert on public.meal_entries
  for each row execute function public.bump_dish_planned();

-- ---------------------------------------------------------------------------
-- Shop for this week
-- ---------------------------------------------------------------------------
-- "One button, turns the week's plan into shopping list entries" (§4.2). One
-- function for the same three reasons add_dish_to_list() is one: a single round
-- trip on a phone in a supermarket car park, `on conflict do nothing` sorting
-- out the half already on the list without the app working out which half, and
-- a returned count that is the truth rather than a guess.
--
-- The range is a parameter rather than "this week" so the same function serves
-- the week button and a single day, and so a household that plans a fortnight
-- ahead needs no second function.
--
-- Two sources of items, and both are needed:
--   * every ingredient of every 'dish' entry in range
--   * every 'item' entry in range — the broccoli somebody planned directly
-- 'leftovers' and 'out' contribute nothing, which is the point of them.
--
-- security definer, for exactly the reason 0009 gave: list_item_dishes has no
-- insert policy on purpose, so the one thing allowed to write it must not be
-- subject to RLS. That means the household check RLS was doing for free has to
-- be made by hand — the is_household_member line below.

create or replace function public.add_plan_to_list(from_date date, to_date date)
returns integer
language plpgsql
security definer
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

  -- RLS is off inside a definer function, so membership is established first and
  -- everything below is scoped to the household it found. A member of two
  -- households gets the first they joined, the same rule ensure_dish_tags() uses.
  select m.household_id into hh
  from public.household_members m
  where m.user_id = uid
  order by m.joined_at
  limit 1;

  if hh is null then
    return 0;
  end if;

  if from_date is null or to_date is null or to_date < from_date then
    return 0;
  end if;

  insert into public.list_items (household_id, catalogue_item_id, added_by)
  select distinct hh, wanted.catalogue_item_id, uid
  from (
    select di.catalogue_item_id
    from public.meal_entries e
    join public.dish_items di on di.dish_id = e.dish_id
    where e.household_id = hh
      and e.on_date between from_date and to_date
      and e.kind = 'dish'
    union
    select e.catalogue_item_id
    from public.meal_entries e
    where e.household_id = hh
      and e.on_date between from_date and to_date
      and e.kind = 'item'
      and e.catalogue_item_id is not null
  ) as wanted
  on conflict (household_id, catalogue_item_id) do nothing;

  get diagnostics added = row_count;

  -- Same distinction round 9 drew, and for the same reason: tag *every*
  -- ingredient the plan wants that is on the list, not only the ones this call
  -- put there. Tomatoes already on the list when you shop for the week still
  -- belong to Thursday's lasagne, and untagged they look like nobody's.
  insert into public.list_item_dishes (list_item_id, dish_id, household_id)
  select distinct li.id, e.dish_id, hh
  from public.meal_entries e
  join public.dish_items di on di.dish_id = e.dish_id
  join public.list_items li
    on li.household_id = hh
   and li.catalogue_item_id = di.catalogue_item_id
  where e.household_id = hh
    and e.on_date between from_date and to_date
    and e.kind = 'dish'
  on conflict do nothing;

  return added;
end;
$$;

revoke all on function public.add_plan_to_list(date, date) from public;
grant execute on function public.add_plan_to_list(date, date) to authenticated;

-- ---------------------------------------------------------------------------
-- Realtime
-- ---------------------------------------------------------------------------
-- A week planned on one phone has to be the week the other phone sees, and
-- while two people are sitting on the sofa deciding what to eat, that is the
-- whole feature working or not working.

do $$
begin
  alter publication supabase_realtime add table public.meal_entries;
exception
  when duplicate_object then null;
  when undefined_object then null;
end
$$;
