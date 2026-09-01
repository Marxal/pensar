-- Round 9: meal parts become tags, and the list remembers which dish put a
-- thing on it.
--
-- Three tables, and they answer three different questions:
--
--   dish_tags          the household's own list of "part of a meal" labels,
--                      each with a colour. Seeded with three, then theirs.
--   dish_tag_links     which of those a dish carries. Many, not one.
--   list_item_dishes   which dish (or dishes) put a thing on the shopping list.
--
-- Why the first two exist at all: 0008 stored one `slot` per dish out of a
-- fixed four. Both halves of that turned out to be wrong. A dish is often two
-- things at once — a lasagne is protein *and* carbs — and the fourth value,
-- "other", was a shrug rather than an answer. So it becomes a set of tags the
-- household writes itself, and "other" becomes the button that writes one.
--
-- dishes.slot is left in place, holding whatever it held. It is backfilled into
-- tags below and then never read or written again. Dropping a column is the one
-- change that cannot be undone by re-running a migration, and the same call was
-- made for list_items.unit in round 6.
--
-- Run it once in the Supabase dashboard under SQL Editor. Safe to re-run.

-- ---------------------------------------------------------------------------
-- The tags
-- ---------------------------------------------------------------------------
-- The colour is a *name*, not a hex value, and the check constraint is what
-- keeps it that way. The app resolves each name to a pair of tokens in
-- src/styles/tokens.css, which is the only place in this project a colour is
-- allowed to be written down — so a household picks from eight swatches that
-- are known to work in both themes rather than from a colour wheel that can
-- produce white-on-yellow. Adding a ninth is one line here and two there.

create table if not exists public.dish_tags (
  id uuid primary key default gen_random_uuid(),
  household_id uuid not null references public.households (id) on delete cascade,
  name text not null check (char_length(trim(name)) between 1 and 24),
  colour text not null default 'stone'
    check (colour in ('clay', 'rose', 'amber', 'moss', 'sage', 'sky', 'plum', 'stone')),
  -- Fixes the order the chips appear in, so they don't reshuffle alphabetically
  -- when one is renamed.
  position integer not null default 0,
  created_at timestamptz not null default now(),
  created_by uuid references auth.users (id) on delete set null
);

create unique index if not exists dish_tags_household_name_idx
  on public.dish_tags (household_id, lower(trim(name)));

create index if not exists dish_tags_household_idx on public.dish_tags (household_id);

-- ---------------------------------------------------------------------------
-- Which tags a dish carries
-- ---------------------------------------------------------------------------
-- Same shape as dish_items in 0008, and for the same reasons: household_id is
-- carried rather than joined back to, and the primary key is what stops the
-- editor's diff writing the same link twice.

create table if not exists public.dish_tag_links (
  dish_id uuid not null references public.dishes (id) on delete cascade,
  tag_id uuid not null references public.dish_tags (id) on delete cascade,
  household_id uuid not null references public.households (id) on delete cascade,
  primary key (dish_id, tag_id)
);

create index if not exists dish_tag_links_household_idx
  on public.dish_tag_links (household_id);

-- ---------------------------------------------------------------------------
-- Which dish put this on the list
-- ---------------------------------------------------------------------------
-- "When ingredients are entered via a dish, add a small tag saying which dish
-- it belongs to. If several dishes share an ingredient, add both."
--
-- Hence a join table rather than a column: one list row can be owed to two
-- dishes at once, and the tomatoes you already had before tapping Lasagne are
-- the same tomatoes the lasagne needs.
--
-- Nothing here is ever cleaned up by hand. Both foreign keys cascade, so a
-- deleted dish takes its tags off the list, and a list row that gets ticked off
-- and shopped — record_shop() deletes it — takes its tags with it. The tags
-- last exactly as long as the reason for them does.

create table if not exists public.list_item_dishes (
  list_item_id uuid not null references public.list_items (id) on delete cascade,
  dish_id uuid not null references public.dishes (id) on delete cascade,
  household_id uuid not null references public.households (id) on delete cascade,
  added_at timestamptz not null default now(),
  primary key (list_item_id, dish_id)
);

create index if not exists list_item_dishes_household_idx
  on public.list_item_dishes (household_id);

alter table public.dish_tags enable row level security;
alter table public.dish_tag_links enable row level security;
alter table public.list_item_dishes enable row level security;

-- ---------------------------------------------------------------------------
-- Policies
-- ---------------------------------------------------------------------------
-- Same posture as everything else a household owns outright: either of you can
-- read, write and throw away any of it.

drop policy if exists "read your dish tags" on public.dish_tags;
create policy "read your dish tags"
  on public.dish_tags for select to authenticated
  using (public.is_household_member(household_id));

drop policy if exists "add a dish tag" on public.dish_tags;
create policy "add a dish tag"
  on public.dish_tags for insert to authenticated
  with check (
    public.is_household_member(household_id)
    and created_by = (select auth.uid())
  );

drop policy if exists "change your dish tags" on public.dish_tags;
create policy "change your dish tags"
  on public.dish_tags for update to authenticated
  using (public.is_household_member(household_id))
  with check (public.is_household_member(household_id));

drop policy if exists "remove your dish tags" on public.dish_tags;
create policy "remove your dish tags"
  on public.dish_tags for delete to authenticated
  using (public.is_household_member(household_id));

drop policy if exists "read your dish tag links" on public.dish_tag_links;
create policy "read your dish tag links"
  on public.dish_tag_links for select to authenticated
  using (public.is_household_member(household_id));

-- Both ends must belong to the household on the row, not just the row itself.
-- Without those two clauses a member could staple their own tag onto another
-- household's dish by passing its id alongside their own household_id.
drop policy if exists "link your dish tags" on public.dish_tag_links;
create policy "link your dish tags"
  on public.dish_tag_links for insert to authenticated
  with check (
    public.is_household_member(household_id)
    and exists (
      select 1 from public.dishes d
      where d.id = dish_id and d.household_id = dish_tag_links.household_id
    )
    and exists (
      select 1 from public.dish_tags t
      where t.id = tag_id and t.household_id = dish_tag_links.household_id
    )
  );

drop policy if exists "unlink your dish tags" on public.dish_tag_links;
create policy "unlink your dish tags"
  on public.dish_tag_links for delete to authenticated
  using (public.is_household_member(household_id));

drop policy if exists "read your list item dishes" on public.list_item_dishes;
create policy "read your list item dishes"
  on public.list_item_dishes for select to authenticated
  using (public.is_household_member(household_id));

-- Deliberately no insert policy. The only writer is add_dish_to_list() below —
-- same reasoning as the statistics tables in 0007. A tag saying "the lasagne
-- needs this" is a record of something that happened, and it has to match the
-- dish's actual ingredient list; it is not a label anyone should be able to
-- staple on by hand.
--
-- Deleting one *is* allowed. A tag that turned out to be wrong, or a dish you
-- changed your mind about mid-shop, is the user's business to remove.
drop policy if exists "untag your list items" on public.list_item_dishes;
create policy "untag your list items"
  on public.list_item_dishes for delete to authenticated
  using (public.is_household_member(household_id));

-- ---------------------------------------------------------------------------
-- Every household gets the three tags, once
-- ---------------------------------------------------------------------------
-- Same shape as ensure_default_shop() in 0007. The three are a starting point,
-- not a fixed set: rename them, recolour them, delete them, add your own.

create or replace function public.seed_dish_tags(hid uuid)
returns void
language plpgsql
security definer
set search_path = ''
as $$
begin
  insert into public.dish_tags (household_id, name, colour, position)
  values
    (hid, 'Protein', 'clay', 0),
    (hid, 'Carbs', 'amber', 1),
    (hid, 'Vegetables', 'moss', 2)
  on conflict do nothing;
end;
$$;

revoke all on function public.seed_dish_tags(uuid) from public;

create or replace function public.ensure_dish_tags()
returns void
language plpgsql
security definer
set search_path = ''
as $$
declare
  hh uuid;
begin
  select m.household_id into hh
  from public.household_members m
  where m.user_id = (select auth.uid())
  order by m.joined_at
  limit 1;

  if hh is null then
    return;
  end if;

  -- Only ever seeds an empty list. A household that deleted all three on
  -- purpose should not find them back on the next load.
  if exists (select 1 from public.dish_tags where household_id = hh) then
    return;
  end if;

  perform public.seed_dish_tags(hh);
end;
$$;

revoke all on function public.ensure_dish_tags() from public;
grant execute on function public.ensure_dish_tags() to authenticated;

-- ---------------------------------------------------------------------------
-- Carrying the old slot over
-- ---------------------------------------------------------------------------
-- Runs as the migration's owner, so it covers every household at once rather
-- than waiting for each to open the app. Anything that was 'other' gets no tag,
-- which is right: 'other' never meant anything.
--
-- Both statements are written so a second run changes nothing: the seed is
-- on-conflict-do-nothing, and the link insert skips what is already linked.

do $$
declare
  h record;
begin
  for h in select id from public.households loop
    if not exists (select 1 from public.dish_tags where household_id = h.id) then
      perform public.seed_dish_tags(h.id);
    end if;
  end loop;
end
$$;

insert into public.dish_tag_links (dish_id, tag_id, household_id)
select d.id, t.id, d.household_id
from public.dishes d
join public.dish_tags t
  on t.household_id = d.household_id
 and lower(t.name) = case d.slot
       when 'protein' then 'protein'
       when 'carbs' then 'carbs'
       when 'vegetables' then 'vegetables'
     end
where d.slot in ('protein', 'carbs', 'vegetables')
on conflict do nothing;

-- ---------------------------------------------------------------------------
-- Tapping a dish now also says so
-- ---------------------------------------------------------------------------
-- Replaces the version in 0008. The insert is unchanged; what is new is the
-- second statement, which tags *every* ingredient of the dish that is on the
-- list — not only the ones this tap added.
--
-- That distinction is the whole feature. Tapping Lasagne when the tomatoes are
-- already on the list adds nothing and must still record that the lasagne wants
-- them, or the tomatoes look like nobody's and get bought as one.
--
-- It also has to become `security definer`, which the 0008 version deliberately
-- was not. list_item_dishes has no insert policy on purpose — so with RLS
-- applying to the function's own writes, the one thing allowed to write that
-- table could not write it either. Escalating means the household check that
-- came free from RLS has to be made by hand, which is the `is_household_member`
-- line below; same shape as record_shop() in 0007, and the reason that one is
-- written the way it is.

create or replace function public.add_dish_to_list(dish uuid)
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

  -- RLS is off inside a definer function, so this lookup can see every
  -- household's dishes. The membership test is what puts the wall back.
  select d.household_id into hh from public.dishes d where d.id = dish;
  if hh is null or not public.is_household_member(hh) then
    return 0;
  end if;

  insert into public.list_items (household_id, catalogue_item_id, added_by)
  select hh, di.catalogue_item_id, uid
  from public.dish_items di
  where di.dish_id = dish
  on conflict (household_id, catalogue_item_id) do nothing;

  get diagnostics added = row_count;

  insert into public.list_item_dishes (list_item_id, dish_id, household_id)
  select li.id, dish, hh
  from public.dish_items di
  join public.list_items li
    on li.household_id = hh
   and li.catalogue_item_id = di.catalogue_item_id
  where di.dish_id = dish
  on conflict do nothing;

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
-- All three go on the stream. A tag written on one phone has to reach the
-- other's chips, and a dish tapped on one phone has to put its tags on the
-- other's list — the list rows themselves already arrive that way, and a row
-- without its tag would read as "nobody asked for this".

do $$
begin
  alter publication supabase_realtime add table public.dish_tags;
exception
  when duplicate_object then null;
  when undefined_object then null;
end
$$;

do $$
begin
  alter publication supabase_realtime add table public.dish_tag_links;
exception
  when duplicate_object then null;
  when undefined_object then null;
end
$$;

do $$
begin
  alter publication supabase_realtime add table public.list_item_dishes;
exception
  when duplicate_object then null;
  when undefined_object then null;
end
$$;
