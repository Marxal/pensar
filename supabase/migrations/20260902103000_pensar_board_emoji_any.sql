-- pensar: let a board's icon be any emoji the keyboard can type.
--
-- The column was added with `char_length(emoji) between 1 and 8`, which was
-- plenty when the app offered a grid of sixteen emoji to choose from. It no
-- longer does — the icon is now typed into a field, using the phone's own emoji
-- keyboard, because every device already has a better picker than one we could
-- ship.
--
-- That makes eight characters too few. An emoji is one thing on screen and any
-- number of code points underneath: a flag is two, a skin tone adds one, and a
-- couple-with-heart is ten. `char_length` counts code points, so those would be
-- refused by the database after being accepted by the keyboard, which is the
-- worst place to find out. Forty leaves room for the longest sequences Unicode
-- currently defines while still refusing a pasted paragraph.
--
-- The app keeps only the last *grapheme* of whatever is typed (see `oneEmoji`
-- in src/boardStyle.js), so this is a backstop rather than the rule.

-- The original constraint was created inline with the column, so its name came
-- from Postgres. Look it up rather than guessing at it.
do $$
declare
  constraint_name text;
begin
  for constraint_name in
    select con.conname
    from pg_constraint con
    join pg_class rel on rel.oid = con.conrelid
    join pg_namespace nsp on nsp.oid = rel.relnamespace
    where nsp.nspname = 'public'
      and rel.relname = 'pensar_boards'
      and con.contype = 'c'
      and pg_get_constraintdef(con.oid) ilike '%emoji%'
  loop
    execute format('alter table public.pensar_boards drop constraint %I', constraint_name);
  end loop;
end $$;

alter table public.pensar_boards
  add constraint pensar_boards_emoji_length
  check (emoji is null or char_length(emoji) between 1 and 40);
