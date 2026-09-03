// Home: quick notes and projects on one screen.
//
// The Inbox used to be a page of its own and the boards another, which meant
// the two things you most often want to do together — jot something down, then
// decide which project it belongs to — were a navigation apart. They're now
// one screen, and filing a note is a drag from the top half to the bottom.
//
// Quick notes stay newest-first and aren't reorderable on purpose: this is a
// capture list, and the thing you just wrote belongs at the top. Dragging one
// is for filing it, folding it into another note, or throwing it away. With
// nothing waiting, the whole section goes away rather than sitting there as an
// empty box — the projects move up and the screen is about them instead.

import {
  listBoards,
  countArchivedBoards,
  createBoard,
  renameBoard,
  setBoardStyle,
  archiveBoard,
  restoreBoard,
  trashBoard,
  restoreTrashedBoard,
  saveBoardOrder,
} from './boards'
import { listAllDrawers, createDrawer, FIRST_DRAWER } from './drawers'
import {
  listQuickNotes,
  countCardsByBoard,
  createQuickNote,
  archiveCard,
  unarchiveCard,
  trashCard,
  restoreCard,
  moveCardToDrawer,
  mergeCards,
  undoMerge,
} from './cards'
import { openBoardDialog, openConfirm, openMovePicker } from './dialogs'
import { openNote } from './noteEditor'
import { openLightbox } from './lightbox'
import { renderCard, cardStartsOpen, dressNotes, CROWDED_AT } from './cardTile'
import { renderBoardGlyph } from './boardStyle'
import { createDragEngine } from './drag'
import { slideInto } from './flip'
import { signImages } from './images'
import { hydrateNoteImages, plainText } from './markdown'
import { setCardFold } from './openCards'
import { draft, setDraft, clearDraft } from './drafts'
import { takeSharedNotes } from './share'
import { offerUndo, dismissUndo } from './undo'
import { escapeHtml, plural } from './format'
import { supabase } from './supabaseClient'
import { cycleTheme, paintThemeButton } from './theme'
import { installAvailable, onInstallAvailabilityChange, promptInstall } from './installPrompt'
import {
  remindersSupported,
  remindersPermission,
  remindersEnabled,
  remindersBusy,
  enableReminders,
  disableReminders,
  onReminderStateChange,
  refreshReminderState,
} from './push'

const ICONS = {
  plus: `<svg viewBox="0 0 24 24" aria-hidden="true"><path d="M12 5.5v13M5.5 12h13"/></svg>`,
  more: `<svg viewBox="0 0 24 24" aria-hidden="true"><circle cx="5.5" cy="12" r="1.35" fill="currentColor" stroke="none"/><circle cx="12" cy="12" r="1.35" fill="currentColor" stroke="none"/><circle cx="18.5" cy="12" r="1.35" fill="currentColor" stroke="none"/></svg>`,
  note: `<svg viewBox="0 0 24 24" aria-hidden="true"><path d="M5 4.5h14v15H5zM8.5 9h7M8.5 12.5h7M8.5 16h4"/></svg>`,
  archive: `<svg viewBox="0 0 24 24" aria-hidden="true"><rect x="3" y="4.5" width="18" height="4" rx="1.2"/><path d="M4.75 8.5v9.25a1.75 1.75 0 0 0 1.75 1.75h11a1.75 1.75 0 0 0 1.75-1.75V8.5M10 12.5h4"/></svg>`,
  trash: `<svg viewBox="0 0 24 24" aria-hidden="true"><path d="M5 7h14M9.5 7V5.2A1.2 1.2 0 0 1 10.7 4h2.6a1.2 1.2 0 0 1 1.2 1.2V7M7.5 7l.7 11.3A1.7 1.7 0 0 0 9.9 20h4.2a1.7 1.7 0 0 0 1.7-1.7L16.5 7M10.3 10.5v6M13.7 10.5v6"/></svg>`,
  check: `<svg viewBox="0 0 24 24" aria-hidden="true"><path d="M5 12.5l4.5 4.5L19 7"/></svg>`,
  bell: `<svg viewBox="0 0 24 24" aria-hidden="true"><path d="M6 17h12M7 17v-5.5a5 5 0 0 1 10 0V17M10.5 20a1.7 1.7 0 0 0 3 0"/></svg>`,
  // Chevrons apart and together: every quick note folded out, or away. The
  // same pair the board's drawers use.
  unfold: `<svg viewBox="0 0 24 24" aria-hidden="true"><path d="M8 10.5 12 6.5l4 4M8 13.5l4 4 4-4"/></svg>`,
  fold: `<svg viewBox="0 0 24 24" aria-hidden="true"><path d="M8 6.5 12 10.5l4-4M8 17.5l4-4 4 4"/></svg>`,
}

/** How long a card has to be held over another before the two would merge. */
const MERGE_DWELL_MS = 520

/**
 * Render the home screen into `root`. Returns an unmount function — call it
 * before replacing `root`'s contents.
 *
 * `autoFocus` jumps the cursor straight into the capture field once loaded —
 * used by the "New note" home-screen shortcut on Android.
 */
export function mountHome(root, { autoFocus = false } = {}) {
  const state = {
    notes: [],
    boards: [],
    drawers: [],
    counts: new Map(), // board_id → live card count
    archivedCount: 0,
    images: new Map(), // storage path → signed URL
    status: 'loading', // loading | ready | error
    error: '',
    notice: '', // something went wrong beside the main load, not instead of it
    busy: false, // an action is in flight; blocks double-taps
  }

  let alive = true
  let autoFocusPending = autoFocus

  // Drag bookkeeping: the bar zone, the board tile, or the note under the
  // pointer — whichever the dragged note would land on right now.
  let zone = null
  let boardTarget = null
  let mergeTarget = null
  let mergeCandidate = null
  let mergeTimer = null

  /* ---------------------------------------------------------------
     Markup
     --------------------------------------------------------------- */

  function boardTile(board) {
    const count = state.counts.get(board.id) ?? 0

    return `
      <article
        class="board-tile"
        data-board="${board.id}"
        data-tint="${escapeHtml(board.colour ?? 'teal')}"
        tabindex="0"
        role="button"
        aria-label="Open ${escapeHtml(board.name)}"
        data-act="open-board"
        data-id="${board.id}"
      >
        ${renderBoardGlyph(board, state.images)}
        <div class="board-tile-text">
          <h3 class="board-name">${escapeHtml(board.name)}</h3>
          <p class="board-meta">${count ? plural(count, 'card') : 'Nothing in it yet'}</p>
        </div>
        <div class="menu">
          <button
            type="button"
            class="icon-btn icon-btn-sm menu-trigger"
            data-act="menu"
            aria-haspopup="true"
            aria-expanded="false"
            aria-label="Project actions"
            title="Project actions"
          >${ICONS.more}</button>
          <div class="menu-list" hidden>
            <button type="button" data-act="board-edit" data-id="${board.id}">Name, colour &amp; icon…</button>
            <button type="button" data-act="board-archive" data-id="${board.id}">Archive</button>
            <button type="button" class="menu-danger" data-act="board-delete" data-id="${board.id}">Delete</button>
          </div>
        </div>
      </article>
    `
  }

  /** Nothing waiting means nothing to draw: no header, no count, no empty box.
   *  The capture field above is how a quick note appears in the first place. */
  function quickNotes() {
    if (!state.notes.length) return ''

    const crowded = state.notes.length > CROWDED_AT

    // Quick notes is a drawer in everything but name, and folding is the same
    // decision here as it is there: one control over the lot, rather than a
    // chevron on every card getting in the way of the words.
    const allOpen = state.notes.every((card) => cardStartsOpen(card, { crowded }))

    return `
      <section class="home-section">
        <header class="section-head">
          <h3 class="section-title">Quick notes</h3>
          <span class="section-count">${state.notes.length}</span>
          <button
            type="button"
            class="icon-btn icon-btn-sm"
            data-act="notes-expand-all"
            aria-pressed="${String(allOpen)}"
            aria-label="${allOpen ? 'Collapse every note' : 'Expand every note'}"
            title="${allOpen ? 'Collapse every note' : 'Expand every note'}"
          >${allOpen ? ICONS.fold : ICONS.unfold}</button>
        </header>
        <div class="quick-notes" data-cards>
          ${state.notes
            .map((card) =>
              renderCard(card, { kind: 'notes', expanded: cardStartsOpen(card, { crowded }) })
            )
            .join('')}
        </div>
      </section>
    `
  }

  function projects() {
    if (!state.boards.length) {
      return `
        <p class="section-empty">
          No projects yet. A project holds drawers — a tick list, some notes, a gallery.
        </p>
      `
    }
    return `<div class="board-grid" data-boards>${state.boards.map(boardTile).join('')}</div>`
  }

  function skeletons() {
    return `
      <div class="quick-notes">${'<div class="card card-skeleton"></div>'.repeat(2)}</div>
      <div class="board-grid">${'<div class="board-tile board-tile-skeleton"></div>'.repeat(2)}</div>
    `
  }

  function dropBar() {
    return `
      <div class="drop-bar" data-drop-bar hidden aria-hidden="true">
        <div class="drop-zone" data-zone="archive">${ICONS.archive}<span>Archive</span></div>
        <div class="drop-zone drop-zone-danger" data-zone="delete">${ICONS.trash}<span>Delete</span></div>
      </div>
    `
  }

  function render() {
    // A render can be triggered by something that has nothing to do with what
    // the user's typing (an install prompt, a permission flip, an icon
    // finishing its sign-in), and this form gets rebuilt along with the rest
    // of the page. Baking the draft back in — and refocusing below if this
    // field was the one being typed into — keeps that keystroke from vanishing.
    const hadFocus = document.activeElement?.id === 'quick-capture'
    const caret = hadFocus ? document.activeElement.selectionStart : null

    const capture = `
      <form class="quick-add">
        <input
          id="quick-capture"
          class="quick-add-input"
          type="text"
          name="title"
          autocomplete="off"
          maxlength="200"
          placeholder="Capture something…"
          value="${escapeHtml(draft('quick-capture'))}"
        />
        <button type="button" class="icon-btn" data-act="new-note" aria-label="Write a full note" title="Write a full note">
          ${ICONS.note}
        </button>
        <button type="submit" class="icon-btn quick-add-submit" aria-label="Add to quick notes" title="Add to quick notes">
          ${ICONS.plus}
        </button>
      </form>
    `

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
    } else {
      body = `
        ${
          state.notice
            ? `<div class="banner banner-error"><p>${escapeHtml(state.notice)}</p></div>`
            : ''
        }
        ${quickNotes()}

        <section class="home-section">
          <header class="section-head">
            <h3 class="section-title">Projects</h3>
            <span class="section-count">${state.boards.length}</span>
            <button type="button" class="btn btn-ghost btn-sm" data-act="board-new">${ICONS.plus} New</button>
          </header>
          ${projects()}
        </section>
      `
    }

    const foot = state.status === 'ready' ? utilityFoot() : ''

    root.innerHTML = `<section class="page${state.busy ? ' is-busy' : ''}">${capture}${body}${foot}</section>${dropBar()}`
    hydrateNoteImages(root)
    dressNotes(root)
    const themeButton = root.querySelector('#theme-toggle')
    if (themeButton) paintThemeButton(themeButton)

    if (hadFocus) {
      const input = root.querySelector('#quick-capture')
      if (input) {
        input.focus()
        input.setSelectionRange(caret, caret)
      }
    }
  }

  /** What the reminders button says — busy while a request is in flight,
   *  "blocked" rather than an action once the browser has said no for good,
   *  otherwise which way a tap would flip it. */
  function reminderLabel() {
    if (remindersBusy()) return 'Reminders…'
    if (remindersPermission() === 'denied') return 'Reminders blocked'
    return remindersEnabled() ? 'Reminders on' : 'Enable reminders'
  }

  /** No top header any more (see main.js) — this is where Trash, the theme
   *  toggle, install and logout live instead: a quiet row at the foot of
   *  Home rather than a bar over every screen. */
  function utilityFoot() {
    return `
      <footer class="home-foot">
        <div class="home-foot-row">
          ${
            state.archivedCount > 0
              ? `<button type="button" class="link-btn" data-act="show-archived">
                   ${ICONS.archive} Archived projects (${state.archivedCount})
                 </button>`
              : ''
          }
          <button type="button" class="link-btn" data-act="show-trash">${ICONS.trash} Trash</button>
        </div>
        <div class="home-foot-row">
          ${
            remindersSupported()
              ? `<button
                   type="button"
                   class="link-btn"
                   data-act="reminders-toggle"
                   ${remindersBusy() ? 'disabled' : ''}
                   aria-pressed="${String(remindersEnabled())}"
                 >${ICONS.bell} ${reminderLabel()}</button>`
              : ''
          }
          ${
            installAvailable()
              ? `<button type="button" class="link-btn" data-act="install-app">Install</button>`
              : ''
          }
          <button type="button" class="icon-btn icon-btn-sm" id="theme-toggle" data-act="theme-toggle"></button>
          <button type="button" class="link-btn" data-act="logout">Log out</button>
        </div>
      </footer>
    `
  }

  /* ---------------------------------------------------------------
     Loading
     --------------------------------------------------------------- */

  async function load() {
    if (state.status !== 'ready') render()

    // Anything the phone shared into pensar lands in Quick notes, and has to
    // be written before the list below is read or it wouldn't be in it.
    state.notice = ''
    try {
      await takeSharedNotes()
    } catch (error) {
      // The share is kept for the next try rather than dropped on the floor.
      state.notice = error?.message || 'What you shared could not be saved yet.'
    }

    try {
      const [notes, boards, drawers, counts, archivedCount] = await Promise.all([
        listQuickNotes(),
        listBoards(),
        listAllDrawers(),
        countCardsByBoard(),
        countArchivedBoards(),
      ])
      if (!alive) return

      state.notes = notes
      state.boards = boards
      state.drawers = drawers
      state.counts = counts
      state.archivedCount = archivedCount
      state.status = 'ready'
      paintBoardIcons()
    } catch (error) {
      if (!alive) return
      state.status = 'error'
      state.error = error?.message || 'Could not load your notes.'
    }
    render()

    if (autoFocusPending && state.status === 'ready') {
      autoFocusPending = false
      focusCapture()
    }
  }

  /** The project icons, which are drawn straight into the tiles rather than
   *  hydrated afterwards like the pictures on the cards. */
  async function paintBoardIcons() {
    const paths = state.boards.map((board) => board.icon_path).filter(Boolean)
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

  function focusCapture() {
    root.querySelector('#quick-capture')?.focus()
  }

  function noteById(id) {
    return state.notes.find((card) => card.id === id)
  }

  function boardById(id) {
    return state.boards.find((board) => board.id === id)
  }

  /** A captured line is the note itself, not a title for one. Titles are for
   *  long notes that need a heading to stay scannable. */
  async function onCapture(rawText) {
    const text = rawText.trim()
    if (!text || state.busy) {
      if (!text) clearDraft('quick-capture')
      return
    }

    try {
      await createQuickNote(text)
      if (!alive) return
      clearDraft('quick-capture')
      await load()
      focusCapture()
    } catch (error) {
      if (!alive) return
      // Not thrown away — the field takes it back so the retry isn't a retype.
      setDraft('quick-capture', text)
      state.status = 'error'
      state.error = error?.message || 'That did not go through.'
      render()
    }
  }

  async function openCard(card) {
    const { changed } = await openNote({ ...(card ? { card } : { drawerId: null }), onMove })
    if (changed && alive) await load()
  }


  /** Filing a quick note into a drawer, offered from inside the note. Dragging
   *  it onto a project does the same thing roughly — that lands it in the
   *  project's first drawer — and this is how to say which drawer. */
  async function onMove(card) {
    const from = card.drawer_id
    const picked = await openMovePicker({
      boards: state.boards,
      drawers: state.drawers,
      currentDrawerId: from,
    })
    if (!picked || picked.drawerId === from) return false

    if (!(await mutate(() => moveCardToDrawer(card.id, picked.drawerId)))) return false
    offerUndo({
      message: 'Note filed',
      undo: () => mutate(() => moveCardToDrawer(card.id, from)),
    })
    return true
  }

  async function onCopy(id, button) {
    const card = noteById(id)
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
    offerUndo({ message: 'Note archived', undo: () => mutate(() => unarchiveCard(id)) })
  }

  async function onTrashFromBar(id) {
    if (!(await mutate(() => trashCard(id)))) return
    offerUndo({ message: 'Note moved to the trash', undo: () => mutate(() => restoreCard(id)) })
  }

  async function onMerge(targetId, sourceId) {
    let receipt = null
    await mutate(async () => {
      receipt = await mergeCards(targetId, sourceId)
    })
    if (!receipt || !alive) return

    offerUndo({ message: 'Notes merged', undo: () => mutate(() => undoMerge(receipt)) })
  }

  async function onFileIntoBoard(id, boardId) {
    const board = boardById(boardId)
    if (!(await mutate(async () => moveCardToDrawer(id, await firstDrawerOf(boardId))))) return
    offerUndo({
      message: board ? `Filed into ${board.name}` : 'Note filed',
      undo: () => mutate(() => moveCardToDrawer(id, null)),
    })
  }

  /** The drawer a note dropped on this project should land in — its first one,
   *  made on the spot if the project somehow has none. */
  async function firstDrawerOf(boardId) {
    const existing = state.drawers
      .filter((drawer) => drawer.board_id === boardId)
      .sort((a, b) => a.position - b.position)[0]
    if (existing) return existing.id

    const created = await createDrawer(boardId, FIRST_DRAWER)
    return created.id
  }

  async function onNewBoard() {
    const fields = await openBoardDialog()
    if (fields) {
      await mutate(() =>
        createBoard(fields.name, { colour: fields.colour, emoji: fields.emoji })
      )
    }
  }

  async function onEditBoard(id) {
    const board = boardById(id)
    if (!board) return

    const fields = await openBoardDialog({ board })
    if (!fields) {
      // The icon picture saves itself, so a cancel can still have changed one.
      await load()
      return
    }

    await mutate(async () => {
      if (fields.name !== board.name) await renameBoard(id, fields.name)
      await setBoardStyle(id, { colour: fields.colour, emoji: fields.emoji })
    })
  }

  async function onArchiveBoard(id) {
    const board = boardById(id)
    if (!board) return

    const ok = await openConfirm({
      title: `Archive “${board.name}”?`,
      message: 'It leaves your projects but keeps its cards. You can restore it any time.',
      confirmLabel: 'Archive',
    })
    if (ok) await mutate(() => archiveBoard(id))
  }

  async function onDeleteBoard(id) {
    const board = boardById(id)
    if (!board) return

    const ok = await openConfirm({
      title: `Delete “${board.name}”?`,
      message: 'It moves to the trash rather than vanishing outright.',
      confirmLabel: 'Delete',
      destructive: true,
    })
    if (ok) await mutate(() => trashBoard(id))
  }

  /** Dropped a project on the bar along the bottom — a gesture, so it goes
   *  straight through and leaves an undo behind rather than asking first. */
  async function onArchiveBoardFromBar(id) {
    const board = boardById(id)
    if (!(await mutate(() => archiveBoard(id)))) return
    offerUndo({
      message: board ? `“${board.name}” archived` : 'Project archived',
      undo: () => mutate(() => restoreBoard(id)),
    })
  }

  async function onTrashBoardFromBar(id) {
    const board = boardById(id)
    if (!(await mutate(() => trashBoard(id)))) return
    offerUndo({
      message: board ? `“${board.name}” deleted` : 'Project deleted',
      undo: () => mutate(() => restoreTrashedBoard(id)),
    })
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
     Dragging a quick note somewhere
     --------------------------------------------------------------- */

  function dropBarElement() {
    return root.querySelector('[data-drop-bar]')
  }

  function zoneAt(x, y) {
    const bar = dropBarElement()
    if (!bar || bar.hidden) return null

    const rect = bar.getBoundingClientRect()
    if (y < rect.top || y > rect.bottom) return null

    for (const element of bar.querySelectorAll('[data-zone]')) {
      const box = element.getBoundingClientRect()
      if (x >= box.left && x <= box.right) return element.dataset.zone
    }
    return null
  }

  function setZone(next) {
    if (zone === next) return
    zone = next
    for (const element of root.querySelectorAll('[data-zone]')) {
      element.classList.toggle('is-armed', element.dataset.zone === zone)
    }
  }

  function hitAt(selector, x, y, skip = null) {
    for (const element of root.querySelectorAll(selector)) {
      if (element === skip) continue
      const rect = element.getBoundingClientRect()
      if (x >= rect.left && x <= rect.right && y >= rect.top && y <= rect.bottom) return element
    }
    return null
  }

  function setBoardTarget(next) {
    if (boardTarget === next) return
    boardTarget?.classList.remove('is-drop-target')
    boardTarget = next
    boardTarget?.classList.add('is-drop-target')
  }

  function clearMerge() {
    clearTimeout(mergeTimer)
    mergeCandidate = null
    if (mergeTarget) mergeTarget.classList.remove('is-merge-target')
    mergeTarget = null
  }

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

  const drag = createDragEngine({
    root,
    selector: '.card[data-drag]',
    blockSelector:
      '.card-actions, .card-tick, a, input, textarea, select, [contenteditable], [data-no-drag]',

    onStart() {
      closeMenus()
      dismissUndo()
      const bar = dropBarElement()
      if (bar) bar.hidden = false
      root.querySelector('[data-boards]')?.classList.add('is-awaiting-drop')
    },

    onMove(x, y, element) {
      const nextZone = zoneAt(x, y)
      setZone(nextZone)
      if (nextZone) {
        setBoardTarget(null)
        considerMerge(null)
        return
      }

      const board = hitAt('.board-tile[data-board]', x, y)
      setBoardTarget(board)
      if (board) {
        considerMerge(null)
        return
      }

      considerMerge(hitAt('.card[data-card]', x, y, element))
    },

    onDrop(element) {
      const droppedZone = zone
      const board = boardTarget
      const target = mergeTarget
      const id = element.dataset.card

      finishDrag()

      if (droppedZone === 'delete') onTrashFromBar(id)
      else if (droppedZone === 'archive') onArchive(id)
      else if (board) onFileIntoBoard(id, board.dataset.board)
      else if (target) onMerge(target.dataset.card, id)
    },

    onCancel() {
      finishDrag()
    },
  })

  function finishDrag() {
    clearMerge()
    setZone(null)
    setBoardTarget(null)
    const bar = dropBarElement()
    if (bar) bar.hidden = true
    root.querySelector('[data-boards]')?.classList.remove('is-awaiting-drop')
  }

  /* ---------------------------------------------------------------
     Dragging a project tile — reorders the grid, or drops it on the bar to
     archive or delete it. A project's own drag, distinct from a note's: the
     two never run at once, so they can share the drop bar and its zones.
     --------------------------------------------------------------- */

  /** Slot the dragged tile in wherever the pointer is, by nearest centre —
   *  the grid wraps to a new row on a wide screen, so "before/after" is a
   *  two-axis question the same way a gallery's masonry is in boardView.js. */
  function placeBoard(x, y, element) {
    const grid = root.querySelector('[data-boards]')
    if (!grid) return

    const siblings = [...grid.querySelectorAll(':scope > .board-tile')].filter((el) => el !== element)

    let before
    let bestDistance = Infinity
    for (const el of siblings) {
      const rect = el.getBoundingClientRect()
      const cx = rect.left + rect.width / 2
      const cy = rect.top + rect.height / 2
      const distance = (x - cx) ** 2 + (y - cy) ** 2
      if (distance >= bestDistance) continue
      bestDistance = distance
      before = y < cy || (Math.abs(y - cy) < rect.height / 2 && x < cx) ? el : el.nextElementSibling
    }
    if (before && !before.classList?.contains('board-tile')) before = undefined

    // Same gap as last time means nothing to do — otherwise the tiles would
    // restart their slide on every pointer move.
    const settled = before ? element.nextElementSibling === before : grid.lastElementChild === element
    if (settled) return

    slideInto(
      siblings,
      () => {
        if (before) grid.insertBefore(element, before)
        else grid.append(element)
      },
      { skip: element }
    )
  }

  /** Read the grid back out of the DOM and persist whatever shifted. */
  async function commitBoardOrder() {
    const grid = root.querySelector('[data-boards]')
    if (!grid) return

    const ids = [...grid.querySelectorAll(':scope > .board-tile[data-board]')].map(
      (element) => element.dataset.board
    )
    if (ids.every((id, index) => state.boards[index]?.id === id)) {
      render()
      return
    }

    // Optimistic: the tiles are already where the eye expects them.
    const byId = new Map(state.boards.map((board) => [board.id, board]))
    state.boards = ids.map((id) => byId.get(id)).filter(Boolean)
    render()
    await mutateQuietly(() => saveBoardOrder(ids))
  }

  const boardDrag = createDragEngine({
    root,
    selector: '.board-tile[data-board]',
    blockSelector: '.menu, [data-no-drag]',

    onStart() {
      closeMenus()
      dismissUndo()
      const bar = dropBarElement()
      if (bar) bar.hidden = false
    },

    onMove(x, y, element) {
      const nextZone = zoneAt(x, y)
      setZone(nextZone)
      if (nextZone) return
      placeBoard(x, y, element)
    },

    onDrop(element) {
      const droppedZone = zone
      const id = element.dataset.board

      finishDrag()

      if (droppedZone === 'delete') onTrashBoardFromBar(id)
      else if (droppedZone === 'archive') onArchiveBoardFromBar(id)
      else commitBoardOrder()
    },

    onCancel() {
      finishDrag()
      if (alive) render()
    },
  })

  /* ---------------------------------------------------------------
     Wiring
     --------------------------------------------------------------- */

  function onSubmit(event) {
    const form = event.target.closest('.quick-add')
    if (!form) return
    event.preventDefault()
    const input = form.elements.title
    const text = input.value
    input.value = ''
    onCapture(text)
  }

  function onInput(event) {
    if (event.target.id === 'quick-capture') setDraft('quick-capture', event.target.value)
  }

  function onClick(event) {
    if (drag.justDragged() || boardDrag.justDragged()) return

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

    const { act, id } = target.dataset
    if (act !== 'menu') closeMenus()

    switch (act) {
      case 'new-note':
        openCard(null)
        break
      case 'open':
        openCard(noteById(id))
        break
      case 'copy':
        onCopy(id, target)
        break
      case 'notes-expand-all': {
        const crowded = state.notes.length > CROWDED_AT
        const allOpen = state.notes.every((card) => cardStartsOpen(card, { crowded }))
        for (const card of state.notes) setCardFold(card.id, !allOpen)
        render()
        break
      }
      case 'menu':
        toggleMenu(target)
        break
      case 'open-board':
        location.hash = `#/board/${id}`
        break
      case 'board-new':
        onNewBoard()
        break
      case 'board-edit':
        onEditBoard(id)
        break
      case 'board-archive':
        onArchiveBoard(id)
        break
      case 'board-delete':
        onDeleteBoard(id)
        break
      case 'show-archived':
        location.hash = '#/archived'
        break
      case 'show-trash':
        location.hash = '#/trash'
        break
      case 'theme-toggle':
        cycleTheme()
        render()
        break
      case 'install-app':
        promptInstall()
        break
      case 'reminders-toggle':
        if (remindersEnabled()) disableReminders()
        else enableReminders()
        break
      case 'logout':
        supabase.auth.signOut()
        break
      case 'retry':
        load()
        break
    }
  }

  function onKeydown(event) {
    if (event.key === 'Escape') {
      closeMenus()
      return
    }

    // The project tile carries its own "open" action — Enter and Space should
    // work on it the way they do on a button.
    if ((event.key === 'Enter' || event.key === ' ') && event.target.matches('.board-tile')) {
      event.preventDefault()
      event.target.click()
    }
  }

  root.addEventListener('submit', onSubmit)
  root.addEventListener('input', onInput)
  document.addEventListener('click', onClick)
  document.addEventListener('keydown', onKeydown)

  // The install prompt can become available (or get taken) at any point,
  // independent of anything Home itself did — see installPrompt.js.
  const stopWatchingInstall = onInstallAvailabilityChange(() => {
    if (state.status === 'ready') render()
  })

  // Same idea for reminders: enabling/disabling is a round trip through the
  // service worker and the database, and permission can also change from
  // outside the app entirely (the phone's own Settings).
  const stopWatchingReminders = onReminderStateChange(() => {
    if (state.status === 'ready') render()
  })
  refreshReminderState()

  load()

  return function unmount() {
    alive = false
    clearMerge()
    dismissUndo()
    drag.destroy()
    boardDrag.destroy()
    stopWatchingInstall()
    stopWatchingReminders()
    root.removeEventListener('submit', onSubmit)
    root.removeEventListener('input', onInput)
    document.removeEventListener('click', onClick)
    document.removeEventListener('keydown', onKeydown)
  }
}
