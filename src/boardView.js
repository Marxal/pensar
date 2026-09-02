// One board: as many drawers as you've made, side by side on a wide screen and
// stacked on a phone. A drawer's kind decides how its cards are drawn — see
// cardTile.js — and nothing about a card changes when a drawer changes shape.
//
// Dragging is the shared engine in drag.js: press and move with a mouse, press
// and hold with a finger. Three things can happen at the end of one:
//
//   - dropped between cards, it moves and reorders;
//   - held over another card until it lights up, it merges into it;
//   - dropped on the bar that appears along the bottom, it's archived or binned.

import { getBoard, listBoards, renameBoard, setBoardStyle, archiveBoard, trashBoard } from './boards'
import { listAllDrawers, createDrawer, updateDrawer, deleteDrawer, moveDrawer } from './drawers'
import {
  listCards,
  createCard,
  setCardDone,
  archiveCard,
  trashCard,
  moveCardToDrawer,
  mergeCards,
  saveOrder,
} from './cards'
import { openBoardDialog, openConfirm, openDrawerDialog, openMovePicker } from './dialogs'
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
  back: `<svg viewBox="0 0 24 24" aria-hidden="true"><path d="M15 5.5 8.5 12l6.5 6.5"/></svg>`,
  more: `<svg viewBox="0 0 24 24" aria-hidden="true"><circle cx="5.5" cy="12" r="1.35" fill="currentColor" stroke="none"/><circle cx="12" cy="12" r="1.35" fill="currentColor" stroke="none"/><circle cx="18.5" cy="12" r="1.35" fill="currentColor" stroke="none"/></svg>`,
  plus: `<svg viewBox="0 0 24 24" aria-hidden="true"><path d="M12 5.5v13M5.5 12h13"/></svg>`,
  archive: `<svg viewBox="0 0 24 24" aria-hidden="true"><rect x="3" y="4.5" width="18" height="4" rx="1.2"/><path d="M4.75 8.5v9.25a1.75 1.75 0 0 0 1.75 1.75h11a1.75 1.75 0 0 0 1.75-1.75V8.5M10 12.5h4"/></svg>`,
  trash: `<svg viewBox="0 0 24 24" aria-hidden="true"><path d="M5 7h14M9.5 7V5.2A1.2 1.2 0 0 1 10.7 4h2.6a1.2 1.2 0 0 1 1.2 1.2V7M7.5 7l.7 11.3A1.7 1.7 0 0 0 9.9 20h4.2a1.7 1.7 0 0 0 1.7-1.7L16.5 7M10.3 10.5v6M13.7 10.5v6"/></svg>`,
  check: `<svg viewBox="0 0 24 24" aria-hidden="true"><path d="M5 12.5l4.5 4.5L19 7"/></svg>`,
}

/** How long a card has to be held over another before the two would merge. */
const MERGE_DWELL_MS = 520

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
  }

  let alive = true

  // Drag bookkeeping: the bar zone under the pointer, and the card the dragged
  // one would fold into if it were let go now.
  let zone = null
  let mergeTarget = null
  let mergeCandidate = null
  let mergeTimer = null

  /* ---------------------------------------------------------------
     Markup
     --------------------------------------------------------------- */

  function cardsIn(drawerId) {
    return state.cards
      .filter((card) => card.drawer_id === drawerId)
      .sort((a, b) => a.position - b.position || a.created_at.localeCompare(b.created_at))
  }

  function drawerSection(drawer, index) {
    const cards = cardsIn(drawer.id)

    const adder =
      drawer.kind === 'list'
        ? `<form class="drawer-add-line" data-add-form data-drawer="${drawer.id}">
             <input
               class="drawer-add-input"
               type="text"
               name="title"
               autocomplete="off"
               maxlength="200"
               placeholder="Add an item…"
             />
             <button type="submit" class="icon-btn icon-btn-sm" aria-label="Add" title="Add">${ICONS.plus}</button>
           </form>`
        : `<button type="button" class="drawer-add" data-act="add" data-drawer="${drawer.id}">
             ${ICONS.plus} Add ${drawer.kind === 'gallery' ? 'picture' : 'note'}
           </button>`

    return `
      <section class="drawer" data-drawer="${drawer.id}" data-kind="${drawer.kind}">
        <header class="drawer-head">
          <h3 class="drawer-title">${escapeHtml(drawer.name)}</h3>
          <span class="drawer-count">${cards.length}</span>
          <div class="menu">
            <button
              type="button"
              class="icon-btn icon-btn-sm menu-trigger"
              data-act="menu"
              aria-haspopup="true"
              aria-expanded="false"
              aria-label="Drawer actions"
              title="Drawer actions"
            >${ICONS.more}</button>
            <div class="menu-list" hidden>
              <button type="button" data-act="drawer-edit" data-drawer="${drawer.id}">Rename &amp; reshape…</button>
              <button type="button" data-act="drawer-left" data-drawer="${drawer.id}"${index === 0 ? ' disabled' : ''}>Move earlier</button>
              <button type="button" data-act="drawer-right" data-drawer="${drawer.id}"${
                index === state.drawers.length - 1 ? ' disabled' : ''
              }>Move later</button>
              <button type="button" class="menu-danger" data-act="drawer-delete" data-drawer="${drawer.id}">Delete drawer</button>
            </div>
          </div>
        </header>

        <div class="drawer-cards" data-cards>
          ${cards
            .map((card) => renderCard(card, { kind: drawer.kind, expanded: isCardOpen(card.id) }))
            .join('')}
          <p class="drawer-empty"${cards.length ? ' hidden' : ''}>Nothing here yet</p>
        </div>

        ${adder}
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

    return `
      <header class="page-head">
        <div class="page-head-text">
          <button type="button" class="icon-btn" data-act="back" aria-label="Back" title="Back">${ICONS.back}</button>
          ${state.board ? renderBoardGlyph(state.board, state.images) : ''}
          <div>
            <h2 class="page-title">${escapeHtml(state.board?.name ?? 'Board')}</h2>
            <p class="page-sub">${sub}</p>
          </div>
        </div>
        <div class="page-head-actions">
          <button type="button" class="btn btn-ghost btn-sm" data-act="drawer-new">${ICONS.plus} Drawer</button>
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

  function dropBar() {
    return `
      <div class="drop-bar" data-drop-bar hidden aria-hidden="true">
        <div class="drop-zone" data-zone="archive">${ICONS.archive}<span>Archive</span></div>
        <div class="drop-zone drop-zone-danger" data-zone="delete">${ICONS.trash}<span>Delete</span></div>
      </div>
    `
  }

  function render() {
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
      body = `
        <div class="drawers" data-lane>
          ${state.drawers.map(drawerSection).join('')}
        </div>
      `
    }

    root.innerHTML = `<section class="page${state.busy ? ' is-busy' : ''}">${head()}${body}</section>${dropBar()}`
    hydrateNoteImages(root)
    dressNotes(root)
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
      paintBoardIcon()
    } catch (error) {
      if (!alive) return
      state.status = 'error'
      state.error = error?.message || 'Could not load this board.'
    }
    render()
  }

  /** The board's own icon, which is drawn straight into the header rather than
   *  hydrated afterwards like the pictures on the cards. */
  async function paintBoardIcon() {
    if (!state.board?.icon_path) return

    const links = await signImages([state.board.icon_path])
    if (!alive) return

    const url = links.get(state.board.icon_path)
    if (!url || url === state.images.get(state.board.icon_path)) return
    state.images = links
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
    const { changed } = await openNote(card ? { card } : { drawerId })
    if (changed && alive) await load()
  }

  async function onAddNote(drawerId) {
    await openCard(null, drawerId)
  }

  async function onQuickAdd(drawerId, title) {
    if (!title.trim()) return
    try {
      await createCard(drawerId, { title })
      if (!alive) return
      await load()
      root.querySelector(`[data-add-form][data-drawer="${drawerId}"] input`)?.focus()
    } catch (error) {
      if (!alive) return
      state.status = 'error'
      state.error = error?.message || 'That did not go through.'
      render()
    }
  }

  function onTick(id) {
    const card = cardById(id)
    if (!card) return
    card.done = !card.done
    render()
    mutateQuietly(() => setCardDone(id, card.done))
  }

  async function onDelete(id) {
    const card = cardById(id)
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
    const card = cardById(id)
    if (!card) return

    const picked = await openMovePicker({
      boards: state.boards,
      drawers: state.allDrawers,
      currentDrawerId: card.drawer_id,
    })
    if (picked) await mutate(() => moveCardToDrawer(id, picked.drawerId))
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

  async function onNewDrawer() {
    const fields = await openDrawerDialog()
    if (fields) await mutate(() => createDrawer(boardId, fields))
  }

  async function onEditDrawer(id) {
    const drawer = drawerById(id)
    if (!drawer) return

    const fields = await openDrawerDialog({ drawer })
    if (fields) await mutate(() => updateDrawer(id, fields))
  }

  async function onDeleteDrawer(id) {
    const drawer = drawerById(id)
    if (!drawer) return

    const count = cardsIn(id).length
    const ok = await openConfirm({
      title: `Delete “${drawer.name}”?`,
      message: count
        ? `${plural(count, 'card')} inside will go back to Quick notes — nothing is deleted with it.`
        : 'The drawer is empty, so nothing goes with it.',
      confirmLabel: 'Delete drawer',
      destructive: true,
    })
    if (ok) await mutate(() => deleteDrawer(id))
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
     Dragging
     --------------------------------------------------------------- */

  function dropBarElement() {
    return root.querySelector('[data-drop-bar]')
  }

  /** Which bar zone the pointer is over, if any. */
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

  /** Slot the dragged card into wherever the pointer is hovering. */
  function place(x, y, element) {
    const drawer = nearestDrawer(x, y)
    if (!drawer) return

    for (const other of root.querySelectorAll('.drawer')) {
      other.classList.toggle('is-dropping', other === drawer)
    }

    const list = drawer.querySelector('.drawer-cards')
    const siblings = [...list.querySelectorAll(':scope > .card')].filter((el) => el !== element)

    const before = siblings.find((el) => {
      const rect = el.getBoundingClientRect()
      return y < rect.top + rect.height / 2
    })

    if (before) list.insertBefore(element, before)
    else list.append(element)

    syncEmptyHints()
  }

  /** Read the drawers back out of the DOM and persist whatever shifted. */
  async function commitOrder() {
    const byId = new Map(state.cards.map((card) => [card.id, card]))
    const moves = []

    for (const drawer of root.querySelectorAll('.drawer[data-drawer]')) {
      const drawerId = drawer.dataset.drawer
      drawer.querySelectorAll('.drawer-cards > .card').forEach((element, position) => {
        const card = byId.get(element.dataset.card)
        if (!card) return
        if (card.drawer_id !== drawerId || card.position !== position) {
          moves.push({ id: card.id, drawer_id: drawerId, position })
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
      card.drawer_id = move.drawer_id
      card.position = move.position
    }
    render()
    await mutateQuietly(() => saveOrder(moves))
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
      const bar = dropBarElement()
      if (bar) bar.hidden = false
    },

    onMove(x, y, element) {
      const nextZone = zoneAt(x, y)
      setZone(nextZone)
      if (nextZone) {
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
      const id = element.dataset.card

      finishDrag()

      if (droppedZone === 'delete') mutate(() => trashCard(id))
      else if (droppedZone === 'archive') mutate(() => archiveCard(id))
      else if (target) mutate(() => mergeCards(target.dataset.card, id))
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
    const bar = dropBarElement()
    if (bar) bar.hidden = true
    for (const element of root.querySelectorAll('.drawer.is-dropping')) {
      element.classList.remove('is-dropping')
    }
  }

  /* ---------------------------------------------------------------
     Wiring
     --------------------------------------------------------------- */

  function onSubmit(event) {
    const form = event.target.closest('[data-add-form]')
    if (!form) return
    event.preventDefault()
    const input = form.elements.title
    const title = input.value
    input.value = ''
    onQuickAdd(form.dataset.drawer, title)
  }

  function onClick(event) {
    // A click fires at the end of a drag; that isn't a tap on the card.
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

    const { act, id, drawer } = target.dataset
    if (act !== 'menu') closeMenus()

    switch (act) {
      case 'add':
        onAddNote(drawer)
        break
      case 'open':
        openCard(cardById(id))
        break
      case 'fold':
        toggleCardOpen(id)
        render()
        break
      case 'tick':
        onTick(id)
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
      case 'drawer-new':
        onNewDrawer()
        break
      case 'drawer-edit':
        onEditDrawer(drawer)
        break
      case 'drawer-left':
        mutate(() => moveDrawer(state.drawers, drawer, -1))
        break
      case 'drawer-right':
        mutate(() => moveDrawer(state.drawers, drawer, 1))
        break
      case 'drawer-delete':
        onDeleteDrawer(drawer)
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
      case 'back':
        location.hash = '#/'
        break
      case 'retry':
        load()
        break
    }
  }

  function onKeydown(event) {
    if (event.key === 'Escape') closeMenus()
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
