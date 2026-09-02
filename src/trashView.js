// Trash: boards and cards that were deleted, most recent first, with a
// restore action. A scheduled Postgres job (see the pensar_purge_schedule
// migration) permanently clears anything older than 30 days — nothing here
// deletes for good on its own.

import { listTrashedBoards, restoreTrashedBoard } from './boards'
import { listTrashedCards, restoreCard, PRIORITY_LABELS } from './cards'
import { cardHeading } from './cardTile'
import { renderBoardGlyph } from './boardStyle'
import { signImages } from './images'
import { firstImage, hydrateNoteImages } from './markdown'
import { escapeHtml, formatDate, plural } from './format'

const ICONS = {
  card: `<svg viewBox="0 0 24 24" aria-hidden="true"><path d="M5 4.5h14v15H5zM8.5 9h7M8.5 12.5h7M8.5 16h4"/></svg>`,
  trash: `<svg viewBox="0 0 24 24" aria-hidden="true"><path d="M5 7h14M9.5 7V5.2A1.2 1.2 0 0 1 10.7 4h2.6a1.2 1.2 0 0 1 1.2 1.2V7M7.5 7l.7 11.3A1.7 1.7 0 0 0 9.9 20h4.2a1.7 1.7 0 0 0 1.7-1.7L16.5 7M10.3 10.5v6M13.7 10.5v6"/></svg>`,
}

/**
 * Render the Trash into `root`. Returns an unmount function — call it before
 * replacing `root`'s contents.
 */
export function mountTrash(root) {
  const state = {
    boards: [],
    cards: [],
    images: new Map(), // storage path → signed URL (board icons only — card
    // pictures are hydrated the same deferred way as everywhere else)
    status: 'loading', // loading | ready | error
    error: '',
    busy: false, // an action is in flight; blocks double-taps
  }

  let alive = true

  /* ---------------------------------------------------------------
     Markup — a trashed item still looks like what it was: a board keeps its
     own colour and icon, a card keeps its own picture and priority. Only the
     row layout and the Restore button are the trash's own.
     --------------------------------------------------------------- */

  function boardRow(board) {
    return `
      <article class="board-tile board-tile-archived" data-type="board" data-id="${board.id}">
        ${renderBoardGlyph(board, state.images)}
        <div class="board-tile-text">
          <h3 class="board-name">${escapeHtml(board.name)}</h3>
          <p class="board-meta">Board · deleted ${formatDate(board.deleted_at)}</p>
        </div>
        <button class="btn btn-ghost btn-sm" data-action="restore" data-type="board" data-id="${board.id}">Restore</button>
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
      <article class="board-tile board-tile-archived" data-type="card" data-id="${card.id}">
        ${cardGlyph(card)}
        <div class="board-tile-text">
          <h3 class="board-name">${escapeHtml(cardHeading(card))}</h3>
          <p class="board-meta">Was in ${escapeHtml(from)} · deleted ${formatDate(card.deleted_at)}${priority}</p>
        </div>
        <button class="btn btn-ghost btn-sm" data-action="restore" data-type="card" data-id="${card.id}">Restore</button>
      </article>
    `
  }

  function items() {
    return [
      ...state.boards.map((board) => ({ deleted_at: board.deleted_at, html: boardRow(board) })),
      ...state.cards.map((card) => ({ deleted_at: card.deleted_at, html: cardRow(card) })),
    ].sort((a, b) => b.deleted_at.localeCompare(a.deleted_at))
  }

  function skeletons() {
    return `<div class="board-list">${'<div class="board-tile board-tile-skeleton"></div>'.repeat(3)}</div>`
  }

  function body() {
    const rows = items()
    if (!rows.length) {
      return `
        <div class="empty-state">
          <span class="empty-glyph" aria-hidden="true">${ICONS.trash}</span>
          <h3>Trash is empty</h3>
          <p>Deleted cards and boards land here for 30 days before they're gone for good.</p>
        </div>
      `
    }
    return `<div class="board-list">${rows.map((row) => row.html).join('')}</div>`
  }

  function render() {
    const count = state.boards.length + state.cards.length

    const head = `
      <header class="page-head">
        <div class="page-head-text">
          <div>
            <h2 class="page-title">Trash</h2>
            <p class="page-sub">${state.status === 'ready' ? plural(count, 'item') : '&nbsp;'}</p>
          </div>
        </div>
      </header>
    `

    let content
    if (state.status === 'loading') {
      content = skeletons()
    } else if (state.status === 'error') {
      content = `
        <div class="banner banner-error">
          <p>${escapeHtml(state.error)}</p>
          <button class="btn btn-ghost btn-sm" data-action="retry">Try again</button>
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

  /** Board icons, drawn straight into the tiles rather than hydrated
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

  async function load() {
    state.status = 'loading'
    render()

    try {
      const [boards, cards] = await Promise.all([listTrashedBoards(), listTrashedCards()])
      if (!alive) return
      state.boards = boards
      state.cards = cards
      state.status = 'ready'
      paintBoardIcons()
    } catch (error) {
      if (!alive) return
      state.status = 'error'
      state.error = error?.message || 'Could not load the trash.'
    }
    render()
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
     Wiring
     --------------------------------------------------------------- */

  function onClick(event) {
    const target = event.target.closest('[data-action]')
    if (!target || !root.contains(target)) return

    const { action, type, id } = target.dataset

    switch (action) {
      case 'restore':
        mutate(() => (type === 'board' ? restoreTrashedBoard(id) : restoreCard(id)))
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
    document.removeEventListener('click', onClick)
  }
}
