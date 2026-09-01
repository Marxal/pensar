# pensar — build plan

Personal task & note app. Single user (you). Boards with kanban cards, a quick-capture inbox, markdown notes with images, search, archive/trash, and live sync across desktop and phone.

## Decisions locked in from your answers

- **Data:** new tables in niu's existing Supabase project, prefixed `pensar_` so nothing collides with niu's own tables.
- **Hosting:** GitHub Pages, same as Obertura. A static site talking to Supabase directly needs no server.
- **Boards:** fixed kanban columns per board — To do / Doing / Done. Custom column names aren't in v1; each board is a self-contained set of cards, not shared across boards.
- **Notes:** markdown body, one cover image per card, due date, priority tag. No checklists in v1.
- **Copy button:** copies the note as markdown.
- **Images:** uploaded to Supabase Storage, paste-from-clipboard supported, one cover image per card.
- **Inbox:** the home screen. Swipe to assign/archive/delete on mobile; tap-based on desktop.
- **Search:** instant, client-side, titles + body, everywhere at once.
- **Archive:** auto-clears after 90 days. **Trash:** recoverable, then gone — I'm proposing 30 days before permanent deletion; flag if you want a different window.
- **Sync:** Supabase Realtime, changes appear on your other device within a second or two. No offline mode needed.
- **Look:** warm, paper-and-ink, modern and readable — the same direction as the intake doc you just filled in (Fraunces for headings, Inter for UI, a teal ink accent, amber for priority tags), light/dark following the system with a manual override.

## Two things worth a second look before we start

**Auth.** You picked Supabase email/password on the form, then mentioned in the same breath that niu's project already has Google login configured. I'd reuse that — one less password to manage, and it's already wired up. Say the word if you'd rather keep them separate.

**The widget.** A true home-screen widget (the iOS/Android kind) isn't something a PWA can do — iOS doesn't expose that to web apps at all, and Android only allows it through a fully native app, which is a much bigger build than this project calls for. The closest realistic thing is an Android "app shortcut" (long-press the icon → jump straight to Inbox) — not a live-updating widget, just a fast path to capture. Worth doing as a small Phase 5 touch, but going in with the right expectation.

## Data model

**pensar_boards**
| column | type | notes |
|---|---|---|
| id | uuid | |
| user_id | uuid | scopes rows to you via RLS |
| name | text | |
| position | int | display order |
| archived_at | timestamptz, nullable | |
| created_at | timestamptz | |

**pensar_cards**
| column | type | notes |
|---|---|---|
| id | uuid | |
| user_id | uuid | |
| board_id | uuid, nullable | null = sits in the Inbox |
| status | text | `todo` / `doing` / `done`, ignored while board_id is null |
| position | int | order within a column |
| title | text | |
| body_markdown | text | |
| cover_image_url | text, nullable | |
| due_date | date, nullable | |
| priority | text, nullable | `low` / `medium` / `high` |
| archived_at | timestamptz, nullable | |
| deleted_at | timestamptz, nullable | trash |
| created_at / updated_at | timestamptz | |

**Storage:** a `pensar-images` bucket, one object per card cover image.

**RLS:** every table scoped to `auth.uid() = user_id`, set automatically on insert. You're the only user today, but this keeps the door open and keeps pensar's rows cleanly separated from niu's inside the same project.

## Phased roadmap

**Phase 0 — Foundation.** Repo scaffold (Vite), GitHub Pages deploy, the two Supabase tables + storage bucket + RLS, Google login screen, and the light/dark design tokens.

**Phase 1 — Boards & kanban.** Create/rename/archive a board, cards inside To do/Doing/Done, drag-and-drop between and within columns, priority tag and due date on the card.

**Phase 2 — Quick capture inbox.** Inbox as the home screen with a fast add field, assigning an inbox item into a board, swipe gestures on mobile.

**Phase 3 — Rich notes & images.** Markdown editor with preview, cover image upload, paste-from-clipboard, the one-click copy-as-markdown button.

**Phase 4 — Search, archive, trash.** Instant search across everything, archive with the 90-day auto-clear, trash with restore and a 30-day permanent-delete window.

**Phase 5 — Sync & polish.** Realtime subscriptions so changes show up live, the PWA install experience on both platforms, the Android shortcut, a final pass across phone/desktop and both themes.

## Files for this project

- `pensar-build-plan.md` — this document
- `pensar-CLAUDE.md` — drop this in the repo root as `CLAUDE.md` so Claude Code always has the context
- `pensar-tracker.html` — open this in your browser to work phase by phase; each task has a ready-to-paste Claude Code prompt and a checkbox that persists
