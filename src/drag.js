// The one dragging engine, shared by the board and the home screen.
//
// Built on pointer events rather than HTML5 drag-and-drop, which never fires
// on iOS. Two ways in, because a mouse and a finger mean different things by
// "press and move":
//
//   - **Mouse:** a press plus a few pixels of travel is a drag. Nothing else
//     is competing for that gesture.
//   - **Touch:** a press *held still* for a moment is a drag. Moving instead
//     of holding is a scroll, and the browser gets it — which is why there is
//     no grip handle any more: the finger can start anywhere on a card.
//
// Once a touch drag is under way the page must stop scrolling underneath it.
// `touch-action` can't do that mid-gesture, so a non-passive `touchmove`
// listener is attached on the way in and calls preventDefault for as long as
// the drag lasts.
//
// Hit-testing is the caller's business: this reports where the pointer is and
// what is being dragged, and the view decides what that means.

/** Pixels of travel before a mouse press becomes a drag. */
const MOUSE_THRESHOLD = 5

/** How far a finger may wander during the long press and still count as held. */
const HOLD_TOLERANCE = 10

/** How long a finger has to stay put before it's a drag rather than a tap. */
const LONG_PRESS_MS = 380

/** Distance from an edge at which a drag starts scrolling, and how hard. */
const SCROLL_MARGIN = 76
const SCROLL_DIVISOR = 3

/** A click fires at the end of a mouse drag, and sometimes after a touch one.
 *  Views check `justDragged()` for this long before treating a click as a tap. */
const CLICK_GRACE_MS = 320

/**
 * Wire dragging for everything under `root` matching `selector`.
 *
 * Returns `{ destroy, isDragging, justDragged, element }` — `element` being
 * whatever is currently in flight, so a view's hit-testing can skip it.
 */
export function createDragEngine({
  root,
  selector,
  blockSelector = 'button, a, input, textarea, select, [contenteditable], [data-no-drag]',
  scroller = () => null,
  onStart = () => {},
  onMove = () => {},
  onDrop = () => {},
  onCancel = () => {},
}) {
  // A press that hasn't become a drag yet, and the drag itself. Never both.
  let pending = null
  let drag = null
  let lastEnd = 0

  function candidate(event) {
    const element = event.target.closest(selector)
    if (!element || !root.contains(element)) return null
    if (blockSelector && event.target.closest(blockSelector)) return null
    return element
  }

  /* ---------------------------------------------------------------
     The drag itself
     --------------------------------------------------------------- */

  function moveGhost(x, y) {
    drag.ghost.style.transform = `translate(${x - drag.offsetX}px, ${y - drag.offsetY}px)`
  }

  function start() {
    const { element, x, y, pointerId, pointerType } = pending
    const rect = element.getBoundingClientRect()

    // Capture on `root`, not the card: a view reparents the card on every move
    // to reorder it, and Safari silently drops pointer capture held by a node
    // the instant that node is moved in the DOM.
    try {
      root.setPointerCapture(pointerId)
    } catch {
      // Capture is a nicety; the document-level listeners below do the work.
    }

    const ghost = element.cloneNode(true)
    ghost.classList.add('drag-ghost')
    ghost.removeAttribute('id')
    for (const chrome of ghost.querySelectorAll('.menu, [data-drag-chrome]')) chrome.remove()
    ghost.style.width = `${rect.width}px`
    document.body.appendChild(ghost)

    drag = {
      element,
      ghost,
      pointerId,
      pointerType,
      offsetX: x - rect.left,
      offsetY: y - rect.top,
    }
    pending = null

    element.classList.add('is-dragging')
    document.body.classList.add('is-dragging-card')
    if (pointerType !== 'mouse') navigator.vibrate?.(12)

    moveGhost(x, y)
    onStart(element)
    onMove(x, y, element)
  }

  /** Nudge the page — and any sideways-scrolling row of drawers — when the
   *  pointer reaches an edge, so a drag can reach off-screen targets. */
  function autoScroll(x, y) {
    if (y < SCROLL_MARGIN) window.scrollBy(0, -Math.ceil((SCROLL_MARGIN - y) / SCROLL_DIVISOR))
    else if (y > innerHeight - SCROLL_MARGIN) {
      window.scrollBy(0, Math.ceil((y - (innerHeight - SCROLL_MARGIN)) / SCROLL_DIVISOR))
    }

    const lane = scroller()
    if (!lane || lane.scrollWidth <= lane.clientWidth) return

    const rect = lane.getBoundingClientRect()
    if (y < rect.top || y > rect.bottom) return

    if (x < rect.left + SCROLL_MARGIN) {
      lane.scrollLeft -= Math.ceil((rect.left + SCROLL_MARGIN - x) / SCROLL_DIVISOR)
    } else if (x > rect.right - SCROLL_MARGIN) {
      lane.scrollLeft += Math.ceil((x - (rect.right - SCROLL_MARGIN)) / SCROLL_DIVISOR)
    }
  }

  function teardownDrag() {
    if (!drag) return null
    const { element, ghost, pointerId } = drag

    ghost.remove()
    element.classList.remove('is-dragging')
    document.body.classList.remove('is-dragging-card')
    if (root.hasPointerCapture?.(pointerId)) root.releasePointerCapture(pointerId)

    drag = null
    lastEnd = Date.now()
    return element
  }

  /* ---------------------------------------------------------------
     Pointer plumbing
     --------------------------------------------------------------- */

  function detach() {
    document.removeEventListener('pointermove', onPointerMove)
    document.removeEventListener('pointerup', onPointerUp)
    document.removeEventListener('pointercancel', onPointerCancel)
    document.removeEventListener('touchmove', onTouchMove)
    document.removeEventListener('contextmenu', onContextMenu, true)
    clearTimeout(pending?.timer)
  }

  function onPointerDown(event) {
    if (drag || pending || event.button !== 0) return

    const element = candidate(event)
    if (!element) return

    pending = {
      element,
      pointerId: event.pointerId,
      pointerType: event.pointerType,
      x: event.clientX,
      y: event.clientY,
      startX: event.clientX,
      startY: event.clientY,
      timer: null,
    }

    // A finger has to hold still; a mouse just has to move. Capture is grabbed
    // once a drag actually starts, not here — capturing on every press
    // retargets the plain-tap `click` that follows to whatever holds capture,
    // which breaks opening a note.
    if (event.pointerType !== 'mouse') {
      pending.timer = setTimeout(() => {
        if (pending) start()
      }, LONG_PRESS_MS)
    }

    document.addEventListener('pointermove', onPointerMove)
    document.addEventListener('pointerup', onPointerUp)
    document.addEventListener('pointercancel', onPointerCancel)
    document.addEventListener('touchmove', onTouchMove, { passive: false })
    document.addEventListener('contextmenu', onContextMenu, true)
  }

  function onPointerMove(event) {
    if (pending) {
      if (event.pointerId !== pending.pointerId) return
      pending.x = event.clientX
      pending.y = event.clientY

      const travelled = Math.hypot(event.clientX - pending.startX, event.clientY - pending.startY)

      if (pending.pointerType === 'mouse') {
        if (travelled < MOUSE_THRESHOLD) return
        start()
      } else {
        // The finger is on its way somewhere — that's a scroll, not a hold.
        if (travelled > HOLD_TOLERANCE) release()
        return
      }
    }

    if (!drag || event.pointerId !== drag.pointerId) return

    event.preventDefault()
    moveGhost(event.clientX, event.clientY)
    onMove(event.clientX, event.clientY, drag.element)
    autoScroll(event.clientX, event.clientY)
  }

  /** Only fires while a touch drag is live — that's the whole point of it. */
  function onTouchMove(event) {
    if (drag && event.cancelable) event.preventDefault()
  }

  /** Android pops its own menu on a long press; ours is the long press. */
  function onContextMenu(event) {
    if (drag || pending?.pointerType === 'touch') event.preventDefault()
  }

  function onPointerUp(event) {
    if (drag && event.pointerId !== drag.pointerId) return
    if (pending && event.pointerId !== pending.pointerId) return

    const element = teardownDrag()
    detach()
    pending = null
    if (element) onDrop(element)
  }

  function onPointerCancel(event) {
    if (drag && event.pointerId !== drag.pointerId) return
    if (pending && event.pointerId !== pending.pointerId) return

    const element = teardownDrag()
    detach()
    pending = null
    // The browser took the gesture back — the view has to put itself right.
    if (element) onCancel(element)
  }

  /** Drop the press without it ever becoming a drag. */
  function release() {
    detach()
    pending = null
  }

  root.addEventListener('pointerdown', onPointerDown)

  return {
    destroy() {
      const element = teardownDrag()
      detach()
      pending = null
      root.removeEventListener('pointerdown', onPointerDown)
      if (element) onCancel(element)
    },
    isDragging: () => Boolean(drag),
    /** True just after a drag ended — the click that follows isn't a tap. */
    justDragged: () => Date.now() - lastEnd < CLICK_GRACE_MS,
    get element() {
      return drag?.element ?? null
    },
  }
}
