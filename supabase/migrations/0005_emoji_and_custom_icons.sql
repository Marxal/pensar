-- Round 5: an emoji alternative, and letting a household pick its own icons.
--
-- Two additions, both additive:
--
--   1. catalogue_items.emoji — the emoji each item used to carry, kept so the
--      app can offer a "Colour" icon style alongside the line drawings. Only
--      about a third of items have one; the app falls back to the line icon.
--   2. catalogue_icons — a per-household override, so long-pressing a tile and
--      picking a different icon sticks.
--
-- Run in the Supabase SQL Editor, then re-run 0003_catalogue_seed.sql to fill
-- in the emoji column. Safe to run twice.

alter table public.catalogue_items
  add column if not exists emoji text;

-- ---------------------------------------------------------------------------
-- Per-household icon overrides
-- ---------------------------------------------------------------------------
-- Same reasoning as catalogue_hidden in 0004: most of the catalogue is the
-- shared seed that belongs to no household, so a household cannot edit those
-- rows and must not be able to — changing the icon for 'anchovies' should not
-- change it for everyone. A row here means "for us, this item looks like that".
--
-- The value is a slug from src/lib/icons.ts. It is not constrained to a list
-- here because the icon set lives in the app and grows there; an unknown slug
-- simply falls back to the item's initial, which is a safe way to be wrong.

create table if not exists public.catalogue_icons (
  household_id uuid not null references public.households (id) on delete cascade,
  catalogue_item_id uuid not null references public.catalogue_items (id) on delete cascade,
  icon text not null check (char_length(trim(icon)) between 1 and 40),
  set_at timestamptz not null default now(),
  set_by uuid references auth.users (id) on delete set null,
  primary key (household_id, catalogue_item_id)
);

create index if not exists catalogue_icons_household_idx
  on public.catalogue_icons (household_id);

alter table public.catalogue_icons enable row level security;

drop policy if exists "read your icon choices" on public.catalogue_icons;
create policy "read your icon choices"
  on public.catalogue_icons for select to authenticated
  using (public.is_household_member(household_id));

drop policy if exists "set icons in your household" on public.catalogue_icons;
create policy "set icons in your household"
  on public.catalogue_icons for insert to authenticated
  with check (
    public.is_household_member(household_id)
    and set_by = (select auth.uid())
  );

drop policy if exists "change icons in your household" on public.catalogue_icons;
create policy "change icons in your household"
  on public.catalogue_icons for update to authenticated
  using (public.is_household_member(household_id))
  with check (public.is_household_member(household_id));

drop policy if exists "clear icons in your household" on public.catalogue_icons;
create policy "clear icons in your household"
  on public.catalogue_icons for delete to authenticated
  using (public.is_household_member(household_id));

do $$
begin
  alter publication supabase_realtime add table public.catalogue_icons;
exception
  when duplicate_object then null;
  when undefined_object then null;
end
$$;
