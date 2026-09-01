// The Inbox: a fast add field at the top, and every card not yet on a board
// below it. This is the app's home screen.
//
// Touch devices get swipe gestures on each row: swipe right past a threshold
// fires the assign-to-board picker directly (a one-shot gesture, snapping
// back either way); swipe left reveals an archive/delete panel that stays
// open until dismissed. The tap-based menu underneath is the fallback
// everywhere — desktop, and touch users who'd rather not swipe.

import { listBoards } from './boards'
import {
  listInboxCards,
  createInboxCard,
  updateCard,
  assignCardToBoard,
  archiveCard,
  trashCard,
} from './cards'
import { openBoardPicker, openCardEditor, openConfirm } from './dialogs'
import { escapeHtml, plural } from './format'
import { plainText } from './markdown'

/** A title stands in for the row's heading; a titleless card leans on its note instead. */
function cardHeading(card) {
  const text = card.title.trim() || plainText(card.body_markdown)
  return text.length > 80 ? `${text.slice(0, 80)}…` : text || 'Untitled'
}

const ICONS = {
  plus: `<svg viewBox="0 0 24 24" aria-hidden="true"><path d="M12 5.5v13M5.5 12h13"/></svg>`,
  more: `<svg viewBox="0 0 24 24" aria-hidden="true"><circle cx="5.5" cy="12" r="1.35" fill="currentColor" stroke="none"/><circle cx="12" cy="12" r="1.35" fill="currentColor" stroke="none"/><circle cx="18.5" cy="12" r="1.35" fill="currentColor" stroke="none"/></svg>`,
  inbox: `<svg viewBox="0 0 24 24" aria-hidden="true"><path d="M4 12h4.2l1.3 2.6h4.9L15.7 12H20M4 12v6.25A1.75 1.75 0 0 0 5.75 20h12.5A1.75 1.75 0 0 0 20 18.25V12M4 12l2.4-6.4A1.5 1.5 0 0 1 7.8 4.5h8.4a1.5 1.5 0 0 1 1.4 1.1L20 12"/></svg>`,
  board: `<svg viewBox="0 0 24 24" aria-hidden="true"><rect x="3" y="4" width="4.5" height="16" rx="1.2"/><rect x="9.75" y="4" width="4.5" height="11" rx="1.2"/><rect x="16.5" y="4" width="4.5" height="7" rx="1.2"/></svg>`,
  archive: `<svg viewBox="0 0 24 24" aria-hidden="true"><rect x="3" y="4.5" width="18" height="4" rx="1.2"/><path d="M4.75 8.5v9.25a1.75 1.75 0 0 0 1.75 1.75h11a1.75 1.75 0 0 0 1.75-1.75V8.5M10 12.5h4"/></svg>`,
  trash: `<svg viewBox="0 0 24 24" aria-hidden="true"><path d="M5 7h14M9.5 7V5.2A1.2 1.2 0 0 1 10.7 4h2.6a1.2 1.2 0 0 1 1.2 1.2V7M7.5 7l.7 11.3A1.7 1.7 0 0 0 9.9 20h4.2a1.7 1.7 0 0 0 1.7-1.7L16.5 7M10.3 10.5v6M13.7 10.5v6"/></svg>`,
}

/** Pixels of movement before a press turns into a swipe. */
const DRAG_THRESHOLD = 8

/** Width of the left-side archive/delete panel, and how far a left swipe must travel to snap it open. */
const SWIPE_OPEN = -136
const SWIPE_OPEN_TRIGGER = -56

/** How far a right swipe must travel to fire the assign picker, and the cap on the drag itself. */
const SWIPE_ASSIGN_TRIGGER = 72
const SWIPE_HINT_WIDTH = 96

/**
 * Render the Inbox into `root`. Returns an unmount function — call it before
 * replacing `root`'s contents.
 */
export function mountInbox(root) {
  const state = {
    cards: [],
    boards: [],
    status: 'loading', // loading | ready | error
    error: '',
    busy: false, // an action is in flight; blocks double-taps
  }

  let alive = true

  // Swipe bookkeeping. `swipe` is a gesture in progress; `openRowId` is the
  // card whose archive/delete panel is currently snapped open.
  let swipe = null
  let openRowId = null

  /* ---------------------------------------------------------------
     Markup
     --------------------------------------------------------------- */

  function inboxRow(card) {
    return `
      <li class="inbox-row" data-id="${card.id}">
        <div class="swipe-hint" aria-hidden="true">${ICONS.board}<span>Assign</span></div>
        <div class="swipe-panel" aria-hidden="true">
          <button type="button" class="swipe-btn swipe-btn-archive" data-action="archive" data-id="${card.id}">
            ${ICONS.archive}<span>Archive</span>
          </button>
          <button type="button" class="swipe-btn swipe-btn-delete" data-action="delete" data-id="${card.id}">
            ${ICONS.trash}<span>Delete</span>
          </button>
        </div>
        <article class="inbox-card" data-swipe="${card.id}">
          <button type="button" class="inbox-card-main" data-action="edit" data-id="${card.id}">
            <span class="inbox-card-title">${escapeHtml(cardHeading(card))}</span>
          </button>
          <div class="menu">
            <button
              class="icon-btn icon-btn-sm menu-trigger"
              data-action="menu"
              aria-haspopup="true"
              aria-expanded="false"
              aria-label="Card actions"
              title="Card actions"
            >${ICONS.more}</button>
            <div class="menu-list" hidden>
              <button type="button" data-action="edit" data-id="${card.id}">Edit</button>
              <button type="button" data-action="assign" data-id="${card.id}">Assign to board…</button>
              <button type="button" data-action="archive" data-id="${card.id}">Archive</button>
              <button type="button" class="menu-danger" data-action="delete" data-id="${card.id}">Delete</button>
            </div>
          </div>
        </article>
      </li>
    `
  }

  function skeletons() {
    return `<ul class="inbox-list">${'<li class="inbox-row"><div class="inbox-card inbox-card-skeleton"></div></li>'.repeat(3)}</ul>`
  }

  function render() {
    resetSwipe()

    const head = `
      <header class="page-head">
        <div class="page-head-text">
          <div>
            <h2 class="page-title">Inbox</h2>
            <p class="page-sub">${
              state.status === 'ready' ? plural(state.cards.length, 'card') : '&nbsp;'
            }</p>
          </div>
        </div>
      </header>
    `

    const addBar = `
      <form class="inbox-add">
        <input
          id="inbox-quick-add"
          class="inbox-add-input"
          type="text"
          name="title"
          autocomplete="off"
          maxlength="200"
          placeholder="Capture something…"
        />
        <button type="submit" class="icon-btn inbox-add-submit" aria-label="Add to inbox" title="Add to inbox">
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
          <button class="btn btn-ghost btn-sm" data-action="retry">Try again</button>
        </div>
      `
    } else if (!state.cards.length) {
      body = `
        <div class="empty-state">
          <span class="empty-glyph" aria-hidden="true">${ICONS.inbox}</span>
          <h3>Inbox zero</h3>
          <p>Capture something above, or come back later.</p>
        </div>
      `
    } else {
      body = `<ul class="inbox-list">${state.cards.map(inboxRow).join('')}</ul>`
    }

    root.innerHTML = `<section class="page${state.busy ? ' is-busy' : ''}">${head}${addBar}${body}</section>`
  }

  /* ---------------------------------------------------------------
     Loading
     --------------------------------------------------------------- */

  async function load() {
    state.status = 'loading'
    render()

    try {
      const [cards, boards] = await Promise.all([listInboxCards(), listBoards()])
      if (!alive) return
      state.cards = cards
      state.boards = boards
      state.status = 'ready'
    } catch (error) {
      if (!alive) return
      state.status = 'error'
      state.error = error?.message || 'Could not load your inbox.'
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

  function focusQuickAdd() {
    root.querySelector('#inbox-quick-add')?.focus()
  }

  async function onQuickAdd(rawTitle) {
    const title = rawTitle.trim()
    if (!title || state.busy) return

    state.busy = true
    render()
    try {
      await createInboxCard(title)
      if (!alive) return
      state.busy = false
      await load()
    } catch (error) {
      if (!alive) return
      state.busy = false
      state.status = 'error'
      state.error = error?.message || 'That did not go through.'
      render()
      return
    }
    if (alive) focusQuickAdd()
  }

  async function onAssign(id) {
    const picked = await openBoardPicker({ boards: state.boards })
    if (!picked) return
    if (picked.newBoard) {
      location.hash = '#/boards'
      return
    }
    await mutate(() => assignCardToBoard(id, picked.boardId, picked.status))
  }

  function cardById(id) {
    return state.cards.find((card) => card.id === id)
  }

  async function onEdit(id) {
    const card = cardById(id)
    if (!card) return

    const fields = await openCardEditor({ card })
    if (fields) await mutate(() => updateCard(id, fields))
  }

  async function onDelete(id) {
    const card = cardById(id)
    if (!card) return

    const ok = await openConfirm({
      title: `Delete “${cardHeading(card)}”?`,
      message: 'It moves to the trash rather than vanishing outright.',
      confirmLabel: 'Delete',
      destructive: true,
    })
    if (ok) await mutate(() => trashCard(id))
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
     Swipe gestures (touch only — mouse users get the menu/tap flow above)
     --------------------------------------------------------------- */

  function rowCard(id) {
    return root.querySelector(`.inbox-card[data-swipe="${id}"]`)
  }

  function setSwipeX(cardEl, x, animate) {
    cardEl.style.transition = animate ? 'transform 0.18s ease' : 'none'
    cardEl.style.transform = x ? `translateX(${x}px)` : ''
  }

  /** Snap any open row shut. Safe to call when none is open. */
  function closeSwipe(animate = true) {
    if (!openRowId) return
    const cardEl = rowCard(openRowId)
    if (cardEl) setSwipeX(cardEl, 0, animate)
    openRowId = null
  }

  /** Drop any in-flight gesture bookkeeping — used before a re-render replaces the DOM. */
  function resetSwipe() {
    if (swipe) {
      document.removeEventListener('pointermove', onSwipeMove)
      document.removeEventListener('pointerup', onSwipeEnd)
      document.removeEventListener('pointercancel', onSwipeEnd)
      swipe = null
    }
    openRowId = null
  }

  function onSwipeStart(event) {
    if (event.pointerType === 'mouse' || swipe) return

    const cardEl = event.target.closest('.inbox-card')
    if (!cardEl || !root.contains(cardEl) || event.target.closest('.menu')) return

    const id = cardEl.closest('.inbox-row')?.dataset.id
    if (!id) return

    if (openRowId && openRowId !== id) closeSwipe()

    swipe = {
      id,
      cardEl,
      pointerId: event.pointerId,
      startX: event.clientX,
      startY: event.clientY,
      x: 0,
      dragging: false,
      openBefore: openRowId === id,
    }
    document.addEventListener('pointermove', onSwipeMove)
    document.addEventListener('pointerup', onSwipeEnd)
    document.addEventListener('pointercancel', onSwipeEnd)
  }

  function onSwipeMove(event) {
    if (!swipe || event.pointerId !== swipe.pointerId) return

    const dx = event.clientX - swipe.startX
    const dy = event.clientY - swipe.startY

    if (!swipe.dragging) {
      if (Math.hypot(dx, dy) < DRAG_THRESHOLD) return
      if (Math.abs(dy) > Math.abs(dx)) {
        // Vertical intent — this is a page scroll, not a swipe. Bow out.
        resetSwipe()
        return
      }
      swipe.dragging = true
      closeMenus()
    }

    event.preventDefault()
    const base = swipe.openBefore ? SWIPE_OPEN : 0
    const min = SWIPE_OPEN
    const max = swipe.openBefore ? 0 : SWIPE_HINT_WIDTH
    swipe.x = Math.max(min, Math.min(base + dx, max))
    setSwipeX(swipe.cardEl, swipe.x, false)
  }

  function onSwipeEnd(event) {
    if (!swipe || event.pointerId !== swipe.pointerId) return
    const { id, cardEl, x, dragging, openBefore } = swipe

    document.removeEventListener('pointermove', onSwipeMove)
    document.removeEventListener('pointerup', onSwipeEnd)
    document.removeEventListener('pointercancel', onSwipeEnd)
    swipe = null

    if (!dragging) return

    if (!openBefore && x <= SWIPE_OPEN_TRIGGER) {
      setSwipeX(cardEl, SWIPE_OPEN, true)
      openRowId = id
      return
    }

    setSwipeX(cardEl, 0, true)
    openRowId = null

    if (!openBefore && x >= SWIPE_ASSIGN_TRIGGER) onAssign(id)
  }

  /* ---------------------------------------------------------------
     Wiring
     --------------------------------------------------------------- */

  function onSubmit(event) {
    const form = event.target.closest('.inbox-add')
    if (!form) return
    event.preventDefault()
    const input = form.elements.title
    onQuickAdd(input.value)
    input.value = ''
  }

  function onClick(event) {
    const target = event.target.closest('[data-action]')

    if (!target || !root.contains(target)) {
      closeMenus()
      closeSwipe()
      return
    }

    const { action, id } = target.dataset
    if (action !== 'menu') closeMenus()
    closeSwipe()

    switch (action) {
      case 'edit':
        onEdit(id)
        break
      case 'assign':
        onAssign(id)
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
      case 'retry':
        load()
        break
    }
  }

  function onKeydown(event) {
    if (event.key === 'Escape') {
      closeMenus()
      closeSwipe()
    }
  }

  root.addEventListener('pointerdown', onSwipeStart)
  root.addEventListener('submit', onSubmit)
  document.addEventListener('click', onClick)
  document.addEventListener('keydown', onKeydown)

  load()

  return function unmount() {
    alive = false
    resetSwipe()
    root.removeEventListener('pointerdown', onSwipeStart)
    root.removeEventListener('submit', onSubmit)
    document.removeEventListener('click', onClick)
    document.removeEventListener('keydown', onKeydown)
  }
}
