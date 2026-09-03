// The Archive: notes and projects put aside, whole and out of the way.
//
// Not the trash. Nothing here is on its way to being deleted — an archived
// note left the board because it was finished with, and it keeps its pictures,
// its drawer and its place until it's asked back. Restoring one puts it where
// it was: a project back at the end of the list with everything inside it, a
// note back in its drawer (or into Quick notes, if that drawer has gone).
//
// Notes arrive here two ways — dragged onto the Archive zone, or swiped
// sideways on a phone (swipe.js) — and both leave an undo behind them, so this
// page is for the ones you meant.
//
// Creating and dressing projects lives on the home screen; this page only has
// to answer "where did that one go", and give it back.
//
// Not for ever, though: the same scheduled job that empties the trash after 30
// days clears the archive after 90 (see the pensar_purge_schedule migration).

import { listArchivedBoards, restoreBoard, trashBoard } from './boards'
import { listArchivedCards, unarchiveCard, trashCard, restoreCard, PRIORITY_LABELS } from './cards'
import { cardHeading } from './cardTile'
import { openConfirm } from './dialogs'
import { renderBoardGlyph } from './boardStyle'
import { signImages } from './images'
import { firstImage, hydrateNoteImages } from './markdown'
import { offerUndo, dismissUndo } from './undo'
import { escapeHtml, formatDate, plural } from './format'

const ICONS = {
  back: `<svg viewBox="0 0 24 24" aria-hidden="true"><path d="M15 5.5 8.5 12l6.5 6.5"/></svg>`,
  archive: `<svg viewBox="0 0 24 24" aria-hidden="true"><rect x="3" y="4.5" width="18" height="4" rx="1.2"/><path d="M4.75 8.5v9.25a1.75 1.75 0 0 0 1.75 1.75h11a1.75 1.75 0 0 0 1.75-1.75V8.5M10 12.5h4"/></svg>`,
  card: `<svg viewBox="0 0 24 24" aria-hidden="true"><path d="M5 4.5h14v15H5zM8.5 9h7M8.5 12.5h7M8.5 16h4"/></svg>`,
}

/**
 * Render the archive into `root`. Returns an unmount function — call it
 * before replacing `root`'s contents.
 */
export function mountArchived(root) {
  const state = {
    boards: [],
    cards: [],
    images: new Map(), // storage path → signed URL (project icons only — card
    // pictures are hydrated the same deferred way as everywhere else)
    status: 'loading', // loading | ready | error
    error: '',
    busy: false,
  }

  let alive = true

  /* ---------------------------------------------------------------
     Markup — an archived thing still looks like what it was: a project keeps
     its colour and icon, a note keeps its picture and its priority. Only the
     row and its two buttons are this page's own.
     --------------------------------------------------------------- */

  function actions(type, id) {
    return `
      <button type="button" class="btn btn-ghost btn-sm" data-act="restore" data-type="${type}" data-id="${id}">Restore</button>
      <button type="button" class="btn btn-ghost btn-sm menu-danger" data-act="delete" data-type="${type}" data-id="${id}">Delete</button>
    `
  }

  function boardRow(board) {
    return `
      <article class="board-tile board-tile-archived" data-tint="${escapeHtml(board.colour ?? 'teal')}">
        ${renderBoardGlyph(board, state.images)}
        <div class="board-tile-text">
          <h3 class="board-name">${escapeHtml(board.name)}</h3>
          <p class="board-meta">Project · archived ${formatDate(board.archived_at)}</p>
        </div>
        ${actions('board', board.id)}
      </article>
    `
  }

  function cardGlyph(card) {
    const picture = firstImage(card.body_markdown)
    if (!picture) return `<span class="board-glyph" aria-hidden="true">${ICONS.card}</span>`

    const source = picture.path
      ? `data-note-image="${escapeHtml(picture.path)}"`
      : `src="${escapeHtml(picture.url)}"`
    return `<span class="board-glyph has-image"><img ${source} alt="" draggable="false"></span>`
  }

  function cardRow(card) {
    const from = card.board?.name ?? 'Quick notes'
    const priority = card.priority
      ? ` <span class="tag tag-pri pri-${card.priority}">${PRIORITY_LABELS[card.priority]}</span>`
      : ''

    return `
      <article class="board-tile board-tile-archived">
        ${cardGlyph(card)}
        <div class="board-tile-text">
          <h3 class="board-name">${escapeHtml(cardHeading(card))}</h3>
          <p class="board-meta">Was in ${escapeHtml(from)} · archived ${formatDate(card.archived_at)}${priority}</p>
        </div>
        ${actions('card', card.id)}
      </article>
    `
  }

  /** Both kinds in one list, most recently put aside first — what you archived
   *  a minute ago is what you're most likely here to fetch back. */
  function rows() {
    return [
      ...state.boards.map((board) => ({ at: board.archived_at, html: boardRow(board) })),
      ...state.cards.map((card) => ({ at: card.archived_at, html: cardRow(card) })),
    ].sort((a, b) => b.at.localeCompare(a.at))
  }

  function body() {
    const list = rows()
    if (!list.length) {
      return `
        <div class="empty-state">
          <span class="empty-glyph" aria-hidden="true">${ICONS.archive}</span>
          <h3>Nothing archived</h3>
          <p>Notes you swipe aside and projects you archive are kept whole here for 90 days.</p>
        </div>
      `
    }
    return `<div class="board-list">${list.map((row) => row.html).join('')}</div>`
  }

  function render() {
    const count = state.boards.length + state.cards.length

    const head = `
      <header class="page-head">
        <div class="page-head-text">
          <button type="button" class="icon-btn" data-act="back" aria-label="Back" title="Back">${ICONS.back}</button>
          <div>
            <h2 class="page-title">Archive</h2>
            <p class="page-sub">${state.status === 'ready' ? plural(count, 'item') : '&nbsp;'}</p>
          </div>
        </div>
      </header>
    `

    let content
    if (state.status === 'loading') {
      content = `<div class="board-list">${'<div class="board-tile board-tile-skeleton"></div>'.repeat(3)}</div>`
    } else if (state.status === 'error') {
      content = `
        <div class="banner banner-error">
          <p>${escapeHtml(state.error)}</p>
          <button type="button" class="btn btn-ghost btn-sm" data-act="retry">Try again</button>
        </div>
      `
    } else {
      content = body()
    }

    root.innerHTML = `<section class="page${state.busy ? ' is-busy' : ''}">${head}${content}</section>`
    hydrateNoteImages(root)
  }

  /* ---------------------------------------------------------------
     Loading
     --------------------------------------------------------------- */

  async function load() {
    if (state.status !== 'ready') render()

    try {
      const [boards, cards] = await Promise.all([listArchivedBoards(), listArchivedCards()])
      if (!alive) return
      state.boards = boards
      state.cards = cards
      state.status = 'ready'
      paintBoardIcons()
    } catch (error) {
      if (!alive) return
      state.status = 'error'
      state.error = error?.message || 'Could not load your archive.'
    }
    render()
  }

  /** Project icons, drawn straight into the rows rather than hydrated
   *  afterwards like the pictures on the cards — same split as homeView.js. */
  async function paintBoardIcons() {
    const paths = state.boards.map((board) => board.icon_path).filter(Boolean)
    if (!paths.length) return

    const links = await signImages(paths)
    if (!alive) return

    const isNew = paths.some((path) => links.get(path) !== state.images.get(path))
    state.images = links
    if (isNew) render()
  }

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

  /* ---------------------------------------------------------------
     Actions
     --------------------------------------------------------------- */

  /** A project asks first — it takes its drawers and every card in them along.
   *  A single note doesn't: it's one row, and the trash is a recoverable place
   *  to send it, so it goes with an undo behind it instead. */
  async function onDelete(type, id) {
    if (type === 'card') {
      if (!(await mutate(() => trashCard(id)))) return
      offerUndo({ message: 'Note moved to the trash', undo: () => mutate(() => restoreCard(id)) })
      return
    }

    const board = state.boards.find((item) => item.id === id)
    if (!board) return

    const ok = await openConfirm({
      title: `Delete “${board.name}”?`,
      message: 'It moves to the trash rather than vanishing outright.',
      confirmLabel: 'Delete',
      destructive: true,
    })
    if (ok) await mutate(() => trashBoard(id))
  }

  function onClick(event) {
    const target = event.target.closest('[data-act]')
    if (!target || !root.contains(target)) return

    const { act, type, id } = target.dataset
    switch (act) {
      case 'restore':
        mutate(() => (type === 'card' ? unarchiveCard(id) : restoreBoard(id)))
        break
      case 'delete':
        onDelete(type, id)
        break
      case 'back':
        location.hash = '#/'
        break
      case 'retry':
        load()
        break
    }
  }

  document.addEventListener('click', onClick)

  load()

  return function unmount() {
    alive = false
    dismissUndo()
    document.removeEventListener('click', onClick)
  }
}
