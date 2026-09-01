// A single board: three fixed columns (To do / Doing / Done) driven by the
// card's status, with drag-and-drop between and within them.
//
// Dragging is built on pointer events rather than HTML5 drag-and-drop, which
// never fires on iOS. Mouse drags start anywhere on a card; touch drags start
// from the grip, so a finger on the card body still scrolls the page.

import { getBoard } from './boards'
import {
  STATUSES,
  STATUS_LABELS,
  PRIORITY_LABELS,
  listCards,
  createCard,
  updateCard,
  trashCard,
  moveCard,
  saveOrder,
} from './cards'
import { openCardEditor, openConfirm } from './dialogs'
import { escapeHtml, plural, dueInfo } from './format'
import { plainText, firstImageUrl } from './markdown'

const ICONS = {
  back: `<svg viewBox="0 0 24 24" aria-hidden="true"><path d="M15 5.5 8.5 12l6.5 6.5"/></svg>`,
  more: `<svg viewBox="0 0 24 24" aria-hidden="true"><circle cx="5.5" cy="12" r="1.35" fill="currentColor" stroke="none"/><circle cx="12" cy="12" r="1.35" fill="currentColor" stroke="none"/><circle cx="18.5" cy="12" r="1.35" fill="currentColor" stroke="none"/></svg>`,
  plus: `<svg viewBox="0 0 24 24" aria-hidden="true"><path d="M12 5.5v13M5.5 12h13"/></svg>`,
  grip: `<svg viewBox="0 0 24 24" aria-hidden="true"><circle cx="9" cy="6" r="1.3"/><circle cx="15" cy="6" r="1.3"/><circle cx="9" cy="12" r="1.3"/><circle cx="15" cy="12" r="1.3"/><circle cx="9" cy="18" r="1.3"/><circle cx="15" cy="18" r="1.3"/></svg>`,
  note: `<svg viewBox="0 0 24 24" aria-hidden="true"><path d="M5 4.5h14v15H5zM8.5 9h7M8.5 12.5h7M8.5 16h4"/></svg>`,
}

/** Pixels of movement before a press turns into a drag. */
const DRAG_THRESHOLD = 5

/** Distance from the viewport edge at which a drag starts scrolling. */
const SCROLL_MARGIN = 72

function excerpt(text) {
  return text.length > 110 ? `${text.slice(0, 110)}…` : text
}

/** A title stands in for the heading; a titleless card leans on its note instead. */
function cardHeading(card, bodyText) {
  return card.title.trim() || excerpt(bodyText) || 'Untitled'
}

/**
 * Render one board into `root`. Returns an unmount function that tears down
 * the listeners — call it before replacing `root`'s contents.
 */
export function mountBoard(root, boardId) {
  const state = {
    board: null,
    cards: [],
    status: 'loading', // loading | ready | error | missing
    error: '',
    busy: false, // an action is in flight; blocks double-taps
  }

  let alive = true

  // Drag bookkeeping. `pending` is a press that hasn't passed the threshold yet.
  let pending = null
  let drag = null
  let lastDragEnd = 0
  let activePointerId = null

  /* ---------------------------------------------------------------
     Markup
     --------------------------------------------------------------- */

  function cardMenu(card) {
    const moves = STATUSES.filter((status) => status !== card.status)
      .map(
        (status) =>
          `<button type="button" data-action="move" data-id="${card.id}" data-status="${status}">Move to ${STATUS_LABELS[status]}</button>`
      )
      .join('')

    return `
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
          ${moves}
          <button type="button" class="menu-danger" data-action="delete" data-id="${card.id}">Delete</button>
        </div>
      </div>
    `
  }

  function cardTags(card) {
    const tags = []

    if (card.priority) {
      tags.push(
        `<span class="tag tag-priority tag-${card.priority}">${PRIORITY_LABELS[card.priority]}</span>`
      )
    }

    const due = dueInfo(card.due_date)
    if (due) {
      const tone = due.overdue ? ' is-overdue' : due.today ? ' is-today' : ''
      tags.push(`<span class="tag tag-due${tone}">${escapeHtml(due.label)}</span>`)
    }

    if (card.body_markdown.trim()) {
      tags.push(`<span class="tag tag-note" title="Has a note">${ICONS.note}</span>`)
    }

    return tags.length ? `<div class="card-tags">${tags.join('')}</div>` : ''
  }

  function cardTile(card) {
    const hasTitle = Boolean(card.title.trim())
    const bodyText = plainText(card.body_markdown)
    const heading = cardHeading(card, bodyText)
    // A titleless card already spends its note text on the heading — showing
    // it again underneath would just repeat the same words.
    const body = hasTitle ? excerpt(bodyText) : ''
    const thumb = firstImageUrl(card.body_markdown)

    return `
      <article class="card" data-card="${card.id}" data-action="edit" data-id="${card.id}">
        <button class="card-grip" data-action="grip" tabindex="-1" aria-hidden="true">${ICONS.grip}</button>
        <div class="card-main">
          <div class="card-body">
            <h4 class="card-title">${escapeHtml(heading)}</h4>
            ${body ? `<p class="card-excerpt">${escapeHtml(body)}</p>` : ''}
            ${cardTags(card)}
          </div>
          ${thumb ? `<img class="card-thumb" src="${escapeHtml(thumb)}" alt="" loading="lazy">` : ''}
        </div>
        ${cardMenu(card)}
      </article>
    `
  }

  function cardsIn(status) {
    return state.cards
      .filter((card) => card.status === status)
      .sort((a, b) => a.position - b.position || a.created_at.localeCompare(b.created_at))
  }

  function column(status) {
    const cards = cardsIn(status)

    return `
      <section class="column" data-status="${status}">
        <header class="column-head">
          <h3 class="column-title">${STATUS_LABELS[status]}</h3>
          <span class="column-count">${cards.length}</span>
        </header>
        <div class="column-cards">
          ${cards.map(cardTile).join('')}
          <p class="column-empty"${cards.length ? ' hidden' : ''}>Nothing here yet</p>
        </div>
        <button class="column-add" data-action="add" data-status="${status}">
          ${ICONS.plus} Add card
        </button>
      </section>
    `
  }

  function skeletons() {
    return `
      <div class="kanban">
        ${STATUSES.map(
          (status) => `
            <section class="column">
              <header class="column-head">
                <h3 class="column-title">${STATUS_LABELS[status]}</h3>
              </header>
              <div class="column-cards">
                <div class="card card-skeleton"></div>
                <div class="card card-skeleton"></div>
              </div>
            </section>
          `
        ).join('')}
      </div>
    `
  }

  function render() {
    if (state.status === 'missing') {
      root.innerHTML = `
        <section class="page">
          <header class="page-head">
            <div class="page-head-text">
              <button class="icon-btn" data-action="back" aria-label="Back to boards" title="Back to boards">${ICONS.back}</button>
              <div><h2 class="page-title">Board not found</h2></div>
            </div>
          </header>
          <div class="empty-state">
            <h3>That board isn't here</h3>
            <p>It may have been deleted, or the link is out of date.</p>
            <button class="btn btn-primary" data-action="back">Back to boards</button>
          </div>
        </section>
      `
      return
    }

    const head = `
      <header class="page-head">
        <div class="page-head-text">
          <button class="icon-btn" data-action="back" aria-label="Back to boards" title="Back to boards">${ICONS.back}</button>
          <div>
            <h2 class="page-title">${escapeHtml(state.board?.name ?? 'Board')}</h2>
            <p class="page-sub">${
              state.status === 'ready' ? plural(state.cards.length, 'card') : '&nbsp;'
            }</p>
          </div>
        </div>
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
      body = `<div class="kanban">${STATUSES.map(column).join('')}</div>`
    }

    root.innerHTML = `<section class="page${state.busy ? ' is-busy' : ''}">${head}${body}</section>`
  }

  /* ---------------------------------------------------------------
     Loading
     --------------------------------------------------------------- */

  async function load() {
    state.status = 'loading'
    render()

    try {
      const [board, cards] = await Promise.all([getBoard(boardId), listCards(boardId)])
      if (!alive) return

      if (!board) {
        state.status = 'missing'
        render()
        return
      }

      state.board = board
      state.cards = cards
      state.status = 'ready'
    } catch (error) {
      if (!alive) return
      state.status = 'error'
      state.error = error?.message || 'Could not load this board.'
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

  function cardById(id) {
    return state.cards.find((card) => card.id === id)
  }

  async function onAdd(status) {
    const fields = await openCardEditor({ columnLabel: STATUS_LABELS[status] })
    if (fields) await mutate(() => createCard(boardId, status, fields))
  }

  async function onEdit(id) {
    const card = cardById(id)
    if (!card) return

    const fields = await openCardEditor({ card, columnLabel: STATUS_LABELS[card.status] })
    if (fields) await mutate(() => updateCard(id, fields))
  }

  async function onDelete(id) {
    const card = cardById(id)
    if (!card) return

    const ok = await openConfirm({
      title: `Delete “${cardHeading(card, plainText(card.body_markdown))}”?`,
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
     Drag and drop
     --------------------------------------------------------------- */

  /** Hide the "Drop a card here" hint in any column that now holds cards. */
  function syncEmptyHints() {
    for (const list of root.querySelectorAll('.column-cards')) {
      const hint = list.querySelector('.column-empty')
      if (hint) hint.hidden = Boolean(list.querySelector('.card'))
    }
  }

  function moveGhost(x, y) {
    drag.ghost.style.transform = `translate(${x - drag.offsetX}px, ${y - drag.offsetY}px)`
  }

  /** The column nearest the pointer — inside one wins, otherwise the closest. */
  function nearestColumn(x, y) {
    let best = null
    let bestDistance = Infinity

    for (const element of root.querySelectorAll('.column')) {
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

  /** Slot the dragged card into wherever the pointer is hovering. */
  function placeDragged(x, y) {
    const column = nearestColumn(x, y)
    if (!column) return

    for (const element of root.querySelectorAll('.column')) {
      element.classList.toggle('is-dropping', element === column)
    }

    const list = column.querySelector('.column-cards')
    const siblings = [...list.querySelectorAll(':scope > .card')].filter((el) => el !== drag.element)

    const before = siblings.find((el) => {
      const rect = el.getBoundingClientRect()
      return y < rect.top + rect.height / 2
    })

    if (before) list.insertBefore(drag.element, before)
    else list.appendChild(drag.element)

    syncEmptyHints()
  }

  function autoScroll(y) {
    if (y < SCROLL_MARGIN) window.scrollBy(0, -Math.ceil((SCROLL_MARGIN - y) / 3))
    else if (y > innerHeight - SCROLL_MARGIN) {
      window.scrollBy(0, Math.ceil((y - (innerHeight - SCROLL_MARGIN)) / 3))
    }
  }

  function startDrag() {
    const element = pending.element
    const rect = element.getBoundingClientRect()

    const ghost = element.cloneNode(true)
    ghost.classList.add('card-ghost')
    ghost.querySelector('.menu')?.remove()
    ghost.style.width = `${rect.width}px`
    document.body.appendChild(ghost)

    drag = {
      element,
      ghost,
      offsetX: pending.x - rect.left,
      offsetY: pending.y - rect.top,
    }

    element.classList.add('is-dragging')
    document.body.classList.add('dragging-card')
    moveGhost(pending.x, pending.y)
  }

  function endDrag() {
    if (!drag) return
    drag.ghost.remove()
    drag.element.classList.remove('is-dragging')
    document.body.classList.remove('dragging-card')
    for (const element of root.querySelectorAll('.column.is-dropping')) {
      element.classList.remove('is-dropping')
    }
    drag = null
    lastDragEnd = Date.now()
  }

  /** Read the columns back out of the DOM and persist whatever shifted. */
  async function commitOrder() {
    const byId = new Map(state.cards.map((card) => [card.id, card]))
    const moves = []

    for (const column of root.querySelectorAll('.column')) {
      const { status } = column.dataset
      const elements = column.querySelectorAll('.column-cards > .card')

      elements.forEach((element, position) => {
        const card = byId.get(element.dataset.card)
        if (!card) return
        if (card.status !== status || card.position !== position) {
          moves.push({ id: card.id, status, position })
        }
      })
    }

    if (!moves.length) {
      render()
      return
    }

    // Optimistic: the cards are already where the eye expects them.
    for (const move of moves) {
      const card = byId.get(move.id)
      card.status = move.status
      card.position = move.position
    }
    render()

    try {
      await saveOrder(moves)
    } catch (error) {
      if (!alive) return
      state.status = 'error'
      state.error = error?.message || 'That move did not save.'
      render()
    }
  }

  function releasePointer(pointerId) {
    if (!pending && !drag) return

    root.removeEventListener('pointermove', onPointerMove)
    root.removeEventListener('pointerup', onPointerUp)
    root.removeEventListener('pointercancel', onPointerCancel)
    if (root.hasPointerCapture?.(pointerId)) root.releasePointerCapture(pointerId)
    pending = null
    activePointerId = null
  }

  function onPointerDown(event) {
    if (drag || pending) return
    if (event.button !== 0) return

    const element = event.target.closest('.card')
    if (!element || !root.contains(element) || element.classList.contains('card-skeleton')) return

    const grip = event.target.closest('.card-grip')
    // Touch and pen drag from the grip only, so the page still scrolls.
    if (!grip && event.pointerType !== 'mouse') return
    // A mouse press on the row menu is a click, never a drag.
    if (!grip && event.target.closest('.menu')) return

    pending = { element, x: event.clientX, y: event.clientY }
    activePointerId = event.pointerId
    // Capture on `root`, not the card: `placeDragged` reparents the card on
    // every move to reorder it, and Safari silently drops pointer capture
    // held by a node the instant that node is moved in the DOM — which was
    // freezing the drag after the very first move.
    root.setPointerCapture(event.pointerId)
    root.addEventListener('pointermove', onPointerMove)
    root.addEventListener('pointerup', onPointerUp)
    root.addEventListener('pointercancel', onPointerCancel)
  }

  function onPointerMove(event) {
    if (!drag) {
      const travelled = Math.hypot(event.clientX - pending.x, event.clientY - pending.y)
      if (travelled < DRAG_THRESHOLD) return
      closeMenus()
      startDrag()
    }

    event.preventDefault()
    moveGhost(event.clientX, event.clientY)
    placeDragged(event.clientX, event.clientY)
    autoScroll(event.clientY)
  }

  function onPointerUp(event) {
    const dragged = Boolean(drag)
    endDrag()
    releasePointer(event.pointerId)
    if (dragged) commitOrder()
  }

  function onPointerCancel(event) {
    const dragged = Boolean(drag)
    endDrag()
    releasePointer(event.pointerId)
    // The browser took the gesture back — put the DOM back the way it was.
    if (dragged) render()
  }

  /* ---------------------------------------------------------------
     Wiring
     --------------------------------------------------------------- */

  function onClick(event) {
    // A click fires at the end of a mouse drag; that isn't a tap on the card.
    if (Date.now() - lastDragEnd < 300) return

    const target = event.target.closest('[data-action]')

    if (!target || !root.contains(target)) {
      closeMenus()
      return
    }

    const { action, id, status } = target.dataset
    if (action !== 'menu') closeMenus()

    switch (action) {
      case 'add':
        onAdd(status)
        break
      case 'edit':
        onEdit(id)
        break
      case 'delete':
        onDelete(id)
        break
      case 'move':
        mutate(() => moveCard(id, boardId, status))
        break
      case 'menu':
        toggleMenu(target)
        break
      case 'back':
        location.hash = '#/boards'
        break
      case 'retry':
        load()
        break
      case 'grip':
        // Handled by the pointer listeners; a plain tap does nothing.
        break
    }
  }

  function onKeydown(event) {
    if (event.key === 'Escape') closeMenus()
  }

  root.addEventListener('pointerdown', onPointerDown)
  document.addEventListener('click', onClick)
  document.addEventListener('keydown', onKeydown)

  load()

  return function unmount() {
    alive = false
    endDrag()
    releasePointer(activePointerId)
    root.removeEventListener('pointerdown', onPointerDown)
    document.removeEventListener('click', onClick)
    document.removeEventListener('keydown', onKeydown)
  }
}
