// Trash: boards and cards that were deleted, most recent first, with a
// restore action. A scheduled Postgres job (see the pensar_purge_schedule
// migration) permanently clears anything older than 30 days — nothing here
// deletes for good on its own.

import { listTrashedBoards, restoreTrashedBoard } from './boards'
import { listTrashedCards, restoreCard } from './cards'
import { escapeHtml, formatDate, plural } from './format'
import { plainText } from './markdown'

const ICONS = {
  board: `<svg viewBox="0 0 24 24" aria-hidden="true"><rect x="3" y="4" width="4.5" height="16" rx="1.2"/><rect x="9.75" y="4" width="4.5" height="11" rx="1.2"/><rect x="16.5" y="4" width="4.5" height="7" rx="1.2"/></svg>`,
  card: `<svg viewBox="0 0 24 24" aria-hidden="true"><path d="M5 4.5h14v15H5zM8.5 9h7M8.5 12.5h7M8.5 16h4"/></svg>`,
  trash: `<svg viewBox="0 0 24 24" aria-hidden="true"><path d="M5 7h14M9.5 7V5.2A1.2 1.2 0 0 1 10.7 4h2.6a1.2 1.2 0 0 1 1.2 1.2V7M7.5 7l.7 11.3A1.7 1.7 0 0 0 9.9 20h4.2a1.7 1.7 0 0 0 1.7-1.7L16.5 7M10.3 10.5v6M13.7 10.5v6"/></svg>`,
}

/** A title stands in for the card's heading; a titleless card leans on its note instead. */
function cardHeading(card) {
  const text = card.title.trim() || plainText(card.body_markdown)
  return text.length > 80 ? `${text.slice(0, 80)}…` : text || 'Untitled'
}

/**
 * Render the Trash into `root`. Returns an unmount function — call it before
 * replacing `root`'s contents.
 */
export function mountTrash(root) {
  const state = {
    boards: [],
    cards: [],
    status: 'loading', // loading | ready | error
    error: '',
    busy: false, // an action is in flight; blocks double-taps
  }

  let alive = true

  /* ---------------------------------------------------------------
     Markup
     --------------------------------------------------------------- */

  function boardRow(board) {
    return `
      <article class="board-tile board-tile-archived" data-type="board" data-id="${board.id}">
        <span class="board-glyph" aria-hidden="true">${ICONS.board}</span>
        <div class="board-tile-text">
          <h3 class="board-name">${escapeHtml(board.name)}</h3>
          <p class="board-meta">Board · deleted ${formatDate(board.deleted_at)}</p>
        </div>
        <button class="btn btn-ghost btn-sm" data-action="restore" data-type="board" data-id="${board.id}">Restore</button>
      </article>
    `
  }

  function cardRow(card) {
    const from = card.board?.name ?? 'Inbox'

    return `
      <article class="board-tile board-tile-archived" data-type="card" data-id="${card.id}">
        <span class="board-glyph" aria-hidden="true">${ICONS.card}</span>
        <div class="board-tile-text">
          <h3 class="board-name">${escapeHtml(cardHeading(card))}</h3>
          <p class="board-meta">Was in ${escapeHtml(from)} · deleted ${formatDate(card.deleted_at)}</p>
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
  }

  /* ---------------------------------------------------------------
     Loading
     --------------------------------------------------------------- */

  async function load() {
    state.status = 'loading'
    render()

    try {
      const [boards, cards] = await Promise.all([listTrashedBoards(), listTrashedCards()])
      if (!alive) return
      state.boards = boards
      state.cards = cards
      state.status = 'ready'
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
