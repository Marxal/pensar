-- Round 18: event_sync and event_tombstones stop growing forever.
--
-- event_sync (one row per member per event) used to get an update setting
-- removed_at once a member's phone had told Google to delete its copy, and was
-- never cleared after that. event_tombstones (one row per deleted event, so a
-- phone that hasn't synced in a while still learns an event was removed) has
-- had a working delete policy since 0012, but nothing in the app ever called
-- it. Together these were roughly a fifth of the calendar's ongoing row
-- growth, for rows nobody reads again once they've done their job.
--
-- src/lib/google-sync.svelte.ts now deletes an event_sync row the moment
-- removal succeeds instead of stamping it — syncPlan() already treats a
-- missing row exactly like a removed one (src/lib/google-event.ts), so this
-- changes nothing about behaviour. What's left here:
--
-- Run it once in the Supabase dashboard under SQL Editor. Safe to re-run.

-- One-off: clears whatever the old stamp-not-delete behaviour already left
-- behind. After this round ships nothing sets removed_at any more, so a
-- second run of this statement finds nothing.
delete from public.event_sync where removed_at is not null;

-- Deciding whether a tombstone is safe to remove means checking whether *any*
-- household member still has an event_sync row for it — and event_sync's own
-- RLS deliberately only lets a member see their own rows ("clear your own
-- sync state", 0012: "Another member's sync state is none of your business").
-- security definer is what lets this one cross-member check run without
-- opening that up, the same pattern record_shop() uses in 0007. It only ever
-- deletes tombstones; it never hands another member's row back to the client.
create or replace function public.cleanup_event_tombstones()
returns void
language sql
security definer
set search_path = ''
as $$
  delete from public.event_tombstones et
  where not exists (
    select 1 from public.event_sync es where es.event_id = et.event_id
  );
$$;

revoke all on function public.cleanup_event_tombstones() from public;
grant execute on function public.cleanup_event_tombstones() to authenticated;
