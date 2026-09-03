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
- **A tick list's "done" isn't only the tick box.** Dragging a card past the drawer's "Completed" divider marks it done, and dragging one back above the divider undoes that — `commitOrder` in `boardView.js` reads which side of the divider a card landed on. The tick also follows the card into its own note: opening a card from a `list` drawer shows the same tick beside its title (`openNote`'s `kind` param, in `noteEditor.js`), so a task can be finished without going back to the board.
- **A card's face carries no buttons.** It used to hold copy, a chevron that folded the note out, and a dots menu, held clear of the words by an invisible float as wide as all three. A drawer is never wider than 26rem on any device, so that float was a quarter of the heading's first line everywhere — the phone just made it obvious. Copy is all that's left, and only where there's a pointer to hover it with (`@media (hover: hover)`); a touch screen shows nothing. Tapping a card opens its note, which is what the menu's Open did; dragging it files, archives or bins it, which is the rest of the menu. Don't put anything back there without moving something else out. The one thing a gesture can't do precisely is pick an *exact* drawer on another board — dropping a card on a project chip lands it in that project's first drawer — so "Move to…" lives in the note's own menu instead, and the view underneath supplies it (`onMove` passed to `openNote`), since that's where the lists and the undo are.
- **Drawers** have no dots menu. Their shape is three icons at the top right of the header — tap one to switch, no dialog — and beside them is the fold control, with "show this one on its own" as well on a desktop. Reordering is a drag of the header, same as a card; and dragging one onto the delete zone that appears along the top **takes its cards to the trash with it** (an undo follows, the same as any other gesture). Renaming is still a click on the name in place. Drawers used to tip their cards out into Quick notes when deleted; that surprised every time, so deleting one now means what it says.
- **A note folds itself out** unless it's long, carries more than one picture, or sits in a crowded drawer — `cardStartsOpen` in `cardTile.js`. **Folding is the drawer's decision, not the card's**: one control in the header folds every note in it out or away, and Quick notes has the same button in its own heading. What that writes is still per card and per device (`openCards.js`), and it still wins over the heuristic. A titleless card spends its note on its heading, so once it's folded out the heading is dropped — otherwise the first ninety characters would be on the screen twice.
- **A picture appears once.** The face carries a thumbnail only while the card is folded away; the note underneath shows it at full width when it isn't.
- **A link is a card, not a picture of one.** A preview used to be the page's Open Graph image and nothing else, because `[![](img)](url)` is all markdown can carry. A link card now stores its own small piece of HTML — picture, title, description, site — in `body_markdown`, kept verbatim by a turndown rule that re-serialises from `readLinkCard`'s *data* so no editing chrome can leak into the database (`src/linkCard.js`, `markdown.js`). Old picture-only previews still read, and are written back in the new shape the next time the note is saved. The same children are drawn three ways off a class on the root: two columns in a note, `is-tile` (picture over words) on a gallery, `is-row` (small picture, one line) on a tick list — and on the front of a card the root is a `<span>`, because the face is already a button. A page with no picture falls back to the site's own icon (`data-icon`, drawn contained rather than cropped), and with not even that, to the site's initial on paper. `plainText` and `firstImage` step over link cards, so a stranger's headline never becomes your note's heading — and a note whose only words are the URL its card stands for drops the heading altogether.
- **A link typed anywhere gets looked up.** Not just in the note editor: quick capture, a tick list's add field and a share from the phone all linkify the line (`linkifyMarkdown`) and then look the links up *after* the card exists (`addLinkPreviews`), so capture stays instant and the card grows its pictures a second later.
- **A gallery is masonry** — CSS columns, pictures uncropped, and a note with no picture becomes a block of text among them. Pictures dropped onto any drawer from outside the browser become cards. **Its column count is a tap on the gallery icon it's already set to**, cycling 1 → 2 → 3 → 4 (the icon's tooltip says where the next tap lands, since nothing else advertises it). That's this device's screen talking rather than the drawer, so it lives in `galleryZoom.js` and localStorage, never the database — and until it's been tapped the stylesheet's own fallback decides: two columns in the row, four for a drawer on its own. `defaultColumns` in `boardView.js` repeats those two numbers, so change them together.
- **A note is archived by a flick sideways**, either direction — the drop bar's Archive zone wants a press, a hold and a trip to the top of the screen, which is a lot of hand for "not now". Touch only (`swipe.js`): a mouse drag is already a reorder at five pixels of travel, and a pointer has the bar to aim at. The two gestures share a card without a handshake — a finger held still is a drag, one that sets off sideways first is a swipe, and `drag.js` drops its pending press the moment the finger travels. It works at all because `.card` carries `touch-action: pan-y`, so the browser keeps the vertical axis for scrolling and hands us the horizontal one; don't take that off the card.
- **Archived and deleted are two different places**, and both are reached from the row at the foot of Home. The **Archive** (`#/archived`, `archivedView.js`) holds notes *and* projects, kept whole — restoring a note puts it back in its drawer, or into Quick notes if that drawer has gone since. The **Trash** holds what was deleted. Deleting from the Archive moves the thing to the trash rather than ending it. Both are cleared by the same scheduled job — 90 days for the archive, 30 for the trash — so neither empty state may promise "nothing is deleted". The Archive link sits in the footer whether or not anything is in it: a gesture that puts something somewhere needs that somewhere to be findable by someone who hasn't used the gesture yet.
- **Gestures don't ask first, they offer an undo afterwards** (`undo.js`): merges, files, archives, bin drops and drawer deletes all leave one behind.
- **Sharing into pensar** from the phone's share sheet is `share_target` in the manifest plus `public/sw.js`, which catches the POST and hands it to `share.js`. Android/Chrome only — iOS doesn't implement share targets for web apps at all. The service worker exists for that one job and caches nothing; pensar is always-online by design.

## Design

Warm, paper-and-ink feel — not a generic SaaS-card look. Fraunces for headings, Inter for UI text, a teal ink accent, and a three-step priority scale that runs sage → amber → clay. Light/dark follows the system by default with a manual override. Full token list and the reference build lives in `pensar-questionnaire.html` (the intake doc) — same visual direction carries into the app.

A board can be painted with one of eight colours from `src/boardStyle.js`. The colour is stored as a key, never a CSS value, and reaches the tile through `--tint` / `--tint-soft` — so a new colour means one entry there plus one line in each theme block of `style.css`.

Its icon is either an emoji or a picture, and neither has a picker of our own: the emoji is typed into a field with the device's own emoji keyboard (`oneEmoji` keeps the last grapheme), and the picture is a tap on the square in the dialog, or one dropped onto it.

## Reference documents

- `pensar-build-plan.md` — decisions, data model, phased roadmap
- `pensar-tracker.html` — phase-by-phase task list with copy-paste prompts
