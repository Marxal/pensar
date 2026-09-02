-- pensar: reminder push notifications, fired from the due-date picker cards
-- already have. Reusing the field rather than adding a separate one, per
-- CLAUDE.md — setting a due date *is* setting a reminder.
--
-- Same shape as niu's own push setup (0016_push.sql, mirrored into this repo
-- too): a subscriptions table the phone writes to, a config table holding the
-- Edge Function's URL and a shared secret the API can never read, and
-- pg_net carrying the call from Postgres to the function. The one real
-- difference is *when* the call happens — niu's fires from a trigger on the
-- write that creates the news (an event confirmation appearing or being
-- answered); a reminder has to fire when the *clock* reaches a moment
-- decided long ago, so this is pg_cron polling every five minutes instead of
-- a trigger.
--
-- If `create extension pg_net` fails on permissions, enable it once from the
-- Supabase dashboard (Database > Extensions > pg_net) and re-run
-- `supabase db push` — same as pg_cron's own note in the purge-schedule
-- migration.

create extension if not exists pg_net with schema "extensions";

-- ---------------------------------------------------------------------------
-- 1. When a card should remind, and whether it already has
-- ---------------------------------------------------------------------------
-- `due_time` is what the editor's time input round-trips (HH:MM, local wall
-- clock) — kept only for prefilling that field, nothing here reads it.
--
-- `remind_at` is the timestamptz that actually drives the cron below. The app
-- computes it client-side (due_date + due_time, defaulting to 09:00, read in
-- the *device's* local timezone via plain `new Date(...)`) rather than this
-- migration trying to compute it in Postgres, which has no idea what
-- timezone a bare `YYYY-MM-DD` was meant in — exactly the reasoning behind
-- format.js's own parseDateOnly already doing this client-side. It's null
-- whenever due_date is null: no due date, no reminder.
--
-- `reminder_fired_for` records the `remind_at` value a reminder last actually
-- went out for. Comparing it to `remind_at` (not just checking it's non-null)
-- means moving a due date to a new moment after firing arms it again — set
-- an old date, get reminded, drag it a week later, get reminded again —
-- without any trigger needed to reset anything by hand.

alter table public.pensar_cards
  add column if not exists due_time text,
  add column if not exists remind_at timestamptz,
  add column if not exists reminder_fired_for timestamptz;

create index if not exists pensar_cards_remind_at_idx
  on public.pensar_cards (remind_at)
  where remind_at is not null;

-- ---------------------------------------------------------------------------
-- 2. The phones that have said yes
-- ---------------------------------------------------------------------------
-- Own table rather than reusing niu's push_subscriptions: that one is keyed
-- to a household, which pensar (single user, CLAUDE.md) has no notion of, and
-- the two apps' subscriptions shouldn't be tangled together regardless — a
-- phone subscribed to niu's confirmations isn't necessarily one that wants
-- pensar's reminders. Same shape otherwise, endpoint as the primary key so a
-- browser re-subscribing updates its row instead of piling up a second one.

create table if not exists public.pensar_push_subscriptions (
  endpoint text primary key,
  user_id uuid not null default auth.uid() references auth.users (id) on delete cascade,
  p256dh text not null,
  auth text not null,
  device text,
  created_at timestamptz not null default now(),
  last_seen_at timestamptz not null default now()
);

create index if not exists pensar_push_subscriptions_user_idx
  on public.pensar_push_subscriptions (user_id);

alter table public.pensar_push_subscriptions enable row level security;

drop policy if exists "read own pensar push subscriptions" on public.pensar_push_subscriptions;
create policy "read own pensar push subscriptions"
  on public.pensar_push_subscriptions for select to authenticated
  using (user_id = (select auth.uid()));

drop policy if exists "add own pensar push subscription" on public.pensar_push_subscriptions;
create policy "add own pensar push subscription"
  on public.pensar_push_subscriptions for insert to authenticated
  with check (user_id = (select auth.uid()));

drop policy if exists "refresh own pensar push subscription" on public.pensar_push_subscriptions;
create policy "refresh own pensar push subscription"
  on public.pensar_push_subscriptions for update to authenticated
  using (user_id = (select auth.uid()))
  with check (user_id = (select auth.uid()));

drop policy if exists "remove own pensar push subscription" on public.pensar_push_subscriptions;
create policy "remove own pensar push subscription"
  on public.pensar_push_subscriptions for delete to authenticated
  using (user_id = (select auth.uid()));

-- ---------------------------------------------------------------------------
-- 3. Where to call, and the secret that says it was us
-- ---------------------------------------------------------------------------
-- Same reasoning as niu's push_config: the Edge Function URL is fine to have
-- in a committed migration, the shared secret is not, so it's typed into the
-- SQL editor by hand afterwards, into a table RLS makes unreadable through
-- the API (zero policies denies everything, including to the owner).

create table if not exists public.pensar_push_config (
  id boolean primary key default true check (id),
  function_url text not null,
  shared_secret text not null
);

alter table public.pensar_push_config enable row level security;

-- ---------------------------------------------------------------------------
-- 4. The five-minute sweep
-- ---------------------------------------------------------------------------
-- Only identifiers cross the wire here, same as niu's trigger: which card,
-- which user. The Edge Function re-reads the card itself with the service
-- role before putting anything on a lock screen, so a forged call to it
-- can't say anything that isn't already true and already in the database.
--
-- The update that stamps reminder_fired_for runs right after queuing the
-- notify — net.http_post queues and returns immediately, so this doesn't
-- wait to hear whether delivery actually succeeded. That's the same
-- "failures are invisible" tradeoff niu made: a reminder that doesn't arrive
-- doesn't get retried, but it also can't make anything else fail, and the
-- due date is exactly as visible in the app either way.

create or replace function public.pensar_send_due_reminders()
returns void
language plpgsql
security definer
set search_path = ''
as $$
declare
  cfg public.pensar_push_config%rowtype;
  due jsonb;
begin
  select * into cfg from public.pensar_push_config where id limit 1;
  if cfg.function_url is null then
    return;
  end if;

  select coalesce(jsonb_agg(jsonb_build_object('id', c.id, 'user_id', c.user_id)), '[]'::jsonb)
  into due
  from public.pensar_cards c
  where c.remind_at is not null
    and c.remind_at <= now()
    and (c.reminder_fired_for is null or c.reminder_fired_for <> c.remind_at)
    and c.done = false
    and c.archived_at is null
    and c.deleted_at is null;

  if jsonb_array_length(due) = 0 then
    return;
  end if;

  perform net.http_post(
    url := cfg.function_url,
    body := jsonb_build_object('cards', due),
    headers := jsonb_build_object(
      'Content-Type', 'application/json',
      'x-pensar-secret', cfg.shared_secret
    ),
    timeout_milliseconds := 8000
  );

  update public.pensar_cards c
  set reminder_fired_for = c.remind_at
  where c.remind_at is not null
    and c.remind_at <= now()
    and (c.reminder_fired_for is null or c.reminder_fired_for <> c.remind_at)
    and c.done = false
    and c.archived_at is null
    and c.deleted_at is null;
end;
$$;

revoke all on function public.pensar_send_due_reminders() from public;

select cron.unschedule(jobid) from cron.job where jobname = 'pensar_send_due_reminders';

select cron.schedule(
  'pensar_send_due_reminders',
  '*/5 * * * *',
  $$select public.pensar_send_due_reminders()$$
);

-- Setup that still has to happen by hand, same as niu's own push rollout
-- (niu/docs/SUPABASE_SETUP.md §"Push notifications"):
--
--   1. Generate a VAPID key pair, once, from the pensar repo:
--      `node scripts/generate-vapid-keys.cjs`
--      writes `vapid-keys.local` (never committed — `.local` is in
--      .gitignore) and prints the public half, which goes into `.env` as
--      `VITE_VAPID_PUBLIC_KEY` (already done for the pair this round
--      generated — see that file).
--
--   2. Deploy the function: from a real terminal,
--      `supabase functions deploy pensar-send-reminder --no-verify-jwt`
--      (--no-verify-jwt for the same CORS-preflight reason as
--      pensar-link-preview — see that function's own header comment).
--
--   3. Set its secrets:
--      `supabase secrets set PENSAR_VAPID_KEYS="$(cat vapid-keys.local)" PENSAR_PUSH_SECRET=<a long random string> PENSAR_CONTACT_EMAIL=<your email>`
--
--   4. In the SQL editor, one row telling Postgres where to call and proving
--      it's really this database calling:
--      insert into public.pensar_push_config (id, function_url, shared_secret)
--      values (true, 'https://<project-ref>.supabase.co/functions/v1/pensar-send-reminder', '<same secret as PENSAR_PUSH_SECRET>')
--      on conflict (id) do update set function_url = excluded.function_url, shared_secret = excluded.shared_secret;
--
-- Until all four are done, `pensar_send_due_reminders` finds no
-- function_url and returns without doing anything — due dates and the rest
-- of the app behave exactly as they do today.
