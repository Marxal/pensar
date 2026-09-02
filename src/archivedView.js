// Archived projects: off the home screen, but whole. Restoring one puts it
// back at the end of the list with everything still inside it.
//
// Creating and dressing projects lives on the home screen — this page only has
// to answer "where did that one go".

import { listArchivedBoards, restoreBoard, trashBoard } from './boards'
import { openConfirm } from './dialogs'
import { renderBoardGlyph } from './boardStyle'
import { signImages } from './images'
import { escapeHtml, formatDate, plural } from './format'

const ICONS = {
  back: `<svg viewBox="0 0 24 24" aria-hidden="true"><path d="M15 5.5 8.5 12l6.5 6.5"/></svg>`,
  archive: `<svg viewBox="0 0 24 24" aria-hidden="true"><rect x="3" y="4.5" width="18" height="4" rx="1.2"/><path d="M4.75 8.5v9.25a1.75 1.75 0 0 0 1.75 1.75h11a1.75 1.75 0 0 0 1.75-1.75V8.5M10 12.5h4"/></svg>`,
}

/**
 * Render the archived projects into `root`. Returns an unmount function —
 * call it before replacing `root`'s contents.
 */
export function mountArchived(root) {
  const state = {
    boards: [],
    images: new Map(),
    status: 'loading', // loading | ready | error
    error: '',
    busy: false,
  }

  let alive = true

  function row(board) {
    return `
      <article class="board-tile board-tile-archived" data-tint="${escapeHtml(board.colour ?? 'teal')}">
        ${renderBoardGlyph(board, state.images)}
        <div class="board-tile-text">
          <h3 class="board-name">${escapeHtml(board.name)}</h3>
          <p class="board-meta">Archived ${formatDate(board.archived_at)}</p>
        </div>
        <button type="button" class="btn btn-ghost btn-sm" data-act="restore" data-id="${board.id}">Restore</button>
        <button type="button" class="btn btn-ghost btn-sm menu-danger" data-act="delete" data-id="${board.id}">Delete</button>
      </article>
    `
  }

  function render() {
    const head = `
      <header class="page-head">
        <div class="page-head-text">
          <button type="button" class="icon-btn" data-act="back" aria-label="Back" title="Back">${ICONS.back}</button>
          <div>
            <h2 class="page-title">Archived projects</h2>
            <p class="page-sub">${
              state.status === 'ready' ? plural(state.boards.length, 'project') : '&nbsp;'
            }</p>
          </div>
        </div>
      </header>
    `

    let body
    if (state.status === 'loading') {
      body = `<div class="board-list">${'<div class="board-tile board-tile-skeleton"></div>'.repeat(3)}</div>`
    } else if (state.status === 'error') {
      body = `
        <div class="banner banner-error">
          <p>${escapeHtml(state.error)}</p>
          <button type="button" class="btn btn-ghost btn-sm" data-act="retry">Try again</button>
        </div>
      `
    } else if (!state.boards.length) {
      body = `
        <div class="empty-state">
          <span class="empty-glyph" aria-hidden="true">${ICONS.archive}</span>
          <h3>Nothing archived</h3>
          <p>Projects you archive are kept here — nothing is deleted.</p>
        </div>
      `
    } else {
      body = `<div class="board-list">${state.boards.map(row).join('')}</div>`
    }

    root.innerHTML = `<section class="page${state.busy ? ' is-busy' : ''}">${head}${body}</section>`
  }

  async function load() {
    if (state.status !== 'ready') render()

    try {
      state.boards = await listArchivedBoards()
      if (!alive) return
      state.status = 'ready'
      paintImages()
    } catch (error) {
      if (!alive) return
      state.status = 'error'
      state.error = error?.message || 'Could not load your archive.'
    }
    render()
  }

  async function paintImages() {
    const paths = state.boards.map((board) => board.icon_path).filter(Boolean)
    if (!paths.length) return

    const links = await signImages(paths)
    if (!alive) return

    const isNew = paths.some((path) => links.get(path) !== state.images.get(path))
    state.images = links
    if (isNew) render()
  }

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

  async function onDelete(id) {
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

    const { act, id } = target.dataset
    switch (act) {
      case 'restore':
        mutate(() => restoreBoard(id))
        break
      case 'delete':
        onDelete(id)
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
    document.removeEventListener('click', onClick)
  }
}
