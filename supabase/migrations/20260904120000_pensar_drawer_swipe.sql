-- A board can be set to swipe between its drawers on a phone instead of
-- stacking them one under another. It's a property of the project, not of
-- one device, so it lives on the board and travels with it the same as
-- colour and emoji do — see src/boardStyle.js and the icon beside "+ Drawer"
-- in src/boardView.js.

alter table public.pensar_boards
  add column if not exists swipe_drawers boolean not null default false;
