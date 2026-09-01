-- pensar: boards + cards
-- Lives in the shared niu Supabase project; pensar_ prefix keeps it clear of niu's own tables.
-- See pensar-build-plan.md for the data model this implements.

create table if not exists public.pensar_boards (
  id uuid primary key default gen_random_uuid(),
  user_id uuid not null default auth.uid() references auth.users (id) on delete cascade,
  name text not null,
  position int not null default 0,
  archived_at timestamptz,
  created_at timestamptz not null default now()
);

create table if not exists public.pensar_cards (
  id uuid primary key default gen_random_uuid(),
  user_id uuid not null default auth.uid() references auth.users (id) on delete cascade,
  board_id uuid references public.pensar_boards (id) on delete set null,
  status text not null default 'todo' check (status in ('todo', 'doing', 'done')),
  position int not null default 0,
  title text not null,
  body_markdown text not null default '',
  cover_image_url text,
  due_date date,
  priority text check (priority in ('low', 'medium', 'high')),
  archived_at timestamptz,
  deleted_at timestamptz,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

create index if not exists pensar_boards_user_id_idx on public.pensar_boards (user_id);
create index if not exists pensar_cards_user_id_idx on public.pensar_cards (user_id);
create index if not exists pensar_cards_board_id_idx on public.pensar_cards (board_id);

-- keep updated_at current on every card edit
create or replace function public.pensar_set_updated_at()
returns trigger
language plpgsql
as $$
begin
  new.updated_at = now();
  return new;
end;
$$;

drop trigger if exists pensar_cards_set_updated_at on public.pensar_cards;
create trigger pensar_cards_set_updated_at
  before update on public.pensar_cards
  for each row
  execute function public.pensar_set_updated_at();

-- RLS: every row scoped to auth.uid() = user_id
alter table public.pensar_boards enable row level security;
alter table public.pensar_cards enable row level security;

create policy "pensar_boards_select_own" on public.pensar_boards
  for select using (auth.uid() = user_id);

create policy "pensar_boards_insert_own" on public.pensar_boards
  for insert with check (auth.uid() = user_id);

create policy "pensar_boards_update_own" on public.pensar_boards
  for update using (auth.uid() = user_id) with check (auth.uid() = user_id);

create policy "pensar_boards_delete_own" on public.pensar_boards
  for delete using (auth.uid() = user_id);

create policy "pensar_cards_select_own" on public.pensar_cards
  for select using (auth.uid() = user_id);

create policy "pensar_cards_insert_own" on public.pensar_cards
  for insert with check (auth.uid() = user_id);

create policy "pensar_cards_update_own" on public.pensar_cards
  for update using (auth.uid() = user_id) with check (auth.uid() = user_id);

create policy "pensar_cards_delete_own" on public.pensar_cards
  for delete using (auth.uid() = user_id);
