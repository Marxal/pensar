# pensar

A personal task & note app: projects with user-made drawers, quick-capture notes, markdown notes with images, search, archive/trash, synced live across desktop and phone. Single user, no multi-tenant concerns.

## Stack

- Vite + vanilla JS (no framework) — keep it simple, no build magic beyond what Vite gives for free
- Supabase: Postgres + Auth (Google OAuth, reusing the niu project's existing provider) + Storage + Realtime
- Deployed as a static site to GitHub Pages via GitHub Actions
- PWA: installable on desktop and phone (manifest + icons), no offline mode — always-online is fine

**Testing Google sign-in on a phone over LAN needs a hostname, never the raw
LAN IP.** Supabase's Auth server hard-rejects any redirect whose host parses
as an IP address (confirmed from its own source — only `127.0.0.1` passes),
regardless of what's in the dashboard's allow-list — so `http://192.168.x.x:…`
can never work there, no matter how it's wildcarded. Use this Mac's Bonjour/
mDNS hostname instead (`scutil --get LocalHostName`, e.g.
`http://iMac-de-Marcal.local:5173/pensar/`); `vite.config.js`'s
`server.allowedHosts: ['.local']` lets Vite accept that hostname, and the
shared Supabase project needs `http://iMac-de-Marcal.local:*/**` on its
Redirect URLs list. Full detail lives in niu's `CLAUDE.md` (rule 8) since it's
the same Supabase project either app can add the entry from.

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

## How things behave

Decisions that are easy to undo by accident, so they're written down:

- **A title is for long notes only.** A line typed into quick capture or into a tick list becomes the card's *note*, not its title — the heading falls back to the note when there's no title, so a title as well would be the same words twice.
- **Drawers** are reordered by dragging their header (the menu still offers Move earlier / later, for the keyboard), renamed by clicking the name in place, and **deleting one takes its cards to the trash with it**. They used to be tipped out into Quick notes; that surprised every time.
- **A note folds itself out** unless it's long, carries more than one picture, or sits in a crowded drawer — `cardStartsOpen` in `cardTile.js`. Whatever the user folds by hand is remembered per device and wins (`openCards.js`).
- **A picture appears once.** The face carries a thumbnail only while the card is folded away; the note underneath shows it at full width when it isn't.
- **A gallery is masonry** — CSS columns, pictures uncropped, and a note with no picture becomes a block of text among them. Pictures dropped onto any drawer from outside the browser become cards.
- **Gestures don't ask first, they offer an undo afterwards** (`undo.js`): merges, files, archives, bin drops and drawer deletes all leave one behind.
- **Sharing into pensar** from the phone's share sheet is `share_target` in the manifest plus `public/sw.js`, which catches the POST and hands it to `share.js`. Android/Chrome only — iOS doesn't implement share targets for web apps at all. The service worker exists for that one job and caches nothing; pensar is always-online by design.

## Design

Warm, paper-and-ink feel — not a generic SaaS-card look. Fraunces for headings, Inter for UI text, a teal ink accent, and a three-step priority scale that runs sage → amber → clay. Light/dark follows the system by default with a manual override. Full token list and the reference build lives in `pensar-questionnaire.html` (the intake doc) — same visual direction carries into the app.

A board can be painted with one of eight colours from `src/boardStyle.js`. The colour is stored as a key, never a CSS value, and reaches the tile through `--tint` / `--tint-soft` — so a new colour means one entry there plus one line in each theme block of `style.css`.

Its icon is either an emoji or a picture, and neither has a picker of our own: the emoji is typed into a field with the device's own emoji keyboard (`oneEmoji` keeps the last grapheme), and the picture is a tap on the square in the dialog, or one dropped onto it.

## Reference documents

- `pensar-build-plan.md` — decisions, data model, phased roadmap
- `pensar-tracker.html` — phase-by-phase task list with copy-paste prompts
