// One board: as many drawers as you've made, side by side on a wide screen and
// stacked on a phone. A drawer's kind decides how its cards are drawn — see
// cardTile.js — and nothing about a card changes when a drawer changes shape.
//
// Dragging is the shared engine in drag.js: press and move with a mouse, press
// and hold with a finger. There are two of them here, and they never overlap
// because they start from different places:
//
//   - **a card**, picked up from anywhere on its face. Dropped between cards it
//     moves and reorders; held over another card until it lights up, it merges
//     into it; dropped on the bar along the bottom, it's archived or binned.
//   - **a drawer**, picked up by its header, which reorders the drawers.
//
// Pictures dragged in from outside the browser are a third thing entirely —
// those are native file drops, and they land as new cards in whatever drawer
// they were dropped on.
//
// Anything that moves something without asking first leaves an undo offer
// behind it (undo.js) rather than a confirmation in front of it.

import {
  getBoard,
  listBoards,
  renameBoard,
  setBoardStyle,
  setBoardSwipeDrawers,
  archiveBoard,
  trashBoard,
} from './boards'
import {
  listAllDrawers,
  createDrawer,
  updateDrawer,
  deleteDrawer,
  saveDrawerOrder,
  DRAWER_KINDS,
  DRAWER_KIND_LABELS,
  FIRST_DRAWER,
} from './drawers'
import {
  listCards,
  createCard,
  setCardDone,
  archiveCard,
  unarchiveCard,
  trashCard,
  restoreCard,
  restoreCards,
  moveCardToDrawer,
  mergeCards,
  undoMerge,
  saveOrder,
} from './cards'
import { openBoardDialog, openConfirm, openDrawerDialog, openMovePicker } from './dialogs'
import { openNote } from './noteEditor'
import { openLightbox } from './lightbox'
import { renderCard, cardStartsOpen, dressNotes, CROWDED_AT } from './cardTile'
import { boardColour, renderBoardGlyph } from './boardStyle'
import { createDragEngine } from './drag'
import { createSwipeAway } from './swipe'
import { slideInto } from './flip'
import { signImages, looksLikeImage, uploadNoteImage } from './images'
import { addLinkPreviews } from './linkCard'
import { linkifyMarkdown } from './linkify'
import { hydrateNoteImages, plainText } from './markdown'
import { setCardFold } from './openCards'
import {
  galleryColumns,
  setGalleryColumns,
  forgetGalleryColumns,
  nextGalleryColumns,
} from './galleryZoom'
import { draft, setDraft, clearDraft } from './drafts'
import { offerUndo, dismissUndo } from './undo'
import { escapeHtml, plural } from './format'

const ICONS = {
  back: `<svg viewBox="0 0 24 24" aria-hidden="true"><path d="M15 5.5 8.5 12l6.5 6.5"/></svg>`,
  more: `<svg viewBox="0 0 24 24" aria-hidden="true"><circle cx="5.5" cy="12" r="1.35" fill="currentColor" stroke="none"/><circle cx="12" cy="12" r="1.35" fill="currentColor" stroke="none"/><circle cx="18.5" cy="12" r="1.35" fill="currentColor" stroke="none"/></svg>`,
  plus: `<svg viewBox="0 0 24 24" aria-hidden="true"><path d="M12 5.5v13M5.5 12h13"/></svg>`,
  archive: `<svg viewBox="0 0 24 24" aria-hidden="true"><rect x="3" y="4.5" width="18" height="4" rx="1.2"/><path d="M4.75 8.5v9.25a1.75 1.75 0 0 0 1.75 1.75h11a1.75 1.75 0 0 0 1.75-1.75V8.5M10 12.5h4"/></svg>`,
  trash: `<svg viewBox="0 0 24 24" aria-hidden="true"><path d="M5 7h14M9.5 7V5.2A1.2 1.2 0 0 1 10.7 4h2.6a1.2 1.2 0 0 1 1.2 1.2V7M7.5 7l.7 11.3A1.7 1.7 0 0 0 9.9 20h4.2a1.7 1.7 0 0 0 1.7-1.7L16.5 7M10.3 10.5v6M13.7 10.5v6"/></svg>`,
  check: `<svg viewBox="0 0 24 24" aria-hidden="true"><path d="M5 12.5l4.5 4.5L19 7"/></svg>`,
  expand: `<svg viewBox="0 0 24 24" aria-hidden="true"><path d="M15 4h5v5M20 4l-6.5 6.5M9 20H4v-5M4 20l6.5-6.5"/></svg>`,
  collapse: `<svg viewBox="0 0 24 24" aria-hidden="true"><path d="M20 9h-5V4M14.5 9.5 20 4M4 15h5v5M9.5 14.5 4 20"/></svg>`,
  picture: `<svg viewBox="0 0 24 24" aria-hidden="true"><rect x="3.5" y="5" width="17" height="14" rx="2"/><circle cx="9" cy="10" r="1.5"/><path d="M4 16.5l4.5-4 3.5 3 3-2.5 4.5 4"/></svg>`,
  // Chevrons apart and together: every note in the drawer folded out, or away.
  // Deliberately not expand/collapse above — that pair is one drawer filling
  // the screen, and on a desktop the two buttons now sit side by side.
  unfold: `<svg viewBox="0 0 24 24" aria-hidden="true"><path d="M8 10.5 12 6.5l4 4M8 13.5l4 4 4-4"/></svg>`,
  fold: `<svg viewBox="0 0 24 24" aria-hidden="true"><path d="M8 6.5 12 10.5l4-4M8 17.5l4-4 4 4"/></svg>`,
  // Two drawers with an outward arrow apiece — swipe between them on a phone
  // rather than stack them.
  swipe: `<svg viewBox="0 0 24 24" aria-hidden="true"><rect x="3.5" y="5.5" width="7" height="13" rx="1.3"/><rect x="13.5" y="5.5" width="7" height="13" rx="1.3"/><path d="M9.7 9.5 7.2 12l2.5 2.5M14.3 9.5l2.5 2.5-2.5 2.5"/></svg>`,
}

/** One small glyph per drawer shape, for the buttons that switch it. */
const KIND_ICONS = {
  list: `<svg viewBox="0 0 24 24" aria-hidden="true"><rect x="4" y="5.5" width="3" height="3" rx="0.7"/><path d="M10.5 7h9"/><rect x="4" y="10.5" width="3" height="3" rx="0.7"/><path d="M10.5 12h9"/><rect x="4" y="15.5" width="3" height="3" rx="0.7"/><path d="M10.5 17h9"/></svg>`,
  notes: `<svg viewBox="0 0 24 24" aria-hidden="true"><path d="M6.5 3.5h8l3 3v14h-11z"/><path d="M14.5 3.5v3h3"/><path d="M9 12h6M9 15.5h6"/></svg>`,
  gallery: ICONS.picture,
}

/** How long a card has to be held over another before the two would merge. */
const MERGE_DWELL_MS = 520

/** Below this width, "focus one drawer" gives way to "expand every note in
 *  this drawer" — a phone already shows drawers one at a time, stacked, so
 *  focusing one of them buys nothing there. */
function isPhone() {
  return window.matchMedia('(max-width: 40rem)').matches
}

/**
 * Render one board into `root`. Returns an unmount function that tears down
 * the listeners — call it before replacing `root`'s contents.
 */
export function mountBoard(root, boardId) {
  const state = {
    board: null,
    drawers: [],
    cards: [],
    boards: [], // for the "move to" picker
    allDrawers: [],
    images: new Map(), // storage path → signed URL
    status: 'loading', // loading | ready | error | missing
    error: '',
    busy: false, // an action is in flight; blocks double-taps
    focus: null, // a drawer being looked at on its own
    renaming: null, // a drawer whose name is being typed over
  }

  let alive = true

  // Drag bookkeeping: the bar zone under the pointer, and the card the dragged
  // one would fold into if it were let go now.
  let zone = null
  let mergeTarget = null
  let mergeCandidate = null
  let mergeTimer = null
  let fileTarget = null
  let projectTarget = null

  // Pictures chosen with the "Add pictures" button. It lives on the body
  // rather than inside the page so that a re-render mid-pick can't take the
  // input — and the change event with it — out from under the file dialog.
  const pictureInput = document.createElement('input')
  pictureInput.type = 'file'
  pictureInput.accept = 'image/*'
  pictureInput.multiple = true
  pictureInput.hidden = true
  document.body.append(pictureInput)
  let pictureDrawer = null

  /* ---------------------------------------------------------------
     Markup
     --------------------------------------------------------------- */

  function cardsIn(drawerId) {
    return state.cards
      .filter((card) => card.drawer_id === drawerId)
      .sort((a, b) => a.position - b.position || a.created_at.localeCompare(b.created_at))
  }

  function adderFor(drawer) {
    if (drawer.kind === 'list') {
      return `<form class="drawer-add-line" data-add-form data-drawer="${drawer.id}">
                <input
                  class="drawer-add-input"
                  type="text"
                  name="title"
                  autocomplete="off"
                  maxlength="200"
                  placeholder="Add an item…"
                  value="${escapeHtml(draft(`add-item:${drawer.id}`))}"
                />
                <button type="submit" class="icon-btn icon-btn-sm" aria-label="Add" title="Add">${ICONS.plus}</button>
              </form>`
    }

    if (drawer.kind === 'gallery') {
      return `<button type="button" class="drawer-add" data-act="add-pictures" data-drawer="${drawer.id}">
                ${ICONS.picture} Add pictures
              </button>`
    }

    return `<button type="button" class="drawer-add" data-act="add" data-drawer="${drawer.id}">
              ${ICONS.plus} Add note
            </button>`
  }

  function drawerTitle(drawer) {
    if (state.renaming === drawer.id) {
      return `<input
                class="drawer-title-input"
                data-rename="${drawer.id}"
                type="text"
                maxlength="40"
                autocomplete="off"
                aria-label="Drawer name"
                value="${escapeHtml(drawer.name)}"
              />`
    }

    return `<button
              type="button"
              class="drawer-title"
              data-act="drawer-rename"
              data-drawer="${drawer.id}"
              title="Rename this drawer"
            >${escapeHtml(drawer.name)}</button>`
  }

  /** A tick list splits into what's still open and what's done, so a long
   *  list doesn't bury today's items under everything ever finished. Other
   *  drawer shapes have no "done" of their own and stay a single run. */
  function cardListMarkup(cards, drawer, crowded) {
    const draw = (card) =>
      renderCard(card, {
        kind: drawer.kind,
        expanded: cardStartsOpen(card, { kind: drawer.kind, crowded }),
      })

    if (drawer.kind !== 'list') return cards.map(draw).join('')

    const open = cards.filter((card) => !card.done)
    const done = cards.filter((card) => card.done)
    if (!done.length) return open.map(draw).join('')

    return `
      ${open.map(draw).join('')}
      <p class="list-divider">Completed · ${done.length}</p>
      ${done.map(draw).join('')}
    `
  }

  function drawerSection(drawer) {
    const cards = cardsIn(drawer.id)
    const crowded = cards.length > CROWDED_AT
    const focused = state.focus === drawer.id

    // Folding notes out is what the chevron on every card used to do one at a
    // time, and it was always really a decision about the whole drawer — so it
    // lives here now, on every screen. A desktop keeps "show this one on its
    // own" beside it; a phone stacks drawers one at a time already.
    const focusControl = isPhone()
      ? ''
      : `
        <button
          type="button"
          class="icon-btn icon-btn-sm"
          data-act="drawer-focus"
          data-drawer="${drawer.id}"
          data-no-drag
          aria-pressed="${String(focused)}"
          aria-label="${focused ? 'Show every drawer' : 'Show this drawer on its own'}"
          title="${focused ? 'Show every drawer' : 'Show this drawer on its own'}"
        >${focused ? ICONS.collapse : ICONS.expand}</button>
      `

    let expandControl = ''
    if (cards.length) {
      const allOpen = cards.every((card) => cardStartsOpen(card, { kind: drawer.kind, crowded }))
      expandControl = `
        <button
          type="button"
          class="icon-btn icon-btn-sm"
          data-act="drawer-expand-all"
          data-drawer="${drawer.id}"
          data-no-drag
          aria-pressed="${String(allOpen)}"
          aria-label="${allOpen ? 'Collapse every note' : 'Expand every note'}"
          title="${allOpen ? 'Collapse every note' : 'Expand every note'}"
        >${allOpen ? ICONS.fold : ICONS.unfold}</button>
      `
    }

    // A gallery you're already looking at doesn't need switching to, so its own
    // icon takes a second job: another tap steps the column count. Its label
    // says where the next tap lands, since there's no other chrome to say so.
    const shapeControls = DRAWER_KINDS.map((kind) => {
      const current = drawer.kind === kind
      const label =
        current && kind === 'gallery'
          ? `Gallery — tap for ${plural(nextGalleryColumns(drawer.id, defaultColumns(drawer.id)), 'column')}`
          : DRAWER_KIND_LABELS[kind]

      return `
        <button
          type="button"
          class="icon-btn icon-btn-sm"
          data-act="drawer-kind"
          data-drawer="${drawer.id}"
          data-kind="${kind}"
          data-no-drag
          aria-pressed="${String(current)}"
          aria-label="${escapeHtml(label)}"
          title="${escapeHtml(label)}"
        >${KIND_ICONS[kind]}</button>
      `
    }).join('')

    // Left off entirely until it's been chosen, so the stylesheet's own
    // fallback — two columns, or four for a drawer on its own — still decides.
    const zoom = drawer.kind === 'gallery' ? galleryColumns(drawer.id) : undefined
    const columns = zoom ? ` style="--gallery-cols: ${zoom}"` : ''

    return `
      <section class="drawer" data-drawer="${drawer.id}" data-kind="${drawer.kind}"${columns}>
        <header class="drawer-head"${state.focus ? '' : ' data-drawer-handle'}>
          ${drawerTitle(drawer)}
          <span class="drawer-count">${cards.length}</span>
          ${focusControl}
          ${expandControl}
          <div class="drawer-shapes">${shapeControls}</div>
        </header>

        <div class="drawer-cards" data-cards>
          ${cardListMarkup(cards, drawer, crowded)}
          <p class="drawer-empty"${cards.length ? ' hidden' : ''}>
            ${drawer.kind === 'gallery' ? 'Drop pictures here' : 'Nothing here yet'}
          </p>
        </div>

        ${adderFor(drawer)}
      </section>
    `
  }

  function skeletons() {
    return `
      <div class="drawers">
        ${'<section class="drawer"><div class="drawer-cards"><div class="card card-skeleton"></div><div class="card card-skeleton"></div></div></section>'.repeat(
          2
        )}
      </div>
    `
  }

  function head() {
    const sub =
      state.status === 'ready'
        ? `${plural(state.cards.length, 'card')} · ${plural(state.drawers.length, 'drawer')}`
        : '&nbsp;'

    const style = state.board
      ? `<button
           type="button"
           class="page-head-glyph"
           data-act="board-edit"
           aria-label="Name, colour and icon"
           title="Name, colour &amp; icon"
         >${renderBoardGlyph(state.board, state.images)}</button>`
      : ''

    return `
      <header class="page-head">
        <div class="page-head-text">
          <button type="button" class="icon-btn" data-act="back" aria-label="Back" title="Back">${ICONS.back}</button>
          ${style}
          <div>
            <h2 class="page-title">
              <button type="button" class="title-btn" data-act="board-edit" title="Name, colour &amp; icon">
                ${escapeHtml(state.board?.name ?? 'Board')}
              </button>
            </h2>
            <p class="page-sub">${sub}</p>
          </div>
        </div>
        <div class="page-head-actions">
          ${
            state.focus
              ? `<button type="button" class="btn btn-ghost btn-sm" data-act="drawer-unfocus">${ICONS.collapse} All drawers</button>`
              : `
                <button
                  type="button"
                  class="icon-btn"
                  data-act="drawer-swipe-toggle"
                  aria-pressed="${String(Boolean(state.board?.swipe_drawers))}"
                  aria-label="${state.board?.swipe_drawers ? 'Stack drawers on a phone' : 'Swipe between drawers on a phone'}"
                  title="${state.board?.swipe_drawers ? 'Stack drawers on a phone' : 'Swipe between drawers on a phone'}"
                >${ICONS.swipe}</button>
                <button type="button" class="btn btn-ghost btn-sm" data-act="drawer-new">${ICONS.plus} Drawer</button>
              `
          }
          <div class="menu">
            <button
              type="button"
              class="icon-btn menu-trigger"
              data-act="menu"
              aria-haspopup="true"
              aria-expanded="false"
              aria-label="Board actions"
              title="Board actions"
            >${ICONS.more}</button>
            <div class="menu-list" hidden>
              <button type="button" data-act="board-edit">Name, colour &amp; icon…</button>
              <button type="button" data-act="board-archive">Archive board</button>
              <button type="button" class="menu-danger" data-act="board-delete">Delete board</button>
            </div>
          </div>
        </div>
      </header>
    `
  }

  /**
   * The bottom bar, always there while a board is open: every other project,
   * as a row of glyphs to switch between — no top header any more, so this is
   * how you get from one project to the next without going home first (see
   * main.js). Dropping a card on a chip files it into that project; dropping
   * it on Archive or Delete instead is `dropBar()`, up at the top out of the
   * way of this nav.
   */
  function projectBar() {
    if (state.boards.length < 2) return ''

    const chips = state.boards
      .map((board) => {
        const current = board.id === boardId
        return `
          <button
            type="button"
            class="project-chip"
            data-board="${board.id}"
            ${current ? 'data-current' : 'data-act="switch-board"'}
            aria-current="${String(current)}"
            aria-label="${current ? `${escapeHtml(board.name)} (this project)` : `Switch to ${escapeHtml(board.name)}`}"
            title="${escapeHtml(board.name)}"
          >${renderBoardGlyph(board, state.images, { size: 'sm' })}</button>
        `
      })
      .join('')

    return `
      <div class="project-bar" data-project-bar>
        <div class="project-bar-scroll">${chips}</div>
      </div>
    `
  }

  /** The bar that appears along the top while a card is in the air — kept
   *  clear of the project bar at the foot so a drop target is never crammed
   *  in beside the nav that switches projects. */
  function dropBar() {
    return `
      <div class="drop-bar" data-drop-bar hidden aria-hidden="true">
        <div class="drop-zone" data-zone="archive">${ICONS.archive}<span>Archive</span></div>
        <div class="drop-zone drop-zone-danger" data-zone="delete">${ICONS.trash}<span>Delete</span></div>
      </div>
    `
  }

  /** The board's colour washes the page it opens onto, not just its tile on
   *  Home — picked once, felt every time you're inside it. Set on the body
   *  rather than the page section so it can bleed to the edges of the
   *  viewport instead of stopping at the centred column's width. */
  function paintPageTint() {
    if (state.board) document.body.dataset.tint = boardColour(state.board)
    else delete document.body.dataset.tint
  }

  function render() {
    paintPageTint()

    // A render triggered by something other than this form — a picture
    // finishing its upload elsewhere, a realtime change — shouldn't throw
    // away an item being typed. Baked back in via `adderFor`; refocused below.
    const focusedForm = document.activeElement?.closest?.('[data-add-form]')
    const focusedDrawer = focusedForm?.dataset.drawer
    const caret = focusedDrawer ? document.activeElement.selectionStart : null

    if (state.status === 'missing') {
      root.innerHTML = `
        <section class="page">
          <header class="page-head">
            <div class="page-head-text">
              <button type="button" class="icon-btn" data-act="back" aria-label="Back" title="Back">${ICONS.back}</button>
              <div><h2 class="page-title">Board not found</h2></div>
            </div>
          </header>
          <div class="empty-state">
            <h3>That board isn't here</h3>
            <p>It may have been deleted, or the link is out of date.</p>
            <button type="button" class="btn btn-primary" data-act="back">Back home</button>
          </div>
        </section>
      `
      return
    }

    let body
    if (state.status === 'loading') {
      body = skeletons()
    } else if (state.status === 'error') {
      body = `
        <div class="banner banner-error">
          <p>${escapeHtml(state.error)}</p>
          <button type="button" class="btn btn-ghost btn-sm" data-act="retry">Try again</button>
        </div>
      `
    } else if (!state.drawers.length) {
      body = `
        <div class="empty-state">
          <h3>No drawers yet</h3>
          <p>A drawer is a column with a name and a shape — a tick list, a set of notes, or a gallery.</p>
          <button type="button" class="btn btn-primary" data-act="drawer-new">${ICONS.plus} New drawer</button>
        </div>
      `
    } else {
      const shown = state.focus
        ? state.drawers.filter((drawer) => drawer.id === state.focus)
        : state.drawers

      body = `
        <div class="drawers${state.focus ? ' is-focused' : ''}${state.board?.swipe_drawers ? ' is-swipe' : ''}" data-lane>
          ${shown.map((drawer) => drawerSection(drawer)).join('')}
        </div>
      `
    }

    const hasProjectBar = state.boards.length >= 2
    root.innerHTML = `<section class="page${state.busy ? ' is-busy' : ''}${hasProjectBar ? ' has-project-bar' : ''}">${head()}${body}</section>${projectBar()}${dropBar()}`
    hydrateNoteImages(root)
    dressNotes(root)

    const renaming = root.querySelector('[data-rename]')
    if (renaming) {
      renaming.focus()
      renaming.select()
    }

    if (focusedDrawer) {
      const input = root.querySelector(`[data-add-form][data-drawer="${focusedDrawer}"] input`)
      if (input) {
        input.focus()
        input.setSelectionRange(caret, caret)
      }
    }
  }

  /* ---------------------------------------------------------------
     Loading
     --------------------------------------------------------------- */

  async function load() {
    if (state.status !== 'ready') render()

    try {
      const [board, allDrawers, cards, boards] = await Promise.all([
        getBoard(boardId),
        listAllDrawers(),
        listCards(boardId),
        listBoards(),
      ])
      if (!alive) return

      if (!board || board.deleted_at) {
        state.status = 'missing'
        render()
        return
      }

      state.board = board
      state.allDrawers = allDrawers
      state.drawers = allDrawers.filter((drawer) => drawer.board_id === boardId)
      state.cards = cards
      state.boards = boards
      state.status = 'ready'
      // The drawer you were looking at on its own may have gone since.
      if (state.focus && !state.drawers.some((drawer) => drawer.id === state.focus)) {
        state.focus = null
      }
      paintBoardIcons()
    } catch (error) {
      if (!alive) return
      state.status = 'error'
      state.error = error?.message || 'Could not load this board.'
    }
    render()
  }

  /** Board icons, drawn straight into the header and the project bar's chips
   *  rather than hydrated afterwards like the pictures on the cards. Covers
   *  every project, not just this one, now that the project bar shows them
   *  all — `state.board` is included too in case it's archived and so
   *  missing from `state.boards`, which only lists active ones. */
  async function paintBoardIcons() {
    const paths = [state.board?.icon_path, ...state.boards.map((board) => board.icon_path)].filter(
      Boolean
    )
    if (!paths.length) return

    const links = await signImages(paths)
    if (!alive) return

    const isNew = paths.some((path) => links.get(path) !== state.images.get(path))
    state.images = links
    if (isNew) render()
  }

  /** Run a mutation, then reload. Errors surface in the banner. Reports
   *  whether it went through, which is what decides if an undo is offered. */
  async function mutate(fn) {
    if (state.busy) return false
    state.busy = true
    render()
    try {
      await fn()
      if (!alive) return false
      state.busy = false
      await load()
      return true
    } catch (error) {
      if (!alive) return false
      state.busy = false
      state.status = 'error'
      state.error = error?.message || 'That did not go through.'
      render()
      return false
    }
  }

  /** A change the eye has already seen: keep the optimistic render, and only
   *  reload if the database disagrees. */
  async function mutateQuietly(fn) {
    try {
      await fn()
    } catch (error) {
      if (!alive) return
      state.status = 'error'
      state.error = error?.message || 'That did not go through.'
      render()
    }
  }

  /* ---------------------------------------------------------------
     Actions
     --------------------------------------------------------------- */

  function cardById(id) {
    return state.cards.find((card) => card.id === id)
  }

  function drawerById(id) {
    return state.drawers.find((drawer) => drawer.id === id)
  }

  async function openCard(card, drawerId) {
    const kind = drawerById(card ? card.drawer_id : drawerId)?.kind
    const { changed } = await openNote({ ...(card ? { card } : { drawerId }), kind, onMove })
    if (changed && alive) await load()
  }

  async function onAddNote(drawerId) {
    await openCard(null, drawerId)
  }

  /**
   * A line typed into a tick list becomes the card's *note*, not its title.
   * Titles are for long notes that need a heading to be scannable; a to-do is
   * a line of text, and giving it a title as well would mean writing it twice.
   */
  async function onQuickAdd(drawerId, text) {
    if (!text.trim()) {
      clearDraft(`add-item:${drawerId}`)
      return
    }
    try {
      // Typed in passing, a link is still a link — and worth looking up, which
      // happens after the item is on the list so adding one stays instant.
      const made = await createCard(drawerId, { body_markdown: linkifyMarkdown(text.trim()) })
      if (!alive) return
      clearDraft(`add-item:${drawerId}`)
      await load()
      root.querySelector(`[data-add-form][data-drawer="${drawerId}"] input`)?.focus()
      addLinkPreviews(made).then((updated) => {
        if (updated && alive) load()
      })
    } catch (error) {
      if (!alive) return
      // Not thrown away — the field takes it back so the retry isn't a retype.
      setDraft(`add-item:${drawerId}`, text)
      state.status = 'error'
      state.error = error?.message || 'That did not go through.'
      render()
    }
  }

  /** Pictures dropped on a drawer, or chosen with its button: one card each,
   *  with the picture as the whole note. */
  async function addPictures(drawerId, files) {
    const pictures = [...files].filter((file) => looksLikeImage(file.type))
    if (!pictures.length || !drawerById(drawerId)) return

    await mutate(async () => {
      // One at a time: each card's position is read off the drawer as it goes
      // in, so uploading them in parallel would land them all on the same spot.
      for (const file of pictures) {
        const path = await uploadNoteImage(file)
        await createCard(drawerId, { body_markdown: `![](pensar-image/${path})` })
      }
    })
  }

  function onTick(id) {
    const card = cardById(id)
    if (!card) return
    card.done = !card.done
    render()
    mutateQuietly(() => setCardDone(id, card.done))
  }


  /** Filing a card into one particular drawer, offered from inside the note.
   *  It's the one thing a gesture can't do precisely: dropping a card on
   *  another project lands it in that project's first drawer, because a chip
   *  on the bar is all there is to aim at. */
  async function onMove(card) {
    const from = card.drawer_id
    const picked = await openMovePicker({
      boards: state.boards,
      drawers: state.allDrawers,
      currentDrawerId: from,
    })
    if (!picked || picked.drawerId === from) return false

    if (!(await mutate(() => moveCardToDrawer(card.id, picked.drawerId)))) return false
    offerUndo({
      message: 'Card moved',
      undo: () => mutate(() => moveCardToDrawer(card.id, from)),
    })
    return true
  }

  /** Copy a card's title and note as plain text. Flashes the button's icon to
   *  a checkmark as the only feedback — no clipboard permission means no
   *  visible change, which is fine since there's nothing to recover from. */
  async function onCopy(id, button) {
    const card = cardById(id)
    if (!card) return

    const text = [card.title.trim(), plainText(card.body_markdown)].filter(Boolean).join('\n\n')
    if (!text) return

    try {
      await navigator.clipboard.writeText(text)
    } catch {
      return
    }
    if (!alive || !button.isConnected) return

    const original = button.innerHTML
    button.classList.add('is-copied')
    button.innerHTML = ICONS.check
    setTimeout(() => {
      if (!button.isConnected) return
      button.classList.remove('is-copied')
      button.innerHTML = original
    }, 1200)
  }

  async function onArchive(id) {
    if (!(await mutate(() => archiveCard(id)))) return
    offerUndo({ message: 'Card archived', undo: () => mutate(() => unarchiveCard(id)) })
  }

  async function onTrashFromBar(id) {
    if (!(await mutate(() => trashCard(id)))) return
    offerUndo({ message: 'Card moved to the trash', undo: () => mutate(() => restoreCard(id)) })
  }

  async function onMerge(targetId, sourceId) {
    let receipt = null
    await mutate(async () => {
      receipt = await mergeCards(targetId, sourceId)
    })
    if (!receipt || !alive) return

    offerUndo({ message: 'Notes merged', undo: () => mutate(() => undoMerge(receipt)) })
  }

  /** The drawer a card dropped on another project should land in — its
   *  first one, made on the spot if that project somehow has none. Same
   *  rule as homeView.js's version of this, for a card filed from Home. */
  async function firstDrawerOf(targetBoardId) {
    const existing = state.allDrawers
      .filter((drawer) => drawer.board_id === targetBoardId)
      .sort((a, b) => a.position - b.position)[0]
    if (existing) return existing.id

    const created = await createDrawer(targetBoardId, FIRST_DRAWER)
    return created.id
  }

  async function onFileIntoBoard(id, targetBoardId) {
    const card = cardById(id)
    if (!card) return
    const from = card.drawer_id
    const target = state.boards.find((board) => board.id === targetBoardId)

    if (!(await mutate(async () => moveCardToDrawer(id, await firstDrawerOf(targetBoardId))))) {
      return
    }
    offerUndo({
      message: target ? `Filed into ${target.name}` : 'Card filed',
      undo: () => mutate(() => moveCardToDrawer(id, from)),
    })
  }

  async function onNewDrawer() {
    const fields = await openDrawerDialog()
    if (fields) await mutate(() => createDrawer(boardId, fields))
  }

  /** No dialog, same as a drawer's own shape icons — a tap flips it, since
   *  there's nothing here to confirm. */
  async function onToggleSwipeDrawers() {
    if (!state.board) return
    await mutate(() => setBoardSwipeDrawers(boardId, !state.board.swipe_drawers))
  }

  /** What the stylesheet draws a gallery at before anyone has zoomed it — the
   *  --gallery-cols fallbacks in style.css, kept in step by hand. */
  function defaultColumns(id) {
    return state.focus === id ? 4 : 2
  }

  /** A shape is a tap on one of the drawer's own icons — no dialog, since
   *  nothing about the cards inside it changes when the drawer does. Tapping
   *  the shape a drawer is already in does nothing, with one exception: a
   *  gallery steps its column count instead. That's this device's screen
   *  talking rather than the drawer, so it never goes near the database — and
   *  so it re-renders without the round trip `mutate` would cost. */
  async function onSetDrawerKind(id, kind) {
    const drawer = drawerById(id)
    if (!drawer) return

    if (drawer.kind === kind) {
      if (kind !== 'gallery') return
      setGalleryColumns(id, nextGalleryColumns(id, defaultColumns(id)))
      render()
      return
    }

    await mutate(() => updateDrawer(id, { kind }))
  }

  /** Deleting a drawer takes its cards with it — see drawers.js. Dropped on
   *  the delete bar rather than confirmed first, the same as everything else
   *  a gesture does — the undo builds the drawer again and lifts every card
   *  back out of the trash. */
  async function onDeleteDrawerFromBar(id) {
    const drawer = drawerById(id)
    if (!drawer) return

    const inside = cardsIn(id).map((card) => ({ id: card.id, position: card.position }))

    if (state.focus === id) state.focus = null
    clearDraft(`add-item:${id}`)
    forgetGalleryColumns(id)
    if (!(await mutate(() => deleteDrawer(id)))) return

    offerUndo({
      message: inside.length
        ? `“${drawer.name}” and ${plural(inside.length, 'card')} deleted`
        : `“${drawer.name}” deleted`,
      undo: () =>
        mutate(async () => {
          const made = await createDrawer(drawer.board_id, {
            name: drawer.name,
            kind: drawer.kind,
            position: drawer.position,
          })
          if (inside.length) {
            await restoreCards(inside.map((card) => ({ ...card, drawer_id: made.id })))
          }
        }),
    })
  }

  function onRenameDrawer(id) {
    if (!drawerById(id)) return
    state.renaming = id
    render()
  }

  /**
   * Put the name away and go back to showing it.
   *
   * The swap is done in place rather than by re-rendering the board, because
   * this runs on focusout: clicking a menu while a name is being typed has to
   * both save the name and open the menu, and a re-render underneath that
   * click would take the menu away before it opened.
   */
  function closeRename(input, name = null) {
    const id = input.dataset.rename
    if (state.renaming !== id) return
    state.renaming = null

    const drawer = drawerById(id)
    if (!drawer) {
      input.remove()
      return
    }

    const changed = name && name !== drawer.name
    if (changed) drawer.name = name // the eye has already seen it

    const holder = document.createElement('div')
    holder.innerHTML = drawerTitle(drawer)
    input.replaceWith(holder.firstElementChild)

    if (changed) mutateQuietly(() => updateDrawer(id, { name }))
  }

  function commitRename(input) {
    closeRename(input, input.value.trim())
  }

  async function onEditBoard() {
    const fields = await openBoardDialog({ board: state.board })
    if (!fields) {
      // The icon picture saves itself, so a cancel can still have changed one.
      await load()
      return
    }

    await mutate(async () => {
      if (fields.name !== state.board.name) await renameBoard(boardId, fields.name)
      await setBoardStyle(boardId, { colour: fields.colour, emoji: fields.emoji })
    })
  }

  async function onArchiveBoard() {
    const ok = await openConfirm({
      title: `Archive “${state.board.name}”?`,
      message: 'It leaves your board list but keeps its cards. You can restore it any time.',
      confirmLabel: 'Archive',
    })
    if (!ok) return
    await archiveBoard(boardId)
    location.hash = '#/'
  }

  async function onDeleteBoard() {
    const ok = await openConfirm({
      title: `Delete “${state.board.name}”?`,
      message: 'It moves to the trash rather than vanishing outright.',
      confirmLabel: 'Delete',
      destructive: true,
    })
    if (!ok) return
    await trashBoard(boardId)
    location.hash = '#/'
  }

  /* ---------------------------------------------------------------
     Menus
     --------------------------------------------------------------- */

  function closeMenus() {
    for (const trigger of root.querySelectorAll('.menu-trigger[aria-expanded="true"]')) {
      trigger.setAttribute('aria-expanded', 'false')
      trigger.nextElementSibling.hidden = true
    }
  }

  function toggleMenu(trigger) {
    const open = trigger.getAttribute('aria-expanded') === 'true'
    closeMenus()
    if (!open) {
      trigger.setAttribute('aria-expanded', 'true')
      trigger.nextElementSibling.hidden = false
    }
  }

  /* ---------------------------------------------------------------
     Dragging a card
     --------------------------------------------------------------- */

  function dropBarElement() {
    return root.querySelector('[data-drop-bar]')
  }

  /** Which bar zone the pointer is over, if any — the bar itself only shows
   *  while a card is actually in the air. */
  function zoneAt(x, y) {
    const bar = dropBarElement()
    if (!bar || bar.hidden) return null

    const rect = bar.getBoundingClientRect()
    if (y < rect.top || y > rect.bottom) return null

    for (const element of bar.querySelectorAll('[data-zone]:not([hidden])')) {
      const box = element.getBoundingClientRect()
      if (x >= box.left && x <= box.right) return element.dataset.zone
    }
    return null
  }

  /** Which of the bar's zones apply to what's being dragged right now — a
   *  drawer can only be deleted, never archived. */
  function setDropBarZones(zones) {
    const bar = dropBarElement()
    if (!bar) return
    for (const element of bar.querySelectorAll('[data-zone]')) {
      element.hidden = !zones.includes(element.dataset.zone)
    }
  }

  /** The project chip the pointer is over, if any — never the current
   *  project's own chip, which isn't a valid place to file a card into. */
  function projectChipAt(x, y) {
    if (!drag.isDragging()) return null

    for (const element of root.querySelectorAll('.project-chip[data-board]:not([data-current])')) {
      const rect = element.getBoundingClientRect()
      if (x >= rect.left && x <= rect.right && y >= rect.top && y <= rect.bottom) return element
    }
    return null
  }

  function setProjectTarget(next) {
    if (projectTarget === next) return
    projectTarget?.classList.remove('is-drop-target')
    projectTarget = next
    projectTarget?.classList.add('is-drop-target')
  }

  function setZone(next) {
    if (zone === next) return
    zone = next
    for (const element of root.querySelectorAll('[data-zone]')) {
      element.classList.toggle('is-armed', element.dataset.zone === zone)
    }
  }

  /** The card under the pointer, ignoring the one being dragged. */
  function cardAt(x, y, dragged) {
    for (const element of root.querySelectorAll('.card[data-card]')) {
      if (element === dragged) continue
      const rect = element.getBoundingClientRect()
      if (x >= rect.left && x <= rect.right && y >= rect.top && y <= rect.bottom) return element
    }
    return null
  }

  /** True when the pointer is over a card's middle rather than its edges —
   *  the edges are for slotting between cards, the middle is for merging. */
  function overMiddle(element, y) {
    const rect = element.getBoundingClientRect()
    const band = Math.min(Math.max(rect.height * 0.3, 12), 40)
    return y > rect.top + band && y < rect.bottom - band
  }

  function clearMerge() {
    clearTimeout(mergeTimer)
    mergeCandidate = null
    if (mergeTarget) mergeTarget.classList.remove('is-merge-target')
    mergeTarget = null
  }

  /** Hovering a card's middle arms a merge, but only once it's been held —
   *  passing over a card on the way somewhere else must not swallow it. */
  function considerMerge(element) {
    if (mergeCandidate === element) return
    clearMerge()
    mergeCandidate = element
    if (!element) return

    mergeTimer = setTimeout(() => {
      if (!drag.isDragging()) return
      mergeTarget = element
      element.classList.add('is-merge-target')
      navigator.vibrate?.(10)
    }, MERGE_DWELL_MS)
  }

  /** Hide the "nothing here yet" line in any drawer that now holds a card. */
  function syncEmptyHints() {
    for (const list of root.querySelectorAll('.drawer-cards')) {
      const hint = list.querySelector('.drawer-empty')
      if (hint) hint.hidden = Boolean(list.querySelector('.card'))
    }
  }

  /** The drawer nearest the pointer — inside one wins, otherwise the closest. */
  function nearestDrawer(x, y) {
    let best = null
    let bestDistance = Infinity

    for (const element of root.querySelectorAll('.drawer[data-drawer]')) {
      const rect = element.getBoundingClientRect()
      const dx = Math.max(rect.left - x, 0, x - rect.right)
      const dy = Math.max(rect.top - y, 0, y - rect.bottom)
      const distance = dx * dx + dy * dy
      if (distance < bestDistance) {
        bestDistance = distance
        best = element
      }
    }
    return best
  }

  /** Slot the dragged card into wherever the pointer is hovering. A gallery
   *  lays its cards out in masonry columns rather than a single stack, so
   *  "which card is this going before" is a question about both axes there. */
  function place(x, y, element) {
    const drawer = nearestDrawer(x, y)
    if (!drawer) return

    for (const other of root.querySelectorAll('.drawer')) {
      other.classList.toggle('is-dropping', other === drawer)
    }

    const list = drawer.querySelector('.drawer-cards')
    const siblings = [...list.querySelectorAll(':scope > .card')].filter((el) => el !== element)
    const masonry = drawer.dataset.kind === 'gallery'

    let before
    if (masonry) {
      let bestDistance = Infinity
      for (const el of siblings) {
        const rect = el.getBoundingClientRect()
        const cx = rect.left + rect.width / 2
        const cy = rect.top + rect.height / 2
        const distance = (x - cx) ** 2 + (y - cy) ** 2
        if (distance >= bestDistance) continue
        bestDistance = distance
        // Before the nearest card when the pointer is above or left of its
        // middle, after it otherwise.
        before = y < cy || (Math.abs(y - cy) < rect.height / 2 && x < cx) ? el : el.nextElementSibling
      }
      if (before && !before.classList?.contains('card')) before = undefined
    } else {
      before = siblings.find((el) => {
        const rect = el.getBoundingClientRect()
        return y < rect.top + rect.height / 2
      })
    }

    // Hovering the same gap on every pointer move must not re-run the move —
    // the cards would restart their slide dozens of times a second.
    const settled = before
      ? element.parentElement === list && element.nextElementSibling === before
      : element.parentElement === list && list.lastElementChild === element
    if (settled) return

    slideInto(
      root.querySelectorAll('.drawer-cards > .card'),
      () => {
        if (before) list.insertBefore(element, before)
        else list.append(element)
      },
      { skip: element }
    )

    syncEmptyHints()
  }

  /** Read the drawers back out of the DOM and persist whatever shifted. A
   *  tick list also finishes a task this way: dropped past the "Completed"
   *  divider, a card is done, same as tapping its tick box would leave it. */
  async function commitOrder() {
    const byId = new Map(state.cards.map((card) => [card.id, card]))
    const moves = []
    const doneChanges = []

    for (const drawer of root.querySelectorAll('.drawer[data-drawer]')) {
      const drawerId = drawer.dataset.drawer
      const isList = drawer.dataset.kind === 'list'
      const divider = drawer.querySelector('.list-divider')
      let pastDivider = false
      let position = 0

      for (const element of drawer.querySelectorAll('.drawer-cards > *')) {
        if (element === divider) {
          pastDivider = true
          continue
        }
        if (!element.matches('.card')) continue

        const card = byId.get(element.dataset.card)
        if (!card) continue

        if (card.drawer_id !== drawerId || card.position !== position) {
          moves.push({ id: card.id, drawer_id: drawerId, position })
        }
        if (isList && Boolean(card.done) !== pastDivider) {
          doneChanges.push({ id: card.id, done: pastDivider })
        }
        position++
      }
    }

    if (!moves.length && !doneChanges.length) {
      render()
      return
    }

    // Optimistic: the cards are already where the eye expects them.
    for (const move of moves) {
      const card = byId.get(move.id)
      card.drawer_id = move.drawer_id
      card.position = move.position
    }
    for (const change of doneChanges) {
      byId.get(change.id).done = change.done
    }
    render()
    await mutateQuietly(async () => {
      const tasks = doneChanges.map((change) => setCardDone(change.id, change.done))
      if (moves.length) tasks.push(saveOrder(moves))
      await Promise.all(tasks)
    })
  }

  const drag = createDragEngine({
    root,
    selector: '.card[data-drag]',
    // The card's face is a button so it can be reached from the keyboard; a
    // drag has to be able to start on it all the same. Only the controls down
    // the side, and the tick box, are off limits.
    blockSelector:
      '.card-actions, .card-tick, a, input, textarea, select, [contenteditable], [data-no-drag]',

    scroller: () => root.querySelector('[data-lane]'),

    onStart() {
      closeMenus()
      dismissUndo()
      setDropBarZones(['archive', 'delete'])
      const bar = dropBarElement()
      if (bar) bar.hidden = false
      // The project bar swells while a card is in the air — a chip the size of
      // a nav icon is a hard thing to drop onto. Only for a card: a drawer has
      // nowhere to land down there.
      root.querySelector('[data-project-bar]')?.classList.add('is-awaiting-drop')
    },

    onMove(x, y, element) {
      const nextZone = zoneAt(x, y)
      setZone(nextZone)
      if (nextZone) {
        considerMerge(null)
        setProjectTarget(null)
        return
      }

      const project = projectChipAt(x, y)
      setProjectTarget(project)
      if (project) {
        considerMerge(null)
        return
      }

      const over = cardAt(x, y, element)
      const merging = over && overMiddle(over, y)
      considerMerge(merging ? over : null)
      // Reordering while hovering a merge would slide the target out from
      // under the finger, so one at a time.
      if (merging) return

      place(x, y, element)
    },

    onDrop(element) {
      const droppedZone = zone
      const target = mergeTarget
      const project = projectTarget
      const id = element.dataset.card

      finishDrag()

      if (droppedZone === 'delete') onTrashFromBar(id)
      else if (droppedZone === 'archive') onArchive(id)
      else if (project) onFileIntoBoard(id, project.dataset.board)
      else if (target) onMerge(target.dataset.card, id)
      else commitOrder()
    },

    onCancel() {
      finishDrag()
      // The browser took the gesture back — put the DOM back the way it was.
      if (alive) render()
    },
  })

  function finishDrag() {
    clearMerge()
    setZone(null)
    setProjectTarget(null)
    const bar = dropBarElement()
    if (bar) bar.hidden = true
    root.querySelector('[data-project-bar]')?.classList.remove('is-awaiting-drop')
    for (const element of root.querySelectorAll('.drawer.is-dropping')) {
      element.classList.remove('is-dropping')
    }
  }

  /* ---------------------------------------------------------------
     Dragging a drawer
     --------------------------------------------------------------- */

  /** Move the dragged drawer to wherever the pointer has reached. Which axis
   *  decides is the same question the stylesheet answers at 48rem: a row of
   *  columns on a wide screen, a stack on a phone. */
  function placeDrawer(x, y, handle) {
    const lane = root.querySelector('[data-lane]')
    const moving = handle.closest('.drawer')
    if (!lane || !moving) return

    const stacked = window.matchMedia('(max-width: 48rem)').matches && !state.board?.swipe_drawers
    const others = [...lane.querySelectorAll(':scope > .drawer')].filter((el) => el !== moving)

    const before = others.find((el) => {
      const rect = el.getBoundingClientRect()
      return stacked ? y < rect.top + rect.height / 2 : x < rect.left + rect.width / 2
    })

    if (before) {
      if (moving.nextElementSibling === before) return
      slideInto(others, () => lane.insertBefore(moving, before), { skip: moving })
    } else if (lane.lastElementChild !== moving) {
      slideInto(others, () => lane.append(moving), { skip: moving })
    }
  }

  async function commitDrawerOrder() {
    const lane = root.querySelector('[data-lane]')
    if (!lane) return

    const ids = [...lane.querySelectorAll(':scope > .drawer[data-drawer]')].map(
      (element) => element.dataset.drawer
    )
    if (ids.every((id, index) => state.drawers[index]?.id === id)) {
      render()
      return
    }

    // Optimistic: they're already in the new order on screen.
    const byId = new Map(state.drawers.map((drawer) => [drawer.id, drawer]))
    state.drawers = ids.map((id, position) => {
      const drawer = byId.get(id)
      drawer.position = position
      return drawer
    })
    render()
    await mutateQuietly(() => saveDrawerOrder(ids))
  }

  const drawerDrag = createDragEngine({
    root,
    // Its header is the drawer's handle: everything below it belongs to the
    // cards, which have a drag of their own. The handle is left off while one
    // drawer is being looked at on its own — there's nothing to reorder it
    // against, and half a row of drawers must not be renumbered from what one
    // of them can see.
    selector: '.drawer-head[data-drawer-handle]',
    blockSelector: 'input, a, [data-no-drag]',
    scroller: () => root.querySelector('[data-lane]'),

    onStart(handle) {
      closeMenus()
      dismissUndo()
      setDropBarZones(['delete'])
      const bar = dropBarElement()
      if (bar) bar.hidden = false
      handle.closest('.drawer')?.classList.add('is-drawer-dragging')
    },

    onMove(x, y, handle) {
      const nextZone = zoneAt(x, y)
      setZone(nextZone)
      if (nextZone) return
      placeDrawer(x, y, handle)
    },

    onDrop(handle) {
      const droppedZone = zone
      const id = handle.closest('.drawer')?.dataset.drawer
      finishDrawerDrag(handle)

      if (droppedZone === 'delete') onDeleteDrawerFromBar(id)
      else commitDrawerOrder()
    },

    onCancel(handle) {
      finishDrawerDrag(handle)
      if (alive) render()
    },
  })

  function finishDrawerDrag(handle) {
    setZone(null)
    const bar = dropBarElement()
    if (bar) bar.hidden = true
    handle?.closest('.drawer')?.classList.remove('is-drawer-dragging')
    for (const element of root.querySelectorAll('.drawer.is-drawer-dragging')) {
      element.classList.remove('is-drawer-dragging')
    }
  }

  /* ---------------------------------------------------------------
     Swiping a card away

     The same archive the drop bar offers, with the whole gesture in the one
     hand holding the phone. Either direction, since a card has nothing else
     it could mean sideways — see swipe.js for how it stays out of the drag
     engine's way.
     --------------------------------------------------------------- */

  const swipe = createSwipeAway({
    root,
    selector: '.card[data-drag]',
    blockSelector:
      '.card-actions, .card-tick, a, input, textarea, select, [contenteditable], [data-no-drag]',
    isBlocked: () => state.busy || drag.isDragging() || drawerDrag.isDragging(),
    icon: ICONS.archive,
    label: 'Archive',
    onSwipe: (element) => onArchive(element.dataset.card),
  })

  /* ---------------------------------------------------------------
     Pictures dropped in from outside
     --------------------------------------------------------------- */

  function setFileTarget(next) {
    if (fileTarget === next) return
    fileTarget?.classList.remove('is-file-target')
    fileTarget = next
    fileTarget?.classList.add('is-file-target')
  }

  function carriesFiles(event) {
    return [...(event.dataTransfer?.types ?? [])].includes('Files')
  }

  function onDragOver(event) {
    if (!carriesFiles(event)) return
    event.preventDefault()
    event.dataTransfer.dropEffect = 'copy'
    setFileTarget(event.target.closest?.('.drawer[data-drawer]') ?? null)
  }

  function onDragLeave(event) {
    // Only when the pointer has actually left the page area, not on the way
    // between two elements inside it.
    if (!event.relatedTarget || !root.contains(event.relatedTarget)) setFileTarget(null)
  }

  function onFileDrop(event) {
    if (!carriesFiles(event)) return
    event.preventDefault()

    const drawer = event.target.closest?.('.drawer[data-drawer]') ?? fileTarget
    setFileTarget(null)
    if (!drawer) return

    addPictures(drawer.dataset.drawer, event.dataTransfer.files)
  }

  pictureInput.addEventListener('change', () => {
    const files = [...pictureInput.files]
    const drawerId = pictureDrawer
    pictureInput.value = ''
    pictureDrawer = null
    if (files.length && drawerId) addPictures(drawerId, files)
  })

  /* ---------------------------------------------------------------
     Wiring
     --------------------------------------------------------------- */

  function onSubmit(event) {
    const form = event.target.closest('[data-add-form]')
    if (!form) return
    event.preventDefault()
    const input = form.elements.title
    const text = input.value
    input.value = ''
    onQuickAdd(form.dataset.drawer, text)
  }

  function onInput(event) {
    const form = event.target.closest('[data-add-form]')
    if (form) setDraft(`add-item:${form.dataset.drawer}`, event.target.value)
  }

  function onClick(event) {
    // A click fires at the end of a drag; that isn't a tap on the card.
    if (drag.justDragged() || drawerDrag.justDragged() || swipe.justSwiped()) return

    // A picture inside a folded-out note opens full size; one inside a link
    // card is the link's own, and follows it.
    const image = event.target.closest('.card-note img')
    if (image && !image.closest('a')) {
      event.preventDefault()
      openLightbox({ src: image.currentSrc || image.src, alt: image.alt })
      return
    }

    const target = event.target.closest('[data-act]')
    if (!target || !root.contains(target)) {
      closeMenus()
      return
    }

    const { act, id, drawer, board } = target.dataset
    if (act !== 'menu') closeMenus()

    switch (act) {
      case 'add':
        onAddNote(drawer)
        break
      case 'add-pictures':
        pictureDrawer = drawer
        pictureInput.click()
        break
      case 'open':
        openCard(cardById(id))
        break
      case 'tick':
        onTick(id)
        break
      case 'copy':
        onCopy(id, target)
        break
      case 'menu':
        toggleMenu(target)
        break
      case 'drawer-new':
        onNewDrawer()
        break
      case 'drawer-swipe-toggle':
        onToggleSwipeDrawers()
        break
      case 'drawer-kind':
        onSetDrawerKind(drawer, target.dataset.kind)
        break
      case 'drawer-rename':
        onRenameDrawer(drawer)
        break
      case 'drawer-focus':
        state.focus = state.focus === drawer ? null : drawer
        render()
        break
      case 'drawer-expand-all': {
        const found = drawerById(drawer)
        if (!found) break
        const list = cardsIn(drawer)
        const crowded = list.length > CROWDED_AT
        const allOpen = list.every((card) => cardStartsOpen(card, { kind: found.kind, crowded }))
        for (const card of list) setCardFold(card.id, !allOpen)
        render()
        break
      }
      case 'drawer-unfocus':
        state.focus = null
        render()
        break
      case 'board-edit':
        onEditBoard()
        break
      case 'board-archive':
        onArchiveBoard()
        break
      case 'board-delete':
        onDeleteBoard()
        break
      case 'switch-board':
        location.hash = `#/board/${board}`
        break
      case 'back':
        location.hash = '#/'
        break
      case 'retry':
        load()
        break
    }
  }

  function onKeydown(event) {
    const renaming = event.target.closest?.('[data-rename]')
    if (renaming) {
      if (event.key === 'Enter') {
        event.preventDefault()
        commitRename(renaming)
      } else if (event.key === 'Escape') {
        event.preventDefault()
        closeRename(renaming)
      }
      return
    }

    if (event.key !== 'Escape') return
    closeMenus()
    if (state.focus) {
      state.focus = null
      render()
    }
  }

  /** Clicking away from a name being typed keeps it, the way closing a note
   *  saves it. */
  function onFocusOut(event) {
    const input = event.target.closest?.('[data-rename]')
    if (input) commitRename(input)
  }

  root.addEventListener('submit', onSubmit)
  root.addEventListener('input', onInput)
  root.addEventListener('focusout', onFocusOut)
  root.addEventListener('dragover', onDragOver)
  root.addEventListener('dragleave', onDragLeave)
  root.addEventListener('drop', onFileDrop)
  document.addEventListener('click', onClick)
  document.addEventListener('keydown', onKeydown)

  load()

  return function unmount() {
    alive = false
    clearMerge()
    dismissUndo()
    drag.destroy()
    drawerDrag.destroy()
    swipe.destroy()
    pictureInput.remove()
    delete document.body.dataset.tint
    root.removeEventListener('submit', onSubmit)
    root.removeEventListener('input', onInput)
    root.removeEventListener('focusout', onFocusOut)
    root.removeEventListener('dragover', onDragOver)
    root.removeEventListener('dragleave', onDragLeave)
    root.removeEventListener('drop', onFileDrop)
    document.removeEventListener('click', onClick)
    document.removeEventListener('keydown', onKeydown)
  }
}
