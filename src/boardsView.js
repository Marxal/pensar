// Board list: create, rename, archive — plus the archived list. Which of the
// two is showing comes from the router in main.js, via the `view` argument.

import {
  listBoards,
  listArchivedBoards,
  countArchivedBoards,
  createBoard,
  renameBoard,
  archiveBoard,
  restoreBoard,
} from './boards'
import { countCardsByBoard } from './cards'
import { openPrompt, openConfirm } from './dialogs'
import { escapeHtml, formatDate, plural } from './format'

const ICONS = {
  back: `<svg viewBox="0 0 24 24" aria-hidden="true"><path d="M15 5.5 8.5 12l6.5 6.5"/></svg>`,
  more: `<svg viewBox="0 0 24 24" aria-hidden="true"><circle cx="5.5" cy="12" r="1.35" fill="currentColor" stroke="none"/><circle cx="12" cy="12" r="1.35" fill="currentColor" stroke="none"/><circle cx="18.5" cy="12" r="1.35" fill="currentColor" stroke="none"/></svg>`,
  plus: `<svg viewBox="0 0 24 24" aria-hidden="true"><path d="M12 5.5v13M5.5 12h13"/></svg>`,
  board: `<svg viewBox="0 0 24 24" aria-hidden="true"><rect x="3" y="4" width="4.5" height="16" rx="1.2"/><rect x="9.75" y="4" width="4.5" height="11" rx="1.2"/><rect x="16.5" y="4" width="4.5" height="7" rx="1.2"/></svg>`,
  archive: `<svg viewBox="0 0 24 24" aria-hidden="true"><rect x="3" y="4.5" width="18" height="4" rx="1.2"/><path d="M4.75 8.5v9.25a1.75 1.75 0 0 0 1.75 1.75h11a1.75 1.75 0 0 0 1.75-1.75V8.5M10 12.5h4"/></svg>`,
}

/**
 * Render the boards UI into `root`. `view` is 'active' or 'archived'.
 * Returns an unmount function — call it before replacing `root`'s contents.
 */
export function mountBoards(root, view = 'active') {
  const state = {
    boards: [],
    counts: new Map(), // board_id → live card count
    archivedCount: 0,
    status: 'loading', // loading | ready | error
    error: '',
    busy: false, // an action is in flight; blocks double-taps
  }

  const archived = view === 'archived'
  let alive = true

  /* ---------------------------------------------------------------
     Markup
     --------------------------------------------------------------- */

  function boardMenu(id) {
    return `
      <div class="menu">
        <button
          class="icon-btn menu-trigger"
          data-action="menu"
          data-id="${id}"
          aria-haspopup="true"
          aria-expanded="false"
          aria-label="Board actions"
          title="Board actions"
        >${ICONS.more}</button>
        <div class="menu-list" hidden>
          <button type="button" data-action="rename" data-id="${id}">Rename</button>
          <button type="button" data-action="archive" data-id="${id}">Archive</button>
        </div>
      </div>
    `
  }

  function activeTile(board) {
    const count = state.counts.get(board.id) ?? 0

    return `
      <article class="board-tile board-tile-open" data-action="open" data-id="${board.id}">
        <span class="board-glyph" aria-hidden="true">${ICONS.board}</span>
        <div class="board-tile-text">
          <h3 class="board-name">${escapeHtml(board.name)}</h3>
          <p class="board-meta">${count ? plural(count, 'card') : 'No cards yet'}</p>
        </div>
        ${boardMenu(board.id)}
      </article>
    `
  }

  function archivedRow(board) {
    return `
      <article class="board-tile board-tile-archived" data-id="${board.id}">
        <span class="board-glyph" aria-hidden="true">${ICONS.archive}</span>
        <div class="board-tile-text">
          <h3 class="board-name">${escapeHtml(board.name)}</h3>
          <p class="board-meta">Archived ${formatDate(board.archived_at)}</p>
        </div>
        <button class="btn btn-ghost btn-sm" data-action="restore" data-id="${board.id}">Restore</button>
      </article>
    `
  }

  function skeletons() {
    return `<div class="board-grid">${'<div class="board-tile board-tile-skeleton"></div>'.repeat(3)}</div>`
  }

  function activeBody() {
    if (!state.boards.length) {
      return `
        <div class="empty-state">
          <span class="empty-glyph" aria-hidden="true">${ICONS.board}</span>
          <h3>No boards yet</h3>
          <p>A board holds cards in three columns — To do, Doing and Done.</p>
          <button class="btn btn-primary" data-action="new">${ICONS.plus} New board</button>
        </div>
      `
    }
    return `<div class="board-grid">${state.boards.map(activeTile).join('')}</div>`
  }

  function archivedBody() {
    if (!state.boards.length) {
      return `
        <div class="empty-state">
          <span class="empty-glyph" aria-hidden="true">${ICONS.archive}</span>
          <h3>Nothing archived</h3>
          <p>Boards you archive are kept here — nothing is deleted.</p>
        </div>
      `
    }
    return `<div class="board-list">${state.boards.map(archivedRow).join('')}</div>`
  }

  function render() {
    const head = archived
      ? `
        <header class="page-head">
          <div class="page-head-text">
            <button class="icon-btn" data-action="back" aria-label="Back to boards" title="Back to boards">${ICONS.back}</button>
            <div>
              <h2 class="page-title">Archived boards</h2>
              <p class="page-sub">${
                state.status === 'ready' ? plural(state.boards.length, 'board') : '&nbsp;'
              }</p>
            </div>
          </div>
        </header>
      `
      : `
        <header class="page-head">
          <div class="page-head-text">
            <div>
              <h2 class="page-title">Boards</h2>
              <p class="page-sub">${
                state.status === 'ready' ? plural(state.boards.length, 'board') : '&nbsp;'
              }</p>
            </div>
          </div>
          <button class="btn btn-primary" data-action="new">${ICONS.plus} New board</button>
        </header>
      `

    let body
    if (state.status === 'loading') {
      body = skeletons()
    } else if (state.status === 'error') {
      body = `
        <div class="banner banner-error">
          <p>${escapeHtml(state.error)}</p>
          <button class="btn btn-ghost btn-sm" data-action="retry">Try again</button>
        </div>
      `
    } else {
      body = archived ? archivedBody() : activeBody()
    }

    const foot =
      !archived && state.status === 'ready' && state.archivedCount > 0
        ? `<footer class="page-foot">
             <button class="link-btn" data-action="show-archived">
               ${ICONS.archive} Archived boards (${state.archivedCount})
             </button>
           </footer>`
        : ''

    root.innerHTML = `<section class="page${state.busy ? ' is-busy' : ''}">${head}${body}${foot}</section>`
  }

  /* ---------------------------------------------------------------
     Loading
     --------------------------------------------------------------- */

  async function load() {
    state.status = 'loading'
    render()

    try {
      if (archived) {
        state.boards = await listArchivedBoards()
        state.archivedCount = state.boards.length
      } else {
        const [boards, archivedCount, counts] = await Promise.all([
          listBoards(),
          countArchivedBoards(),
          countCardsByBoard(),
        ])
        state.boards = boards
        state.archivedCount = archivedCount
        state.counts = counts
      }
      if (!alive) return
      state.status = 'ready'
    } catch (error) {
      if (!alive) return
      state.status = 'error'
      state.error = error?.message || 'Could not load your boards.'
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
     Actions
     --------------------------------------------------------------- */

  function boardById(id) {
    return state.boards.find((board) => board.id === id)
  }

  async function onNew() {
    const name = await openPrompt({
      title: 'New board',
      label: 'Board name',
      placeholder: 'Reading list',
      confirmLabel: 'Create board',
    })
    if (name) await mutate(() => createBoard(name))
  }

  async function onRename(id) {
    const board = boardById(id)
    if (!board) return

    const name = await openPrompt({
      title: 'Rename board',
      label: 'Board name',
      value: board.name,
      confirmLabel: 'Save',
    })
    if (name && name !== board.name) await mutate(() => renameBoard(id, name))
  }

  async function onArchive(id) {
    const board = boardById(id)
    if (!board) return

    const ok = await openConfirm({
      title: `Archive “${board.name}”?`,
      message: 'It leaves your board list but keeps its cards. You can restore it any time.',
      confirmLabel: 'Archive',
    })
    if (ok) await mutate(() => archiveBoard(id))
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
     Wiring
     --------------------------------------------------------------- */

  function onClick(event) {
    const target = event.target.closest('[data-action]')

    if (!target || !root.contains(target)) {
      closeMenus()
      return
    }

    const { action, id } = target.dataset
    if (action !== 'menu') closeMenus()

    switch (action) {
      case 'new':
        onNew()
        break
      case 'open':
        location.hash = `#/board/${id}`
        break
      case 'menu':
        toggleMenu(target)
        break
      case 'rename':
        onRename(id)
        break
      case 'archive':
        onArchive(id)
        break
      case 'restore':
        mutate(() => restoreBoard(id))
        break
      case 'show-archived':
        location.hash = '#/archived'
        break
      case 'back':
        location.hash = '#/boards'
        break
      case 'retry':
        load()
        break
    }
  }

  function onKeydown(event) {
    if (event.key === 'Escape') closeMenus()
  }

  document.addEventListener('click', onClick)
  document.addEventListener('keydown', onKeydown)

  load()

  return function unmount() {
    alive = false
    document.removeEventListener('click', onClick)
    document.removeEventListener('keydown', onKeydown)
  }
}
