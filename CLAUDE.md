# pensar

A personal task & note app: projects with user-made drawers, quick-capture notes, markdown notes with images, search, archive/trash, synced live across desktop and phone. Single user, no multi-tenant concerns.

## Stack

- Vite + vanilla JS (no framework) — keep it simple, no build magic beyond what Vite gives for free
- Supabase: Postgres + Auth (Google OAuth, reusing the niu project's existing provider) + Storage + Realtime
- Deployed as a static site to GitHub Pages via GitHub Actions
- PWA: installable on desktop and phone (manifest + icons), no offline mode — always-online is fine

## Data

Three tables in the shared niu Supabase project, prefixed `pensar_` to stay clear of niu's own tables: `pensar_boards`, `pensar_drawers` and `pensar_cards`. Every row carries `user_id` and is scoped by RLS to `auth.uid()`. See `pensar-build-plan.md` for the full column list.

A card's placement is its `drawer_id` and nothing else — null means it's a quick note on the home screen. `board_id` is still on the card so "every card on this board" stays a single-table query, but it is **written by a trigger** from the drawer, never by the app. Don't set it.

**Schema changes are migration files via the Supabase CLI — never the SQL editor.** A new file in `supabase/migrations/`, then `supabase db push` from a real terminal (has to be Marçal — Claude Code's sandboxed shell can't reach the CLI's login session, and the DB password shouldn't pass through it anyway). Because this Supabase project is shared with `niu` (same project ref), the migration-history table lives once in that shared database — so **every migration file, from either app, must exist in both repos' `supabase/migrations/` folders**, or `db push` / `migration list` will error about remote versions missing locally. Claude mirrors the file into the niu repo automatically.

## Working style

- One layer at a time — build a phase, hand it back for a phone/desktop test, then move on
- Whole files, not diffs or fragments
- Lead with what changed, keep explanations short
- A board's columns are **drawers**: the user names them and picks a shape (`list` / `notes` / `gallery`). The old fixed To do / Doing / Done is gone
- A note is a page, not a form: title and body run straight on, pictures are dropped in, there is no Save button. Anything that wants to be a labelled field beside the note probably shouldn't exist
- No sub-checklists inside a single card, no offline sync — both still out of scope. (A `list` drawer gives each *card* a tick box; that's a different thing.)
- A true OS home-screen widget is not achievable as a PWA; don't attempt native wrappers for it without discussing first

## Design

Warm, paper-and-ink feel — not a generic SaaS-card look. Fraunces for headings, Inter for UI text, a teal ink accent, and a three-step priority scale that runs sage → amber → clay. Light/dark follows the system by default with a manual override. Full token list and the reference build lives in `pensar-questionnaire.html` (the intake doc) — same visual direction carries into the app.

A board can be painted with one of eight colours from `src/boardStyle.js`. The colour is stored as a key, never a CSS value, and reaches the tile through `--tint` / `--tint-soft` — so a new colour means one entry there plus one line in each theme block of `style.css`.

## Reference documents

- `pensar-build-plan.md` — decisions, data model, phased roadmap
- `pensar-tracker.html` — phase-by-phase task list with copy-paste prompts
