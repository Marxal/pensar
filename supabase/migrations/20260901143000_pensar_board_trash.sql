-- pensar: soft-delete for boards, matching the trash pensar_cards already has.
-- Deleting a board sets deleted_at instead of removing the row, so it can
-- show up in a Trash view with a restore action (Phase 4).

alter table public.pensar_boards
  add column if not exists deleted_at timestamptz;
