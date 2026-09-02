-- Round 20.1: a push reminder on an event, three offsets to choose from — on
-- time, 15 minutes before, the day before. NIU.md's own reasoning for
-- deferring push ("Google's own reminders cover an event's alarm") assumed
-- Google Calendar syncing was switched on; Marçal wants one that fires
-- regardless, straight from Niu, for everyone in the household.
--
-- Same shape as round 17's confirmation push (0016_push.sql) and pensar's own
-- due-date reminders (20260902140000_pensar_reminders.sql, mirrored into this
-- repo) — read that migration's header for the fuller reasoning, since this
-- one only notes where it differs:
--
--   - the clock, not a write, is what has to trigger this, so it is pg_cron
--     polling every five minutes rather than a trigger on an insert/update;
--   - it goes to the whole household's subscribed phones, not one recipient —
--     "connected users" (Marçal) — so push_subscriptions is queried by
--     household_id, which round 17 already denormalised onto that table for
--     exactly this kind of query;
--   - it reuses round 17's own push_subscriptions/push_config/niu-push rather
--     than standing up a parallel set, since this is the same household and
--     the same Edge Function can hold both jobs.
--
-- `remind_at` is computed client-side, in src/lib/dates.ts's localInstant —
-- see its own header for why: a day and a wall-clock time is not an instant
-- until *something* decides whose timezone "9am" means, and that has to be
-- the device, not Postgres. `reminder_fired_for` is the same re-arming trick
-- as pensar's due reminders: comparing it to remind_at, rather than only
-- checking it is non-null, means moving an event to a new day re-arms the
-- reminder for free, with no trigger needed to reset anything by hand.
--
-- Nothing here breaks if a step is missing — see 0016_push.sql's own note.
-- push_config already has to be set up for round 17's confirmations to work,
-- so a household that already has those working needs nothing further here
-- but this migration and a deploy of the updated niu-push function.

create extension if not exists pg_cron;
create extension if not exists pg_net with schema "extensions";

alter table public.events
  add column if not exists remind_offset text
    check (remind_offset is null or remind_offset in ('on_time', '15_before', 'day_before')),
  add column if not exists remind_at timestamptz,
  add column if not exists reminder_fired_for timestamptz;

create index if not exists events_remind_at_idx
  on public.events (remind_at)
  where remind_at is not null;

create or replace function public.send_event_reminders()
returns void
language plpgsql
security definer
set search_path = ''
as $$
declare
  cfg public.push_config%rowtype;
  due record;
begin
  select * into cfg from public.push_config where id limit 1;
  if cfg.function_url is null then
    return;
  end if;

  for due in
    select e.id, e.household_id
    from public.events e
    where e.remind_at is not null
      and e.remind_at <= now()
      and (e.reminder_fired_for is null or e.reminder_fired_for <> e.remind_at)
  loop
    perform net.http_post(
      url := cfg.function_url,
      body := jsonb_build_object(
        'kind', 'remind',
        'event_id', due.id,
        'household_id', due.household_id
      ),
      headers := jsonb_build_object(
        'Content-Type', 'application/json',
        'x-niu-secret', cfg.shared_secret
      ),
      timeout_milliseconds := 5000
    );

    update public.events
    set reminder_fired_for = remind_at
    where id = due.id;
  end loop;
end;
$$;

revoke all on function public.send_event_reminders() from public;

select cron.unschedule(jobid) from cron.job where jobname = 'send_event_reminders';

select cron.schedule(
  'send_event_reminders',
  '*/5 * * * *',
  $$select public.send_event_reminders()$$
);
