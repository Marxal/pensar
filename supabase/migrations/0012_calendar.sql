-- Round 11: the calendar — people, events, reminders, confirmations, and the
-- bookkeeping for the one-way push to Google.
--
-- Four things arrive at once because the calendar cannot be built without the
-- first of them:
--
--   1. **People.** household_members grows a name, a colour and an avatar, and
--      a household grows a join code so a second Google account can actually
--      get in. Round 2 deferred this and nothing since needed it — "who goes"
--      and "send it to her to confirm" both do.
--   2. **Events**, one table covering both an event and a reminder.
--   3. **Attendees and confirmations**, one row per person per event.
--   4. **Sync bookkeeping** — per member, because each member pushes to their
--      own Google calendar. See the long note above event_sync for why.
--
-- Run it once in the Supabase dashboard under SQL Editor. Safe to re-run.

-- ---------------------------------------------------------------------------
-- 1. People
-- ---------------------------------------------------------------------------
-- A member is currently three columns: which household, which auth user, and
-- owner-or-not. That is enough to keep data apart and not enough to draw an
-- avatar beside an event, so here are the four the calendar needs.
--
-- `colour` holds a *name* out of the eight in src/lib/dish-tags.ts, never a
-- value — the same rule dish tags follow, for the same reason: the only place a
-- colour is written down in this project is tokens.css, and the eight are known
-- to clear 4.5:1 in both themes, which a colour picker could not promise.
--
-- `avatar` is one emoji. Not a photo: NIU.md §9 rules photos out of v1, and a
-- household of two does not need face recognition to tell itself apart.
--
-- `email` is a copy of the address the member signed in with, written by the
-- member themselves. auth.users is not readable across accounts, so without
-- this copy the other person shows up as a bare uuid until they choose a name.

alter table public.household_members
  add column if not exists display_name text
    check (display_name is null or char_length(trim(display_name)) between 1 and 40),
  add column if not exists colour text not null default 'sky',
  add column if not exists avatar text
    check (avatar is null or char_length(avatar) between 1 and 8),
  add column if not exists email text,
  -- Which Google calendar this member's phone pushes into. Not a secret — it is
  -- an address, like the email beside it — so it lives here under the ordinary
  -- member read policy rather than in a table only its owner can see. Null
  -- until they connect Google.
  add column if not exists google_calendar_id text;

-- A member may edit their own row and nobody else's. The `using` clause is what
-- stops one member renaming the other; the `with check` is what stops an update
-- moving the row to a different household or a different user.
drop policy if exists "edit your own membership" on public.household_members;
create policy "edit your own membership"
  on public.household_members for update to authenticated
  using (user_id = (select auth.uid()))
  with check (user_id = (select auth.uid()));

do $$
begin
  alter publication supabase_realtime add table public.household_members;
exception
  when duplicate_object then null;
  when undefined_object then null;
end
$$;

-- ---------------------------------------------------------------------------
-- Getting a second person in
-- ---------------------------------------------------------------------------
-- A six-character code, read off one phone and typed into the other. Chosen
-- over an email invite because an email invite needs an email service, and this
-- project has no budget and no server to send from.
--
-- The alphabet leaves out O, I, 0 and 1. A code exists to be read aloud across
-- a kitchen, and those four are where that goes wrong.

alter table public.households
  add column if not exists join_code text;

create unique index if not exists households_join_code_idx
  on public.households (join_code)
  where join_code is not null;

create or replace function public.generate_join_code()
returns text
language plpgsql
set search_path = ''
as $$
declare
  alphabet text := 'ABCDEFGHJKLMNPQRSTUVWXYZ23456789';
  code text;
  i int;
begin
  loop
    code := '';
    for i in 1..6 loop
      code := code || substr(alphabet, 1 + floor(random() * length(alphabet))::int, 1);
    end loop;
    exit when not exists (select 1 from public.households h where h.join_code = code);
  end loop;
  return code;
end;
$$;

-- Hands back your household's code, making one the first time it is asked for.
-- Lazy rather than a default on the column so that households created before
-- this migration get one too, on the first tap, with no backfill.
create or replace function public.household_join_code()
returns text
language plpgsql
security definer
set search_path = ''
as $$
declare
  hid uuid;
  code text;
begin
  select m.household_id into hid
  from public.household_members m
  where m.user_id = (select auth.uid())
  order by m.joined_at
  limit 1;

  if hid is null then
    raise exception 'no household';
  end if;

  select h.join_code into code from public.households h where h.id = hid;

  if code is null then
    code := public.generate_join_code();
    update public.households set join_code = code where id = hid;
  end if;

  return code;
end;
$$;

revoke all on function public.household_join_code() from public;
grant execute on function public.household_join_code() to authenticated;

-- Joins the household holding `code`, leaving whichever one you are in now.
--
-- security definer because the whole point is to insert a row into a household
-- you cannot yet see — there is deliberately no insert policy on
-- household_members, so this function is the only door.
--
-- Two guards, both of them about not losing data by accident:
--
--   * You cannot leave a household that has anyone else in it. Walking out of a
--     shared home should be a deliberate act with a confirmation on it, not a
--     side effect of typing the wrong six characters.
--   * The household you are leaving is deleted only when it is empty *and* has
--     nothing in it. A brand-new account joining its partner is the case this
--     round exists for, and its throwaway household should not linger; a
--     household with a shopping list in it is somebody's real data and stays,
--     unreachable but recoverable by hand.
create or replace function public.join_household(code text)
returns uuid
language plpgsql
security definer
set search_path = ''
as $$
declare
  uid uuid := (select auth.uid());
  target uuid;
  current_id uuid;
  others int;
  has_data boolean;
begin
  if uid is null then
    raise exception 'not authenticated';
  end if;

  select h.id into target
  from public.households h
  where h.join_code = upper(trim(code));

  if target is null then
    raise exception 'no such code';
  end if;

  select m.household_id into current_id
  from public.household_members m
  where m.user_id = uid
  order by m.joined_at
  limit 1;

  if current_id = target then
    return target;
  end if;

  if current_id is not null then
    select count(*) into others
    from public.household_members m
    where m.household_id = current_id and m.user_id <> uid;

    if others > 0 then
      raise exception 'leave your current household first';
    end if;

    delete from public.household_members
    where household_id = current_id and user_id = uid;

    select exists (select 1 from public.list_items l where l.household_id = current_id)
        or exists (select 1 from public.dishes d where d.household_id = current_id)
        or exists (select 1 from public.meal_entries e where e.household_id = current_id)
      into has_data;

    if not has_data then
      delete from public.households where id = current_id;
    end if;
  end if;

  insert into public.household_members (household_id, user_id, role)
  values (target, uid, 'member')
  on conflict do nothing;

  return target;
end;
$$;

revoke all on function public.join_household(text) from public;
grant execute on function public.join_household(text) to authenticated;

-- ---------------------------------------------------------------------------
-- 2. Events
-- ---------------------------------------------------------------------------
-- One table for two things (§4.3, plus Marçal's round 11 ask for "something
-- different and faster than an event"):
--
--   event     the ordinary thing: a title, a day, usually a time, maybe people
--   reminder  "Tuesday, renew the parking permit". Same row, fewer fields
--             filled in, and one extra: it can be ticked off.
--
-- One table rather than two because everything around them is identical — the
-- month grid draws both, the Google push writes both, RLS protects both — and
-- the only difference is which fields the sheet shows and whether there is a
-- checkbox. Two tables would have meant two of every query for one boolean's
-- worth of difference.
--
-- ## Dates are days and times, not timestamps
--
-- `starts_on`/`ends_on` are dates and `start_time`/`end_time` are times, rather
-- than the two timestamptz columns this would normally get. This mirrors the
-- rule src/lib/dates.ts is built on: a day in a family calendar is a day, not
-- an instant. "The 3rd of September" is the 3rd of September whether you read
-- it in Gothenburg or on holiday in Barcelona, and storing it as an instant
-- means it silently becomes the 2nd for anyone an hour west.
--
-- A null `start_time` is what "all day" means. There is no separate all_day
-- boolean, because a boolean and a time can disagree and then something has to
-- decide which one is lying.
--
-- `ends_on` is *inclusive* — a holiday from the 1st to the 7th stores the 7th.
-- Google's API is exclusive at the end for all-day events, and that conversion
-- happens once, in src/lib/google-event.ts, rather than being a thing every
-- query has to remember.

create table if not exists public.events (
  id uuid primary key default gen_random_uuid(),
  household_id uuid not null references public.households (id) on delete cascade,
  kind text not null default 'event' check (kind in ('event', 'reminder')),
  title text not null check (char_length(trim(title)) between 1 and 120),

  starts_on date not null,
  ends_on date not null,
  start_time time,
  end_time time,

  location text check (location is null or char_length(location) <= 200),
  notes text check (notes is null or char_length(notes) <= 2000),
  colour text not null default 'sky',

  -- True once somebody has tapped "Ask her to confirm". The answers live in
  -- event_confirmations; this is only the question having been asked, which is
  -- what the unconfirmed styling keys off before anyone has replied.
  confirm_requested boolean not null default false,

  -- Reminders only. A ticked reminder greys out and drops away; an event has
  -- nothing to tick, so these stay null on one.
  done_at timestamptz,
  done_by uuid references auth.users (id) on delete set null,

  created_by uuid not null references auth.users (id) on delete cascade,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),

  constraint events_ends_after_starts check (ends_on >= starts_on),
  -- An end time with no start time is a shape with no meaning.
  constraint events_end_needs_start check (start_time is not null or end_time is null),
  constraint events_done_only_on_reminders check (kind = 'reminder' or done_at is null)
);

-- The month grid asks one question — "everything this household has between
-- these two days" — and asks it on every swipe. A multi-day event has to come
-- back when the *window* overlaps it, not when its start does, so the index is
-- on the pair.
create index if not exists events_household_span_idx
  on public.events (household_id, starts_on, ends_on);

alter table public.events enable row level security;

drop policy if exists "read your household's events" on public.events;
create policy "read your household's events"
  on public.events for select to authenticated
  using (public.is_household_member(household_id));

drop policy if exists "add events to your household" on public.events;
create policy "add events to your household"
  on public.events for insert to authenticated
  with check (
    public.is_household_member(household_id)
    and created_by = (select auth.uid())
  );

-- Anyone in the household may edit anything in it, including the other
-- person's events. That is the same stance the shopping list and the planner
-- take: this is a shared household, not two accounts with permissions between
-- them, and "she wrote it so you can't fix the time" would be absurd.
drop policy if exists "change your household's events" on public.events;
create policy "change your household's events"
  on public.events for update to authenticated
  using (public.is_household_member(household_id))
  with check (public.is_household_member(household_id));

drop policy if exists "remove your household's events" on public.events;
create policy "remove your household's events"
  on public.events for delete to authenticated
  using (public.is_household_member(household_id));

-- updated_at is not decoration here: it is what the Google push compares
-- against to decide whether its copy is stale (see event_sync). Left to the
-- client it would be forgotten exactly once, and the symptom would be an event
-- that quietly stops syncing.
create or replace function public.touch_event()
returns trigger
language plpgsql
set search_path = ''
as $$
begin
  new.updated_at := now();
  return new;
end;
$$;

drop trigger if exists events_touch on public.events;
create trigger events_touch
  before update on public.events
  for each row execute function public.touch_event();

do $$
begin
  alter publication supabase_realtime add table public.events;
exception
  when duplicate_object then null;
  when undefined_object then null;
end
$$;

-- ---------------------------------------------------------------------------
-- 3. Who goes, and who has said yes
-- ---------------------------------------------------------------------------
-- Two tables rather than one, because they answer different questions and one
-- is not a subset of the other. "Who's going to the dentist" is Maria, alone.
-- "Who has to confirm this is happening" is everyone else in the house. An
-- event can have attendees and never be sent for confirmation, and it can be
-- sent for confirmation without naming anyone as going.
--
-- §4.3: "None selected is fine and means everyone." So an event with no
-- attendee rows is a household event, not an orphan — the app never writes a
-- row per member to mean "all of us".

create table if not exists public.event_attendees (
  event_id uuid not null references public.events (id) on delete cascade,
  user_id uuid not null references auth.users (id) on delete cascade,
  household_id uuid not null references public.households (id) on delete cascade,
  primary key (event_id, user_id)
);

create index if not exists event_attendees_household_idx
  on public.event_attendees (household_id);

alter table public.event_attendees enable row level security;

drop policy if exists "read attendees in your household" on public.event_attendees;
create policy "read attendees in your household"
  on public.event_attendees for select to authenticated
  using (public.is_household_member(household_id));

drop policy if exists "set attendees in your household" on public.event_attendees;
create policy "set attendees in your household"
  on public.event_attendees for insert to authenticated
  with check (public.is_household_member(household_id));

drop policy if exists "clear attendees in your household" on public.event_attendees;
create policy "clear attendees in your household"
  on public.event_attendees for delete to authenticated
  using (public.is_household_member(household_id));

-- One row per person who was asked. `answer` is null until they reply, which is
-- exactly the state the calendar draws as "waiting".
--
-- The row is inserted by whoever asked, and updated by whoever was asked — so
-- the insert policy checks household membership and the update policy checks
-- that you are answering for yourself. Without that second check either of you
-- could confirm on the other's behalf, which would make the whole feature a
-- decoration.
create table if not exists public.event_confirmations (
  event_id uuid not null references public.events (id) on delete cascade,
  user_id uuid not null references auth.users (id) on delete cascade,
  household_id uuid not null references public.households (id) on delete cascade,
  answer text check (answer in ('yes', 'no')),
  answered_at timestamptz,
  asked_at timestamptz not null default now(),
  primary key (event_id, user_id)
);

create index if not exists event_confirmations_waiting_idx
  on public.event_confirmations (household_id, user_id)
  where answer is null;

alter table public.event_confirmations enable row level security;

drop policy if exists "read confirmations in your household" on public.event_confirmations;
create policy "read confirmations in your household"
  on public.event_confirmations for select to authenticated
  using (public.is_household_member(household_id));

drop policy if exists "ask for confirmation in your household" on public.event_confirmations;
create policy "ask for confirmation in your household"
  on public.event_confirmations for insert to authenticated
  with check (public.is_household_member(household_id));

drop policy if exists "answer for yourself" on public.event_confirmations;
create policy "answer for yourself"
  on public.event_confirmations for update to authenticated
  using (user_id = (select auth.uid()))
  with check (user_id = (select auth.uid()));

drop policy if exists "withdraw a request in your household" on public.event_confirmations;
create policy "withdraw a request in your household"
  on public.event_confirmations for delete to authenticated
  using (public.is_household_member(household_id));

do $$
begin
  alter publication supabase_realtime add table public.event_attendees;
exception
  when duplicate_object then null;
  when undefined_object then null;
end
$$;

do $$
begin
  alter publication supabase_realtime add table public.event_confirmations;
exception
  when duplicate_object then null;
  when undefined_object then null;
end
$$;

-- ---------------------------------------------------------------------------
-- 4. What Google has already been told
-- ---------------------------------------------------------------------------
-- ## Why this is per member and not per household
--
-- NIU.md §4.3 imagined one shared Google calendar that both accounts subscribe
-- to. Building it turned up a hard limit and the limit is a better design.
--
-- The scope this app asks Google for is `calendar.app.created`: "make secondary
-- Google calendars, and see, create, change and delete events on them". It is
-- the smallest scope that can do the job, and it means Niu is *incapable* of
-- reading anybody's work meetings — the one-way promise in §4.3 stops being a
-- promise and becomes a fact about the token.
--
-- The price is that the scope covers only calendars this app created *for this
-- user*, and it cannot write sharing rules. So one account cannot be given
-- write access to the other's calendar. Each member therefore gets their own
-- Google calendar named "Niu", and each phone pushes the household's events
-- into its own copy. On the phone the result is identical to the shared
-- calendar §4.3 described; it is only the plumbing that differs.
--
-- ## Why there is no google_event_id column
--
-- Google lets the caller choose an event's id (lowercase a–v and 0–9, 5–1024
-- characters). Our uuids are hex, which is inside that alphabet, so the Google
-- id is *derived* from the Niu id rather than stored: see googleEventId() in
-- src/lib/google-event.ts.
--
-- That is worth more than a saved column. It makes the push idempotent — a
-- retry after a half-failed request re-uses the same id instead of making a
-- second copy of the dinner — and it means a deletion still knows what to
-- delete after the row is gone, which is what makes the tombstone table below
-- three columns instead of a join.

create table if not exists public.event_sync (
  -- Deliberately no foreign key: the row has to outlive the event so that
  -- "this member has removed the Google copy" survives the delete.
  event_id uuid not null,
  user_id uuid not null references auth.users (id) on delete cascade,
  household_id uuid not null references public.households (id) on delete cascade,
  -- The events.updated_at value that was last pushed. A row whose event has a
  -- newer updated_at than this is stale and goes back in the queue.
  pushed_at timestamptz,
  -- Set once the Google copy has been deleted, for a tombstoned event.
  removed_at timestamptz,
  primary key (event_id, user_id)
);

create index if not exists event_sync_member_idx
  on public.event_sync (household_id, user_id);

alter table public.event_sync enable row level security;

-- Only ever your own rows, in both directions. Another member's sync state is
-- none of your business and acting on it would push to their calendar.
drop policy if exists "read your own sync state" on public.event_sync;
create policy "read your own sync state"
  on public.event_sync for select to authenticated
  using (user_id = (select auth.uid()) and public.is_household_member(household_id));

drop policy if exists "record your own sync state" on public.event_sync;
create policy "record your own sync state"
  on public.event_sync for insert to authenticated
  with check (user_id = (select auth.uid()) and public.is_household_member(household_id));

drop policy if exists "update your own sync state" on public.event_sync;
create policy "update your own sync state"
  on public.event_sync for update to authenticated
  using (user_id = (select auth.uid()))
  with check (user_id = (select auth.uid()));

drop policy if exists "clear your own sync state" on public.event_sync;
create policy "clear your own sync state"
  on public.event_sync for delete to authenticated
  using (user_id = (select auth.uid()));

-- A deleted event still has a copy sitting in each member's Google calendar,
-- and the member who did the deleting can only remove their own. So the id is
-- kept until every phone has had a chance to catch up.
--
-- Written by a trigger rather than by the app: an event deleted from the other
-- phone, or by hand in the dashboard, has to leave a tombstone too, and a
-- delete is exactly the moment an app forgets to.
create table if not exists public.event_tombstones (
  event_id uuid primary key,
  household_id uuid not null references public.households (id) on delete cascade,
  deleted_at timestamptz not null default now()
);

create index if not exists event_tombstones_household_idx
  on public.event_tombstones (household_id, deleted_at);

alter table public.event_tombstones enable row level security;

drop policy if exists "read tombstones in your household" on public.event_tombstones;
create policy "read tombstones in your household"
  on public.event_tombstones for select to authenticated
  using (public.is_household_member(household_id));

drop policy if exists "clear tombstones in your household" on public.event_tombstones;
create policy "clear tombstones in your household"
  on public.event_tombstones for delete to authenticated
  using (public.is_household_member(household_id));

create or replace function public.tombstone_event()
returns trigger
language plpgsql
security definer
set search_path = ''
as $$
begin
  insert into public.event_tombstones (event_id, household_id)
  values (old.id, old.household_id)
  on conflict (event_id) do nothing;
  return old;
end;
$$;

drop trigger if exists events_tombstone on public.events;
create trigger events_tombstone
  after delete on public.events
  for each row execute function public.tombstone_event();

do $$
begin
  alter publication supabase_realtime add table public.event_tombstones;
exception
  when duplicate_object then null;
  when undefined_object then null;
end
$$;

-- ---------------------------------------------------------------------------
-- Sending an event for confirmation
-- ---------------------------------------------------------------------------
-- One round trip rather than "read the member list, work out who isn't me,
-- insert a row each", for the same reason add_dish_to_list() is one function:
-- the phone doing this is usually on mobile data, and three round trips is
-- three chances for one of them not to arrive.
--
-- It asks *everyone but you*. Confirming your own event is not a question, and
-- an event that came back already confirmed would train you to ignore the mark.
--
-- Re-runnable: asking twice leaves the existing answers alone, so tapping the
-- button again after changing the time does not wipe a yes she already gave.
-- Changing the time and wanting a fresh answer is unask + ask, which is what
-- the sheet does.

create or replace function public.ask_to_confirm(event uuid)
returns int
language plpgsql
security definer
set search_path = ''
as $$
declare
  uid uuid := (select auth.uid());
  hid uuid;
  asked int;
begin
  select e.household_id into hid
  from public.events e
  where e.id = event and public.is_household_member(e.household_id);

  if hid is null then
    raise exception 'no such event';
  end if;

  insert into public.event_confirmations (event_id, user_id, household_id)
  select event, m.user_id, hid
  from public.household_members m
  where m.household_id = hid and m.user_id <> uid
  on conflict (event_id, user_id) do nothing;

  get diagnostics asked = row_count;

  update public.events
     set confirm_requested = true
   where id = event;

  return asked;
end;
$$;

revoke all on function public.ask_to_confirm(uuid) from public;
grant execute on function public.ask_to_confirm(uuid) to authenticated;
