-- Round 7: the app starts learning. Shops, per-item stats, and the aisle order.
--
-- NIU.md §5 asks for two separate mechanisms, and keeping them separate is the
-- point of this file:
--
--   item_stats        how often and how recently a thing is bought, per
--                     household. Feeds the "you usually need…" strip.
--   item_shop_order   whereabouts in a shop a thing gets ticked off, per shop.
--                     Feeds the order the list is sorted in while shopping.
--
-- They answer different questions and neither should be derived from the other:
-- buying milk every week says nothing about which aisle it is in.
--
-- Both are *statistics, not history* (§5). A handful of numbers per item, no
-- per-purchase rows, nothing to scroll through. That was a deliberate product
-- decision and this schema is what enforces it — there is nowhere here to put a
-- purchase record even if someone wanted one.
--
-- Neither table has an insert or update policy. The only writer is
-- record_shop() below, which is security definer: the numbers are earned, and
-- the app cannot simply assert them. Same pattern as record_catalogue_use() in
-- 0004.
--
-- Run it once in the Supabase dashboard under SQL Editor. Safe to re-run.

-- ---------------------------------------------------------------------------
-- Shops
-- ---------------------------------------------------------------------------
-- "One main shop, others can be added. Each learns its own order" (§4.1). The
-- partial unique index is what makes "main" mean something: a household can have
-- many shops but only ever one default.

create table if not exists public.shops (
  id uuid primary key default gen_random_uuid(),
  household_id uuid not null references public.households (id) on delete cascade,
  name text not null check (char_length(trim(name)) between 1 and 40),
  is_default boolean not null default false,
  created_at timestamptz not null default now(),
  created_by uuid references auth.users (id) on delete set null
);

create unique index if not exists shops_one_default_idx
  on public.shops (household_id)
  where is_default;

create unique index if not exists shops_name_idx
  on public.shops (household_id, lower(trim(name)));

create index if not exists shops_household_idx on public.shops (household_id);

alter table public.shops enable row level security;

drop policy if exists "read your shops" on public.shops;
create policy "read your shops"
  on public.shops for select to authenticated
  using (public.is_household_member(household_id));

drop policy if exists "add a shop" on public.shops;
create policy "add a shop"
  on public.shops for insert to authenticated
  with check (
    public.is_household_member(household_id)
    and created_by = (select auth.uid())
  );

drop policy if exists "change your shops" on public.shops;
create policy "change your shops"
  on public.shops for update to authenticated
  using (public.is_household_member(household_id))
  with check (public.is_household_member(household_id));

drop policy if exists "remove your shops" on public.shops;
create policy "remove your shops"
  on public.shops for delete to authenticated
  using (public.is_household_member(household_id));

-- ---------------------------------------------------------------------------
-- Per-item statistics
-- ---------------------------------------------------------------------------
-- prev_bought_at is kept alongside last_bought_at because "when did we last buy
-- it" and "how long does a pack usually last" are different questions, and the
-- second one needs two dates to answer at all.

create table if not exists public.item_stats (
  household_id uuid not null references public.households (id) on delete cascade,
  catalogue_item_id uuid not null references public.catalogue_items (id) on delete cascade,
  times_bought integer not null default 0,
  last_bought_at timestamptz,
  prev_bought_at timestamptz,
  -- A rolling average, not a true mean: see record_shop() for why.
  avg_gap_days numeric,
  primary key (household_id, catalogue_item_id)
);

alter table public.item_stats enable row level security;

drop policy if exists "read your item stats" on public.item_stats;
create policy "read your item stats"
  on public.item_stats for select to authenticated
  using (public.is_household_member(household_id));

-- ---------------------------------------------------------------------------
-- The learned aisle order
-- ---------------------------------------------------------------------------
-- avg_position is between 0 and 1 — a fraction of the way through a shop rather
-- than a place in a queue. Raw positions can't be averaged across shops of
-- different sizes: third out of five and third out of forty are not the same
-- place in a supermarket.

create table if not exists public.item_shop_order (
  shop_id uuid not null references public.shops (id) on delete cascade,
  catalogue_item_id uuid not null references public.catalogue_items (id) on delete cascade,
  household_id uuid not null references public.households (id) on delete cascade,
  avg_position numeric not null check (avg_position >= 0 and avg_position <= 1),
  samples integer not null default 0,
  updated_at timestamptz not null default now(),
  primary key (shop_id, catalogue_item_id)
);

create index if not exists item_shop_order_household_idx
  on public.item_shop_order (household_id);

alter table public.item_shop_order enable row level security;

drop policy if exists "read your shop order" on public.item_shop_order;
create policy "read your shop order"
  on public.item_shop_order for select to authenticated
  using (public.is_household_member(household_id));

-- ---------------------------------------------------------------------------
-- Every household gets a shop, once
-- ---------------------------------------------------------------------------
-- Same shape as ensure_household() in 0001, and for the same reason: two phones
-- opening the app at the same moment must not produce two "main" shops. The
-- partial unique index is the real guarantee; this just handles the race
-- politely instead of surfacing an error.

create or replace function public.ensure_default_shop()
returns uuid
language plpgsql
security definer
set search_path = public
as $$
declare
  hh uuid;
  sid uuid;
begin
  select household_id into hh
  from public.household_members
  where user_id = auth.uid()
  limit 1;

  if hh is null then
    return null;
  end if;

  select id into sid from public.shops where household_id = hh and is_default limit 1;
  if sid is not null then
    return sid;
  end if;

  insert into public.shops (household_id, name, is_default, created_by)
  values (hh, 'Main shop', true, auth.uid())
  on conflict do nothing
  returning id into sid;

  -- The other phone won the race; take theirs.
  if sid is null then
    select id into sid from public.shops where household_id = hh and is_default limit 1;
  end if;

  return sid;
end;
$$;

revoke all on function public.ensure_default_shop() from public;
grant execute on function public.ensure_default_shop() to authenticated;

-- ---------------------------------------------------------------------------
-- The end of a shop: learn from it, then clear it
-- ---------------------------------------------------------------------------
-- This is the only place the two tables above are written, and it does the
-- learning and the clearing in one transaction so they can never disagree.
--
-- Why the end of the shop rather than each tick: ticking is reversible. You can
-- put something back, and until the trolley is emptied nothing has actually been
-- bought. Emptying the trolley is the moment a shop becomes a fact, and it is
-- also the moment the full tick order is known — which is what the position
-- average needs.
--
-- Two calculations, both deliberately simple arithmetic (§5, "ordinary
-- arithmetic, not AI"):
--
--   position   rank / (total + 1), so a shop of one teaches 0.5 — nothing —
--              rather than claiming that item is at the very front. Averaged
--              into whatever the shop already knew, one sample at a time.
--
--   gap        an exponentially weighted average, not a plain mean: 70% of what
--              we thought, 30% of what just happened. A household's habits drift,
--              and a plain mean over a year of shops would take months to notice.

create or replace function public.record_shop(shop uuid default null)
returns integer
language plpgsql
security definer
set search_path = public
as $$
declare
  hh uuid;
  bought integer;
begin
  if shop is not null then
    select household_id into hh from public.shops where id = shop;
    if hh is null or not public.is_household_member(hh) then
      return 0;
    end if;
  else
    select household_id into hh
    from public.household_members
    where user_id = auth.uid()
    limit 1;

    if hh is null then
      return 0;
    end if;

    select id into shop from public.shops where household_id = hh and is_default limit 1;
  end if;

  create temp table ticked on commit drop as
  select
    li.id,
    li.catalogue_item_id,
    row_number() over (order by li.checked_at, li.id) as rank,
    count(*) over () as total
  from public.list_items li
  where li.household_id = hh and li.checked_at is not null;

  select count(*) into bought from ticked;
  if bought = 0 then
    return 0;
  end if;

  -- Where in the shop each thing was picked up. Skipped when the household has
  -- no shop yet — the stats below are still worth keeping.
  if shop is not null then
    insert into public.item_shop_order
      (shop_id, catalogue_item_id, household_id, avg_position, samples, updated_at)
    select shop, t.catalogue_item_id, hh, t.rank::numeric / (t.total + 1), 1, now()
    from ticked t
    on conflict (shop_id, catalogue_item_id) do update
      set avg_position =
            (item_shop_order.avg_position * item_shop_order.samples + excluded.avg_position)
            / (item_shop_order.samples + 1),
          samples = item_shop_order.samples + 1,
          updated_at = now();
  end if;

  -- How often, how recently, and how long it usually lasts.
  insert into public.item_stats
    (household_id, catalogue_item_id, times_bought, last_bought_at, prev_bought_at, avg_gap_days)
  select hh, t.catalogue_item_id, 1, now(), null, null
  from ticked t
  on conflict (household_id, catalogue_item_id) do update
    set times_bought = item_stats.times_bought + 1,
        prev_bought_at = item_stats.last_bought_at,
        last_bought_at = now(),
        avg_gap_days = case
          when item_stats.last_bought_at is null then null
          when item_stats.avg_gap_days is null then
            extract(epoch from (now() - item_stats.last_bought_at)) / 86400.0
          else
            item_stats.avg_gap_days * 0.7
            + (extract(epoch from (now() - item_stats.last_bought_at)) / 86400.0) * 0.3
        end;

  delete from public.list_items li using ticked t where li.id = t.id;

  drop table ticked;
  return bought;
end;
$$;

revoke all on function public.record_shop(uuid) from public;
grant execute on function public.record_shop(uuid) to authenticated;

-- ---------------------------------------------------------------------------
-- Realtime
-- ---------------------------------------------------------------------------
-- Shops go on the stream so adding one on a phone shows up on the other. The
-- two statistics tables deliberately do not: they change only at the end of a
-- shop, both phones re-read the list at that moment anyway, and a stream of
-- number updates nobody is looking at is pure noise.

do $$
begin
  alter publication supabase_realtime add table public.shops;
exception
  when duplicate_object then null;
  when undefined_object then null;
end
$$;
