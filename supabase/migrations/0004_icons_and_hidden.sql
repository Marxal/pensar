-- Round 4: line-art icons, a suggested order, and hiding tiles for good.
--
-- Three changes, all additive — nothing here drops or rewrites existing data:
--
--   1. catalogue_items.suggested_rank, so the catalogue can open on "typical
--      stuff everyone buys" before the app has learned a real order.
--   2. catalogue_hidden, so a household can remove a tile from their own
--      catalogue permanently.
--   3. catalogue_items goes on the realtime stream, so a word one phone invents
--      appears on the other without a reload.
--
-- The icon column itself doesn't change shape: it held an emoji, it now holds a
-- slug naming a line drawing (see src/lib/icons.ts). Re-running
-- 0003_catalogue_seed.sql swaps the values over — it updates on conflict.
--
-- Run in the Supabase SQL Editor. Safe to run twice.

-- ---------------------------------------------------------------------------
-- Suggested order
-- ---------------------------------------------------------------------------
-- Null for most items. Only the ~20 things nearly every household buys carry a
-- rank, and they are what the catalogue shows first on a brand-new account.
-- This is the placeholder the learned order eventually replaces.

alter table public.catalogue_items
  add column if not exists suggested_rank integer;

-- ---------------------------------------------------------------------------
-- Hidden tiles
-- ---------------------------------------------------------------------------
-- "Remove forever" is a hide, not a delete, and deliberately so. Most of the
-- catalogue is the shared seed owned by nobody — one household deleting
-- 'anchovies' must not remove it for everyone else, and RLS on catalogue_items
-- rightly forbids that. A per-household row here is the only thing that can
-- express "gone, for us". It also means nothing is destroyed: unhiding later is
-- a delete from this table, with the item's history intact.

create table if not exists public.catalogue_hidden (
  household_id uuid not null references public.households (id) on delete cascade,
  catalogue_item_id uuid not null references public.catalogue_items (id) on delete cascade,
  hidden_at timestamptz not null default now(),
  hidden_by uuid references auth.users (id) on delete set null,
  primary key (household_id, catalogue_item_id)
);

create index if not exists catalogue_hidden_household_idx
  on public.catalogue_hidden (household_id);

alter table public.catalogue_hidden enable row level security;

drop policy if exists "read your hidden tiles" on public.catalogue_hidden;
create policy "read your hidden tiles"
  on public.catalogue_hidden for select to authenticated
  using (public.is_household_member(household_id));

drop policy if exists "hide tiles in your household" on public.catalogue_hidden;
create policy "hide tiles in your household"
  on public.catalogue_hidden for insert to authenticated
  with check (
    public.is_household_member(household_id)
    and hidden_by = (select auth.uid())
  );

drop policy if exists "unhide tiles in your household" on public.catalogue_hidden;
create policy "unhide tiles in your household"
  on public.catalogue_hidden for delete to authenticated
  using (public.is_household_member(household_id));

-- ---------------------------------------------------------------------------
-- Usage, per household
-- ---------------------------------------------------------------------------
-- The first real piece of the learned ordering NIU.md §4.1 asks for. Every time
-- a tile goes on the list this counter goes up, and the picker's top row is
-- ordered by it — so the row is the hand-picked "typical stuff" on day one and
-- becomes this household's own habits within a few shops.
--
-- Per household, not global: what the two of you buy should not be nudged by
-- what anyone else buys. It also cannot live as a column on catalogue_items,
-- because most of those rows are the shared seed that no household may write to.

create table if not exists public.catalogue_usage (
  household_id uuid not null references public.households (id) on delete cascade,
  catalogue_item_id uuid not null references public.catalogue_items (id) on delete cascade,
  use_count integer not null default 0,
  last_used_at timestamptz not null default now(),
  primary key (household_id, catalogue_item_id)
);

alter table public.catalogue_usage enable row level security;

drop policy if exists "read your usage" on public.catalogue_usage;
create policy "read your usage"
  on public.catalogue_usage for select to authenticated
  using (public.is_household_member(household_id));

-- No insert or update policy on purpose. Counting is done by the function
-- below, which is the only writer — that keeps the count from being set to an
-- arbitrary number from the client and keeps the increment atomic.

create or replace function public.record_catalogue_use(item_id uuid)
returns void
language plpgsql
security definer
set search_path = ''
as $$
declare
  hid uuid;
begin
  select m.household_id into hid
  from public.household_members m
  where m.user_id = (select auth.uid())
  order by m.joined_at
  limit 1;

  if hid is null then
    raise exception 'not in a household';
  end if;

  insert into public.catalogue_usage (household_id, catalogue_item_id, use_count, last_used_at)
  values (hid, item_id, 1, now())
  on conflict (household_id, catalogue_item_id) do update
    set use_count = public.catalogue_usage.use_count + 1,
        last_used_at = now();
end;
$$;

revoke all on function public.record_catalogue_use(uuid) from public;
grant execute on function public.record_catalogue_use(uuid) to authenticated;

-- ---------------------------------------------------------------------------
-- Realtime for invented words
-- ---------------------------------------------------------------------------
-- list_items was added in 0002. This adds the catalogue so that a word typed on
-- one phone shows up on the other — without it the tile would arrive on the
-- list with no name to render.

do $$
begin
  alter publication supabase_realtime add table public.catalogue_items;
exception
  when duplicate_object then null;
  when undefined_object then null;
end
$$;

do $$
begin
  alter publication supabase_realtime add table public.catalogue_hidden;
exception
  when duplicate_object then null;
  when undefined_object then null;
end
$$;
