# pensar

A personal task & note app: kanban boards, a quick-capture inbox, markdown notes with images, search, archive/trash, synced live across desktop and phone. Single user, no multi-tenant concerns.

## Stack

- Vite + vanilla JS (no framework) — keep it simple, no build magic beyond what Vite gives for free
- Supabase: Postgres + Auth (Google OAuth, reusing the niu project's existing provider) + Storage + Realtime
- Deployed as a static site to GitHub Pages via GitHub Actions
- PWA: installable on desktop and phone (manifest + icons), no offline mode — always-online is fine

## Data

Two tables in the shared niu Supabase project, prefixed `pensar_` to stay clear of niu's own tables: `pensar_boards` and `pensar_cards`. Every row carries `user_id` and is scoped by RLS to `auth.uid()`. `pensar_cards.board_id` is nullable — null means the card is sitting in the Inbox. `status` (`todo`/`doing`/`done`) only matters once a card has a board. See `pensar-build-plan.md` for the full column list.

**Schema changes are migration files via the Supabase CLI — never the SQL editor.** A new file in `supabase/migrations/`, then `supabase db push` from a real terminal (has to be Marçal — Claude Code's sandboxed shell can't reach the CLI's login session, and the DB password shouldn't pass through it anyway). Because this Supabase project is shared with `niu` (same project ref), the migration-history table lives once in that shared database — so **every migration file, from either app, must exist in both repos' `supabase/migrations/` folders**, or `db push` / `migration list` will error about remote versions missing locally. Claude mirrors the file into the niu repo automatically.

## Working style

- One layer at a time — build a phase, hand it back for a phone/desktop test, then move on
- Whole files, not diffs or fragments
- Lead with what changed, keep explanations short
- Kanban columns are fixed (To do / Doing / Done) — don't build custom-column support, it's not in scope
- No checklists inside cards, no offline sync — both explicitly out of v1
- A true OS home-screen widget is not achievable as a PWA; don't attempt native wrappers for it without discussing first

## Design

Warm, paper-and-ink feel — not a generic SaaS-card look. Fraunces for headings, Inter for UI text, a teal ink accent, amber for priority tags. Light/dark follows the system by default with a manual override. Full token list and the reference build lives in `pensar-questionnaire.html` (the intake doc) — same visual direction carries into the app.

## Reference documents

- `pensar-build-plan.md` — decisions, data model, phased roadmap
- `pensar-tracker.html` — phase-by-phase task list with copy-paste prompts
