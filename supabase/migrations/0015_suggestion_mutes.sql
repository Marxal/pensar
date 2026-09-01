-- Round 15: "stop telling me about this."
--
-- One table, and it is the only database change the round needs. Both magic
-- buttons read numbers that already exist — meal_entries for the week, and
-- item_stats for the shop — so the learning needed no schema at all. What it
-- needed was somewhere to record the one thing the app cannot work out on its
-- own: that a household does not want to be asked about something, however
-- regularly they buy it.
--
-- Run it once in the Supabase dashboard under SQL Editor. Safe to re-run.

-- ---------------------------------------------------------------------------
-- Muting a suggestion
-- ---------------------------------------------------------------------------
-- The same shape as catalogue_hidden in 0004, and for the same reasons: most of
-- the catalogue is a shared seed that belongs to no household, so one household
-- deciding it never wants to be reminded about anchovies must not silence them
-- for everybody. The decision is stored beside the item rather than written
-- into it.
--
-- It is deliberately *not* catalogue_hidden. Hiding takes a tile out of the
-- picker entirely — you can no longer add it without typing its name. Muting
-- leaves the tile exactly where it is and only stops the app volunteering it.
-- They are different requests and someone who wanted one would be annoyed to
-- get the other: "I buy milk every week, stop telling me so" must not make milk
-- harder to buy.
--
-- What reads it, both on the shopping tab:
--   the "you usually need…" strip  (suggest.ts)
--   the Fill the list proposal     (list-magic.ts)
--
-- Undoing it is a delete, and the row carries who and when so that a future
-- "things you have muted" screen in Settings has something to list. Nothing
-- reads those two columns yet, and that is fine — they cost nothing and a
-- decision with no record of who made it is one nobody can revisit.

create table if not exists public.suggestion_mutes (
  household_id uuid not null references public.households (id) on delete cascade,
  catalogue_item_id uuid not null references public.catalogue_items (id) on delete cascade,
  muted_at timestamptz not null default now(),
  muted_by uuid references auth.users (id) on delete set null,
  primary key (household_id, catalogue_item_id)
);

create index if not exists suggestion_mutes_household_idx
  on public.suggestion_mutes (household_id);

alter table public.suggestion_mutes enable row level security;

drop policy if exists "read your muted suggestions" on public.suggestion_mutes;
create policy "read your muted suggestions"
  on public.suggestion_mutes for select to authenticated
  using (public.is_household_member(household_id));

drop policy if exists "mute suggestions in your household" on public.suggestion_mutes;
create policy "mute suggestions in your household"
  on public.suggestion_mutes for insert to authenticated
  with check (
    public.is_household_member(household_id)
    and muted_by = (select auth.uid())
  );

drop policy if exists "unmute suggestions in your household" on public.suggestion_mutes;
create policy "unmute suggestions in your household"
  on public.suggestion_mutes for delete to authenticated
  using (public.is_household_member(household_id));

-- ---------------------------------------------------------------------------
-- Realtime
-- ---------------------------------------------------------------------------
-- Same argument as catalogue_hidden: muting is a household decision, and a
-- suggestion one person silenced still sitting on the other person's screen is
-- the two phones disagreeing about something they were told once.

do $$
begin
  alter publication supabase_realtime add table public.suggestion_mutes;
exception
  when duplicate_object then null;
  when undefined_object then null;
end
$$;
