-- pensar: permanently purge old archived/trashed cards and boards on a
-- schedule, via pg_cron. Two windows, per pensar-build-plan.md:
--   - archived_at older than 90 days  -> gone for good
--   - deleted_at (trash) older than 30 days -> gone for good
--
-- If this migration fails on `create extension pg_cron` with a permission
-- error, enable it once from the Supabase dashboard (Database > Extensions >
-- pg_cron), then re-run `supabase db push`.

create extension if not exists pg_cron;

create or replace function public.pensar_purge_expired()
returns void
language sql
security definer
set search_path = ''
as $$
  delete from public.pensar_cards
  where (archived_at is not null and archived_at < now() - interval '90 days')
     or (deleted_at is not null and deleted_at < now() - interval '30 days');

  delete from public.pensar_boards
  where (archived_at is not null and archived_at < now() - interval '90 days')
     or (deleted_at is not null and deleted_at < now() - interval '30 days');
$$;

revoke all on function public.pensar_purge_expired() from public;

-- Idempotent: re-running this migration (or `db push` again) shouldn't leave
-- two jobs behind.
select cron.unschedule(jobid) from cron.job where jobname = 'pensar_purge_expired';

select cron.schedule(
  'pensar_purge_expired',
  '0 4 * * *', -- daily at 04:00 UTC
  $$select public.pensar_purge_expired()$$
);

-- Inspecting/adjusting the schedule (run these from the Supabase SQL editor —
-- read-only queries and job scheduling aren't a "schema change", so they're
-- fine there, unlike table/column edits which still go through a migration):
--
--   -- see the job and its cadence
--   select jobid, jobname, schedule, active from cron.job where jobname = 'pensar_purge_expired';
--
--   -- see recent runs (success/failure, timing)
--   select * from cron.job_run_details
--   where jobid = (select jobid from cron.job where jobname = 'pensar_purge_expired')
--   order by start_time desc limit 20;
--
--   -- pause or resume without dropping it
--   select cron.alter_job((select jobid from cron.job where jobname = 'pensar_purge_expired'), active => false);
--
--   -- change the time/cadence on the fly
--   select cron.alter_job((select jobid from cron.job where jobname = 'pensar_purge_expired'), schedule => '0 6 * * *');
--
-- Changing the 90/30 day windows themselves means editing the
-- pensar_purge_expired() function body, which — like any schema change —
-- belongs in a new migration file rather than a hand-run SQL editor edit.
