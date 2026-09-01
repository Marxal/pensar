-- Round 17: push notifications — the confirmation request that reaches the
-- other phone even when nobody has the app open.
--
-- NIU.md §9 deferred this and named the three things it needs: a service worker
-- that handles `push`, a VAPID key pair, and one small Supabase function
-- holding the private key. This migration is the database third of that.
--
-- Three pieces:
--
--   1. **push_subscriptions** — one row per phone that has said yes to
--      notifications. Written by the phone itself, read by the Edge Function.
--   2. **push_config** — where the Edge Function lives and the secret that
--      proves a call to it came from this database. One row, unreadable
--      through the API by anybody.
--   3. **A trigger on event_confirmations** that calls the function. An INSERT
--      there is "she has been asked"; an UPDATE that fills in `answer` is
--      "she has replied". Those are the only two things that buzz a phone
--      (Marçal, round 17) — deliberately not every event anyone adds, which is
--      the fastest way to get notifications switched off altogether.
--
-- Run it once in the Supabase dashboard under SQL Editor. Safe to re-run.
--
-- ## Nothing here breaks if the rest is not set up
--
-- Every step degrades to silence. No push_config row means the trigger returns
-- without calling anything; no subscription rows means the function has nobody
-- to send to; a function that is not deployed yet means a failed HTTP call that
-- pg_net swallows. The calendar behaves exactly as it does today throughout.

-- pg_net is what lets Postgres make an HTTP call at all. Supabase registers it
-- in the `extensions` schema, but its functions live in a schema of their own
-- called `net` — hence net.http_post below.
create extension if not exists pg_net with schema "extensions";

-- ---------------------------------------------------------------------------
-- 1. The phones that have said yes
-- ---------------------------------------------------------------------------
-- A Web Push subscription is three strings the browser hands you: an endpoint
-- URL at the push service (Google's, on Android), and two keys used to encrypt
-- the payload so that push service cannot read it. All three come from the
-- browser and none of them is a credential of ours.
--
-- The endpoint is the primary key because the browser is entitled to replace a
-- subscription at any time, and the same phone re-subscribing must update its
-- row rather than accumulate a second one. Notifications sent twice is the
-- classic symptom of getting this wrong.
--
-- `household_id` is denormalised onto the row on purpose: the Edge Function
-- runs as the service role with no session, so it cannot use auth.uid() to work
-- out who is in which house. It is also what makes the RLS policies below one
-- comparison rather than a join.

create table if not exists public.push_subscriptions (
  endpoint text primary key,
  user_id uuid not null references auth.users (id) on delete cascade,
  household_id uuid not null references public.households (id) on delete cascade,
  -- The subscription's public key and auth secret, base64url, straight from
  -- PushSubscription.getKey(). Meaningless to anyone but the push service.
  p256dh text not null,
  auth text not null,
  -- Which phone this is, roughly, so a person can recognise a stale row. Not
  -- used for anything the code depends on.
  device text,
  created_at timestamptz not null default now(),
  last_seen_at timestamptz not null default now()
);

create index if not exists push_subscriptions_user_idx
  on public.push_subscriptions (user_id);

alter table public.push_subscriptions enable row level security;

-- Your own rows and nobody else's, in all four directions. This is stricter
-- than the household rule the rest of the app uses, and deliberately so: a
-- subscription is the address of a specific phone, and there is no reason for
-- one member to read, move or delete the other's. The Edge Function reaches
-- these rows with the service role, which bypasses all four.

drop policy if exists "read your own subscriptions" on public.push_subscriptions;
create policy "read your own subscriptions"
  on public.push_subscriptions for select to authenticated
  using (user_id = (select auth.uid()));

drop policy if exists "add your own subscription" on public.push_subscriptions;
create policy "add your own subscription"
  on public.push_subscriptions for insert to authenticated
  with check (
    user_id = (select auth.uid())
    and public.is_household_member(household_id)
  );

drop policy if exists "refresh your own subscription" on public.push_subscriptions;
create policy "refresh your own subscription"
  on public.push_subscriptions for update to authenticated
  using (user_id = (select auth.uid()))
  with check (user_id = (select auth.uid()));

drop policy if exists "remove your own subscription" on public.push_subscriptions;
create policy "remove your own subscription"
  on public.push_subscriptions for delete to authenticated
  using (user_id = (select auth.uid()));

-- ---------------------------------------------------------------------------
-- 2. Where to call, and the secret that says it was us
-- ---------------------------------------------------------------------------
-- ## Why this is a table and not a value pasted into the trigger
--
-- The trigger needs two things this repo must not contain: the project's
-- function URL is fine, but the shared secret is not — CLAUDE.md rule 2, and
-- this repo is public. Keeping both in a row means the migration itself can be
-- committed and read by anyone while the secret is only ever typed into the
-- SQL editor.
--
-- ## Why RLS with no policies at all
--
-- Row Level Security with zero policies denies everything. There is no select
-- policy here, so neither `anon` nor `authenticated` can read this row through
-- the API — not even the owner of the household. The only thing that can see it
-- is the security-definer trigger function below, which runs as its creator.
-- That is the whole design: a secret in a table the API cannot read.
--
-- ## Why the shared secret exists at all
--
-- The Edge Function has to be callable without a user session, because the
-- caller is Postgres. Without a secret, anyone who found the function's URL
-- could ask it to send a notification. With one, a forged call is rejected
-- before it does anything — and even if it were not, see the note in the
-- function itself: it re-reads every fact from the database and never trusts a
-- word of the text it was sent.

create table if not exists public.push_config (
  -- The single-row idiom: a primary key that can only ever be true.
  id boolean primary key default true check (id),
  function_url text not null,
  shared_secret text not null
);

alter table public.push_config enable row level security;

-- ---------------------------------------------------------------------------
-- 3. What buzzes a phone
-- ---------------------------------------------------------------------------
-- The two moments, and nothing else:
--
--   ask     a row appears in event_confirmations — somebody has been asked to
--           confirm an event. The person asked is NEW.user_id.
--   answer  an existing row gets an answer. The person told is whoever wrote
--           the event, because they are the one waiting to hear.
--
-- The function sends *identifiers only* — which event, which person, which
-- kind. It never sends the title or the time. The Edge Function looks those up
-- itself, which means a forged call cannot put words on somebody's lock screen;
-- the worst it can do is repeat something already true.
--
-- Failures are invisible on purpose. net.http_post queues the request and
-- returns immediately, so a function that is down, slow or not yet deployed
-- cannot make saving an event fail. A notification that does not arrive is a
-- notification that does not arrive; the event is safely in the database either
-- way, and the in-app badge from round 11 still shows it.

create or replace function public.notify_confirmation()
returns trigger
language plpgsql
security definer
set search_path = ''
as $$
declare
  cfg public.push_config%rowtype;
  recipient uuid;
  kind text;
begin
  select * into cfg from public.push_config where id limit 1;

  -- Not set up yet. Do nothing, quietly.
  if cfg.function_url is null then
    return null;
  end if;

  if tg_op = 'INSERT' then
    kind := 'ask';
    recipient := new.user_id;
  else
    -- Only the moment an answer first appears. An edit that changes nothing,
    -- or the app re-asking after a time change, must not buzz again.
    if new.answer is null or new.answer is not distinct from old.answer then
      return null;
    end if;

    kind := 'answer';
    select e.created_by into recipient
    from public.events e
    where e.id = new.event_id;

    -- Answering your own question is not news.
    if recipient is null or recipient = new.user_id then
      return null;
    end if;
  end if;

  perform net.http_post(
    url := cfg.function_url,
    body := jsonb_build_object(
      'kind', kind,
      'event_id', new.event_id,
      'recipient', recipient,
      'actor', new.user_id
    ),
    headers := jsonb_build_object(
      'Content-Type', 'application/json',
      'x-niu-secret', cfg.shared_secret
    ),
    timeout_milliseconds := 5000
  );

  return null;
end;
$$;

drop trigger if exists event_confirmations_notify_ask on public.event_confirmations;
create trigger event_confirmations_notify_ask
  after insert on public.event_confirmations
  for each row execute function public.notify_confirmation();

drop trigger if exists event_confirmations_notify_answer on public.event_confirmations;
create trigger event_confirmations_notify_answer
  after update of answer on public.event_confirmations
  for each row execute function public.notify_confirmation();
