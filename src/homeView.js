// Home: quick notes and projects on one screen.
//
// The Inbox used to be a page of its own and the boards another, which meant
// the two things you most often want to do together — jot something down, then
// decide which project it belongs to — were a navigation apart. They're now
// one screen, and filing a note is a drag from the top half to the bottom.
//
// Quick notes stay newest-first and aren't reorderable on purpose: this is a
// capture list, and the thing you just wrote belongs at the top. Dragging one
// is for filing it, folding it into another note, or throwing it away.

import {
  listBoards,
  countArchivedBoards,
  createBoard,
  renameBoard,
  setBoardStyle,
  archiveBoard,
  trashBoard,
} from './boards'
import { listAllDrawers, createDrawer, FIRST_DRAWER } from './drawers'
import {
  listQuickNotes,
  countCardsByBoard,
  createQuickNote,
  archiveCard,
  trashCard,
  moveCardToDrawer,
  mergeCards,
} from './cards'
import { openBoardDialog, openConfirm, openMovePicker } from './dialogs'
import { openNote } from './noteEditor'
import { openLightbox } from './lightbox'
import { renderCard, cardHeading, dressNotes } from './cardTile'
import { renderBoardGlyph } from './boardStyle'
import { createDragEngine } from './drag'
import { signImages } from './images'
import { hydrateNoteImages, plainText } from './markdown'
import { isCardOpen, toggleCardOpen } from './openCards'
import { escapeHtml, plural } from './format'

const ICONS = {
  plus: `<svg viewBox="0 0 24 24" aria-hidden="true"><path d="M12 5.5v13M5.5 12h13"/></svg>`,
  more: `<svg viewBox="0 0 24 24" aria-hidden="true"><circle cx="5.5" cy="12" r="1.35" fill="currentColor" stroke="none"/><circle cx="12" cy="12" r="1.35" fill="currentColor" stroke="none"/><circle cx="18.5" cy="12" r="1.35" fill="currentColor" stroke="none"/></svg>`,
  note: `<svg viewBox="0 0 24 24" aria-hidden="true"><path d="M5 4.5h14v15H5zM8.5 9h7M8.5 12.5h7M8.5 16h4"/></svg>`,
  archive: `<svg viewBox="0 0 24 24" aria-hidden="true"><rect x="3" y="4.5" width="18" height="4" rx="1.2"/><path d="M4.75 8.5v9.25a1.75 1.75 0 0 0 1.75 1.75h11a1.75 1.75 0 0 0 1.75-1.75V8.5M10 12.5h4"/></svg>`,
  trash: `<svg viewBox="0 0 24 24" aria-hidden="true"><path d="M5 7h14M9.5 7V5.2A1.2 1.2 0 0 1 10.7 4h2.6a1.2 1.2 0 0 1 1.2 1.2V7M7.5 7l.7 11.3A1.7 1.7 0 0 0 9.9 20h4.2a1.7 1.7 0 0 0 1.7-1.7L16.5 7M10.3 10.5v6M13.7 10.5v6"/></svg>`,
  check: `<svg viewBox="0 0 24 24" aria-hidden="true"><path d="M5 12.5l4.5 4.5L19 7"/></svg>`,
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

  function quickNotes() {
    if (!state.notes.length) {
      return `
        <p class="section-empty">
          Nothing waiting. Write a line above, or start a full note with the note button.
        </p>
      `
    }

    return `
      <div class="quick-notes" data-cards>
        ${state.notes
          .map((card) => renderCard(card, { kind: 'notes', expanded: isCardOpen(card.id) }))
          .join('')}
      </div>
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
        <section class="home-section">
          <header class="section-head">
            <h3 class="section-title">Quick notes</h3>
            <span class="section-count">${state.notes.length}</span>
          </header>
          ${quickNotes()}
        </section>

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

    const foot =
      state.status === 'ready' && state.archivedCount > 0
        ? `<footer class="page-foot">
             <button type="button" class="link-btn" data-act="show-archived">
               ${ICONS.archive} Archived projects (${state.archivedCount})
             </button>
           </footer>`
        : ''

    root.innerHTML = `<section class="page${state.busy ? ' is-busy' : ''}">${capture}${body}${foot}</section>${dropBar()}`
    hydrateNoteImages(root)
    dressNotes(root)
  }

  /* ---------------------------------------------------------------
     Loading
     --------------------------------------------------------------- */

  async function load() {
    if (state.status !== 'ready') render()

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

  /** Run a mutation, then reload. Errors surface in the banner. */
  async function mutate(fn) {
    if (state.busy) return
    state.busy = true
    render()
    try {
      await fn()
      if (!alive) return
      state.busy = false
      await load()
    } catch (error) {
      if (!alive) return
      state.busy = false
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

  async function onCapture(rawTitle) {
    const title = rawTitle.trim()
    if (!title || state.busy) return

    try {
      await createQuickNote(title)
      if (!alive) return
      await load()
      focusCapture()
    } catch (error) {
      if (!alive) return
      state.status = 'error'
      state.error = error?.message || 'That did not go through.'
      render()
    }
  }

  async function openCard(card) {
    const { changed } = await openNote(card ? { card } : { drawerId: null })
    if (changed && alive) await load()
  }

  async function onDelete(id) {
    const card = noteById(id)
    if (!card) return

    const ok = await openConfirm({
      title: `Delete “${cardHeading(card, 60)}”?`,
      message: 'It moves to the trash rather than vanishing outright.',
      confirmLabel: 'Delete',
      destructive: true,
    })
    if (ok) await mutate(() => trashCard(id))
  }

  async function onMove(id) {
    const picked = await openMovePicker({
      boards: state.boards,
      drawers: state.drawers,
      currentDrawerId: null,
    })
    if (picked) await mutate(() => moveCardToDrawer(id, picked.drawerId))
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
    if (y < rect.top) return null

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

      if (droppedZone === 'delete') mutate(() => trashCard(id))
      else if (droppedZone === 'archive') mutate(() => archiveCard(id))
      else if (board) {
        mutate(async () => moveCardToDrawer(id, await firstDrawerOf(board.dataset.board)))
      } else if (target) mutate(() => mergeCards(target.dataset.card, id))
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
     Wiring
     --------------------------------------------------------------- */

  function onSubmit(event) {
    const form = event.target.closest('.quick-add')
    if (!form) return
    event.preventDefault()
    const input = form.elements.title
    const title = input.value
    input.value = ''
    onCapture(title)
  }

  function onClick(event) {
    if (drag.justDragged()) return

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
      case 'fold':
        toggleCardOpen(id)
        render()
        break
      case 'copy':
        onCopy(id, target)
        break
      case 'move':
        onMove(id)
        break
      case 'archive':
        mutate(() => archiveCard(id))
        break
      case 'delete':
        onDelete(id)
        break
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
  document.addEventListener('click', onClick)
  document.addEventListener('keydown', onKeydown)

  load()

  return function unmount() {
    alive = false
    clearMerge()
    drag.destroy()
    root.removeEventListener('submit', onSubmit)
    document.removeEventListener('click', onClick)
    document.removeEventListener('keydown', onKeydown)
  }
}
