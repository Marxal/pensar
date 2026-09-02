-- pensar: user-defined drawers, and boards you can tell apart at a glance.
--
-- Two changes that travel together, because both are about a board no longer
-- being a fixed three-column kanban:
--
--   1. **Drawers.** A board's columns were hard-coded To do / Doing / Done and
--      lived in `pensar_cards.status`. They are now rows in `pensar_drawers`,
--      each with its own name and a `kind` that decides how its cards are
--      drawn: a tickable list, plain notes, or a picture gallery.
--   2. **Board looks.** A colour, and an icon that is either an emoji or an
--      uploaded image, so a board is recognisable in the home grid without
--      having to read it.
--
-- A card's cover picture goes too, folded into the note it belonged to — see
-- part 5 for why.
--
-- ## What happens to the cards that already exist
--
-- Nothing moves. Every board gets three drawers named after the old columns, in
-- the old order, and each card lands in the drawer matching the status it
-- already had — so a board looks the same the first time it's opened. They are
-- created as `notes` drawers, which is the behaviour cards have today; turning
-- one into a tick list is a two-tap edit in the app afterwards. Cards that sat
-- in Done are marked `done` at the same time, so that switch finds them already
-- ticked.
--
-- Once every card carries a drawer, `status` has nothing left to say, and it is
-- dropped. Both steps run inside this one migration, so there is no window in
-- which a card's placement is only half-recorded.
--
-- ## board_id is derived from now on, not set
--
-- A card's placement *is* its drawer. `board_id` stays, because "every live card
-- on this board" and "how many cards has each board" are the two queries the app
-- runs most and neither should need a join — but it stops being the app's to
-- write. A trigger fills it from the drawer on every insert and update, so the
-- two cannot drift, and clearing the drawer (dropping a card back into Quick
-- notes, or deleting the drawer it was sitting in) clears the board with it.

-- ---------------------------------------------------------------------------
-- 1. Drawers
-- ---------------------------------------------------------------------------

create table if not exists public.pensar_drawers (
  id uuid primary key default gen_random_uuid(),
  user_id uuid not null default auth.uid() references auth.users (id) on delete cascade,
  board_id uuid not null references public.pensar_boards (id) on delete cascade,
  name text not null check (char_length(trim(name)) between 1 and 40),
  -- How the drawer draws its cards, not what they are: the same card reads as a
  -- tick-box line in a `list`, a note tile in `notes`, and a picture in a
  -- `gallery`. Changing a drawer's kind never touches the cards inside it.
  kind text not null default 'notes' check (kind in ('list', 'notes', 'gallery')),
  position int not null default 0,
  created_at timestamptz not null default now()
);

create index if not exists pensar_drawers_user_id_idx on public.pensar_drawers (user_id);
create index if not exists pensar_drawers_board_id_idx on public.pensar_drawers (board_id);

alter table public.pensar_drawers enable row level security;

drop policy if exists "pensar_drawers_select_own" on public.pensar_drawers;
create policy "pensar_drawers_select_own" on public.pensar_drawers
  for select using (auth.uid() = user_id);

drop policy if exists "pensar_drawers_insert_own" on public.pensar_drawers;
create policy "pensar_drawers_insert_own" on public.pensar_drawers
  for insert with check (auth.uid() = user_id);

drop policy if exists "pensar_drawers_update_own" on public.pensar_drawers;
create policy "pensar_drawers_update_own" on public.pensar_drawers
  for update using (auth.uid() = user_id) with check (auth.uid() = user_id);

drop policy if exists "pensar_drawers_delete_own" on public.pensar_drawers;
create policy "pensar_drawers_delete_own" on public.pensar_drawers
  for delete using (auth.uid() = user_id);

-- ---------------------------------------------------------------------------
-- 2. Cards point at a drawer, and can be ticked off
-- ---------------------------------------------------------------------------

-- `on delete set null` rather than cascade: losing a drawer must never take
-- notes with it. A card whose drawer goes away falls back to Quick notes, which
-- the trigger below completes by clearing board_id too.
alter table public.pensar_cards
  add column if not exists drawer_id uuid references public.pensar_drawers (id) on delete set null,
  add column if not exists done boolean not null default false;

create index if not exists pensar_cards_drawer_id_idx on public.pensar_cards (drawer_id);

-- ---------------------------------------------------------------------------
-- 3. Backfill: one drawer per old column, per board
-- ---------------------------------------------------------------------------

insert into public.pensar_drawers (user_id, board_id, name, kind, position)
select b.user_id, b.id, seed.name, 'notes', seed.position
from public.pensar_boards b
cross join (values ('To do', 0), ('Doing', 1), ('Done', 2)) as seed (name, position)
where not exists (
  select 1 from public.pensar_drawers d where d.board_id = b.id
);

-- Matched on position rather than name, so a board that somehow already had
-- drawers with different names still lands its cards in the right place.
update public.pensar_cards c
set drawer_id = d.id
from public.pensar_drawers d
where c.drawer_id is null
  and c.board_id is not null
  and d.board_id = c.board_id
  and d.position = case c.status when 'todo' then 0 when 'doing' then 1 else 2 end;

update public.pensar_cards
set done = true
where status = 'done';

alter table public.pensar_cards drop column if exists status;

-- ---------------------------------------------------------------------------
-- 4. board_id follows the drawer
-- ---------------------------------------------------------------------------

-- Deliberately *not* security definer: run as the caller, RLS and all, so a
-- drawer id that isn't yours simply selects nothing and leaves board_id null
-- rather than quietly filing your card against someone else's board.
create or replace function public.pensar_cards_sync_board()
returns trigger
language plpgsql
set search_path = ''
as $$
begin
  if new.drawer_id is null then
    new.board_id := null;
  else
    select d.board_id into new.board_id
    from public.pensar_drawers d
    where d.id = new.drawer_id;
  end if;
  return new;
end;
$$;

drop trigger if exists pensar_cards_sync_board on public.pensar_cards;
create trigger pensar_cards_sync_board
  before insert or update of drawer_id, board_id on public.pensar_cards
  for each row
  execute function public.pensar_cards_sync_board();

-- ---------------------------------------------------------------------------
-- 5. A card's cover picture becomes part of its note
-- ---------------------------------------------------------------------------
--
-- A card used to have one cover picture, set through a drop zone in a form
-- beside the note. Notes now hold as many pictures as they like, dropped in
-- where they belong, and the first of them is what the card shows on its face —
-- so a separate cover is a second answer to a question that only has one.
--
-- The picture itself doesn't move: `cover_image_url` already holds a path in
-- the `pensar-images` bucket, and `pensar-image/<path>` is exactly how a note
-- refers to one. Appending that line to the note keeps the picture, keeps it
-- on the front of the card, and — unlike the column it came from — leaves it
-- somewhere the editor can see and remove it.

update public.pensar_cards
set body_markdown = case
      when body_markdown = '' then '![](pensar-image/' || cover_image_url || ')'
      else body_markdown || E'\n\n![](pensar-image/' || cover_image_url || ')'
    end
where cover_image_url is not null;

alter table public.pensar_cards drop column if exists cover_image_url;

-- ---------------------------------------------------------------------------
-- 6. Board colour and icon
-- ---------------------------------------------------------------------------

-- `colour` is a key from the palette in src/boardStyle.js, not a CSS value: the
-- palette has to answer in both light and dark, which only the stylesheet can
-- do. It is deliberately unconstrained here — the palette grows in the app, and
-- an unrecognised key falls back to the default, which is a safe way to be wrong.
alter table public.pensar_boards
  add column if not exists colour text not null default 'teal',
  -- One emoji: the cheap icon, and the only one that can be set with a thumb.
  add column if not exists emoji text check (emoji is null or char_length(emoji) between 1 and 8),
  -- An object in the `pensar-images` bucket, as `<user_id>/b/<board_id>.jpg`.
  -- Beats the emoji when both are set.
  add column if not exists icon_path text;
