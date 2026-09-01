-- Round 6: make deletes sync, and add the second priority flag.
--
-- Two unrelated-looking changes that both came out of the same round of testing
-- on real phones.
--
-- ---------------------------------------------------------------------------
-- 1. Replica identity, and why "Clear" wasn't syncing
-- ---------------------------------------------------------------------------
-- Adding and ticking off synced instantly, but emptying the trolley only
-- happened on the phone that pressed the button. The other one sat there with a
-- trolley full of things that no longer existed.
--
-- The cause is in Postgres, not in the app. Realtime subscribes with a filter —
-- household_id=eq.<us> — so we only receive our own household's changes. On an
-- INSERT or an UPDATE the whole new row goes into the write-ahead log, so the
-- filter can see household_id and the event matches. On a DELETE there is no new
-- row: Postgres logs only the *replica identity* of the deleted one, which by
-- default is the primary key and nothing else. So the event arrived carrying
-- `{id: …}`, the filter looked for household_id, found none, and dropped it.
--
-- Supabase documents this exactly: "You can only filter Delete events when
-- tracking Postgres Changes if the table has the replica identity set to full."
--
-- `full` logs the entire old row on delete, so the filter matches and the app
-- learns what disappeared. The cost is a slightly larger WAL entry per delete,
-- which for a two-person shopping list is nothing.
--
-- Worth knowing: RLS is *not* applied to delete events (Postgres cannot check
-- access to a row that no longer exists), so the household filter in the
-- subscription is what keeps one household's deletes out of the other's stream.
-- That is why the app must keep subscribing with a filter rather than filtering
-- client-side.

alter table public.list_items replica identity full;

-- ---------------------------------------------------------------------------
-- 2. "If convenient", the other end of urgent
-- ---------------------------------------------------------------------------
-- Urgent floats an item to the top. This is the opposite: get it if you happen
-- to pass it, and don't make a detour. It sinks to the bottom of the list.
--
-- A second boolean rather than a priority number because the two flags are what
-- the UI shows and they read plainly in a query. The constraint below is what
-- stops the meaningless combination of both at once — the sheet only lets you
-- pick one, and this makes that true of the data rather than only of the screen.

alter table public.list_items
  add column if not exists if_convenient boolean not null default false;

do $$
begin
  alter table public.list_items
    add constraint list_items_one_priority check (not (urgent and if_convenient));
exception
  when duplicate_object then null;
end
$$;
