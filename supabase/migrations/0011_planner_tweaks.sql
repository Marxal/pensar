-- Round 10.1: Marçal's notes after using the planner.
--
-- Three things, all small, none of which change a decision from 0010:
--
--   1. meal_entries.to_cook — a hand-set "this one needs cooking" mark.
--   2. catalogue_categories — moving a shared catalogue item into a different
--      category, per household.
--   3. add_plan_to_list() learns to add only part of what the week wants, so the
--      shop preview can be a list you tick rather than an all-or-nothing button.
--
-- Run it once in the Supabase dashboard under SQL Editor. Safe to re-run.

-- ---------------------------------------------------------------------------
-- "Cook it"
-- ---------------------------------------------------------------------------
-- A boolean rather than a fifth `kind`, because it is orthogonal to what an
-- entry *is*: a dish can need cooking, and so can a plain item ("that broccoli
-- won't roast itself"). Squeezing it into `kind` would mean 'dish' and
-- 'dish-to-cook' as separate values, and then the same again for items.
--
-- It is also deliberately *not* dishes.cook, which is a property of the recipe —
-- "a lasagne is a slow one" is true forever. This is a property of the evening:
-- tonight, someone has to actually do it.
--
-- Set by hand, by design (Marçal, round 10.1). The planner already infers the
-- opposite mark — a repeat, from the same dish two nights running — and it would
-- be easy to infer this one as its negation. But inferring both would mean every
-- card in the week claiming something about cooking, and the point of this mark
-- is that it is a note *you* left yourself. If it turns out to be tedious to set,
-- turning it automatic is a one-line default and this column still holds the
-- override.

alter table public.meal_entries
  add column if not exists to_cook boolean not null default false;

-- ---------------------------------------------------------------------------
-- Moving something to a different category
-- ---------------------------------------------------------------------------
-- Same shape and the same reason as catalogue_icons in 0005: most of the
-- catalogue is a *shared* seed with `household_id is null`, which no household
-- may edit — one house deciding that halloumi belongs under Cheese must not move
-- it for everybody. So the change is stored as an override beside the row rather
-- than written into it.
--
-- The category is free text rather than a foreign key, exactly as
-- catalogue_items.category is: categories in this app are names the seed uses
-- and names a household invents, never rows with ids.

create table if not exists public.catalogue_categories (
  household_id uuid not null references public.households (id) on delete cascade,
  catalogue_item_id uuid not null references public.catalogue_items (id) on delete cascade,
  category text not null check (char_length(trim(category)) between 1 and 40),
  set_at timestamptz not null default now(),
  set_by uuid references auth.users (id) on delete set null,
  primary key (household_id, catalogue_item_id)
);

create index if not exists catalogue_categories_household_idx
  on public.catalogue_categories (household_id);

alter table public.catalogue_categories enable row level security;

drop policy if exists "read your category choices" on public.catalogue_categories;
create policy "read your category choices"
  on public.catalogue_categories for select to authenticated
  using (public.is_household_member(household_id));

drop policy if exists "set categories in your household" on public.catalogue_categories;
create policy "set categories in your household"
  on public.catalogue_categories for insert to authenticated
  with check (
    public.is_household_member(household_id)
    and set_by = (select auth.uid())
  );

drop policy if exists "change categories in your household" on public.catalogue_categories;
create policy "change categories in your household"
  on public.catalogue_categories for update to authenticated
  using (public.is_household_member(household_id))
  with check (public.is_household_member(household_id));

drop policy if exists "clear categories in your household" on public.catalogue_categories;
create policy "clear categories in your household"
  on public.catalogue_categories for delete to authenticated
  using (public.is_household_member(household_id));

do $$
begin
  alter publication supabase_realtime add table public.catalogue_categories;
exception
  when duplicate_object then null;
  when undefined_object then null;
end
$$;

-- ---------------------------------------------------------------------------
-- Shopping for *part* of the plan
-- ---------------------------------------------------------------------------
-- The 0010 version was all or nothing: everything the week wants, onto the list.
-- The preview it sits behind is now a list you tick, because half of deciding
-- what to buy is deciding what you already have enough of — so the function
-- takes the ids that survived that.
--
-- `only_items` defaults to null, which means "everything", so an old two-argument
-- call still behaves exactly as it did. The old signature is dropped first
-- because `create or replace` cannot change an argument list — it would leave two
-- overloads and PostgREST would have to guess between them.
--
-- The tagging half is scoped to the same subset. Without that, ticking the
-- tomatoes off the list would still tag them "for Lasagne" on a row that was
-- never added, and the mark would sit on the shopping list pointing at nothing.

drop function if exists public.add_plan_to_list(date, date);

create or replace function public.add_plan_to_list(
  from_date date,
  to_date date,
  only_items uuid[] default null
)
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

  -- An explicitly empty selection means "add nothing", which is different from
  -- null meaning "add everything". Ticking every box off and tapping the button
  -- should do nothing rather than everything.
  if only_items is not null and cardinality(only_items) = 0 then
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
  where only_items is null or wanted.catalogue_item_id = any (only_items)
  on conflict (household_id, catalogue_item_id) do nothing;

  get diagnostics added = row_count;

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
    and (only_items is null or di.catalogue_item_id = any (only_items))
  on conflict do nothing;

  return added;
end;
$$;

revoke all on function public.add_plan_to_list(date, date, uuid[]) from public;
grant execute on function public.add_plan_to_list(date, date, uuid[]) to authenticated;
