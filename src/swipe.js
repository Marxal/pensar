// Flick a card sideways to archive it.
//
// The phone's counterpart to dragging a card onto the Archive zone: that
// gesture is a press, a hold, and a journey to the top of the screen, which is
// a lot of hand for "not now". A flick — either way, since a card sideways has
// nothing else it could mean — does the same thing and leaves the same undo
// behind it (undo.js), so a swipe made by accident costs one tap.
//
// Touch only, on purpose. A mouse drag is already a reorder at five pixels of
// travel (drag.js), and a pointer has the drop bar to aim at instead.
//
// It shares the card with the drag engine without either knowing about the
// other: a finger held still for a moment is a drag, and one that sets off
// sideways before then is a swipe — drag.js drops its own pending press as
// soon as the finger travels more than ten pixels. `isBlocked` covers the one
// overlap left, which is a drag already under way whose finger then goes
// sideways.
//
// The card can be moved sideways at all because `.card` carries
// `touch-action: pan-y`: the browser keeps the vertical axis for scrolling and
// hands us the horizontal one, so nothing here has to fight a scroll container
// for the gesture. Scrolling *is* ruled out once the swipe is claimed, by the
// same non-passive touchmove listener drag.js uses.

/** Sideways travel before the gesture is claimed as a swipe rather than the
 *  start of a scroll. */
const START_PX = 14

/** How far a card has to go before letting go archives it: a share of its own
 *  width, floored so a narrow drawer doesn't make the gesture twitchy and
 *  capped so a wide one doesn't make it a haul. */
const COMMIT_RATIO = 0.35
const COMMIT_MIN = 80
const COMMIT_MAX = 150

/** How long the card takes to leave the screen once it's committed. */
const FLIGHT_MS = 190

/** A click can still follow a touch that moved. Views check `justSwiped()`
 *  for this long so a swipe never also opens the note. */
const CLICK_GRACE_MS = 320

function commitDistance(width) {
  return Math.min(COMMIT_MAX, Math.max(COMMIT_MIN, width * COMMIT_RATIO))
}

/**
 * Wire swiping for everything under `root` matching `selector`.
 *
 * `icon` and `label` are what shows up in the space the card leaves behind —
 * the caller's, so this module doesn't own a copy of the archive glyph.
 * `onSwipe(element)` runs once the card is off the screen; `isBlocked()` is
 * asked before and during, so a view can hand the gesture to something else.
 *
 * Returns `{ destroy, isSwiping, justSwiped }`.
 */
export function createSwipeAway({
  root,
  selector,
  blockSelector = 'a, input, textarea, select, [contenteditable], [data-no-drag]',
  isBlocked = () => false,
  icon = '',
  label = '',
  onSwipe = () => {},
}) {
  // A finger down on a card that hasn't gone anywhere yet, and the swipe
  // itself. Never both.
  let press = null
  let swipe = null
  let flight = null
  let lastEnd = 0

  function candidate(event) {
    const element = event.target.closest(selector)
    if (!element || !root.contains(element)) return null
    if (blockSelector && event.target.closest(blockSelector)) return null
    return element
  }

  /* ---------------------------------------------------------------
     The swipe itself
     --------------------------------------------------------------- */

  /** What shows through the gap the card leaves: the same action at both ends,
   *  since either direction archives, with the revealed one faded in by how
   *  far the card has gone. Fixed to the card's own box rather than dropped
   *  into the layout — a quick-notes column and a gallery are both masonry,
   *  and an extra child in flow would reflow the lot mid-gesture. */
  function backdrop(rect) {
    const element = document.createElement('div')
    element.className = 'swipe-back'
    element.style.left = `${rect.left}px`
    element.style.top = `${rect.top}px`
    element.style.width = `${rect.width}px`
    element.style.height = `${rect.height}px`

    const action = `<span class="swipe-back-action">${icon}${label ? `<span>${label}</span>` : ''}</span>`
    element.innerHTML = action + action
    return element
  }

  function begin() {
    const { element, pointerId, startX } = press
    const rect = element.getBoundingClientRect()
    const back = backdrop(rect)

    element.parentNode.insertBefore(back, element)
    element.classList.add('is-swiping')

    swipe = { element, back, pointerId, startX, width: rect.width, armed: false }
    press = null
  }

  function moveTo(dx) {
    const { element, back, width } = swipe
    const reach = commitDistance(width)
    const armed = Math.abs(dx) >= reach

    element.style.transform = `translateX(${dx}px)`
    back.dataset.dir = dx < 0 ? 'left' : 'right'
    back.style.setProperty('--swipe-progress', String(Math.min(1, Math.abs(dx) / reach)))

    if (armed === swipe.armed) return
    swipe.armed = armed
    back.classList.toggle('is-armed', armed)
    if (armed) navigator.vibrate?.(10)
  }

  /** Put the card back where it came from — the gesture didn't reach. */
  function snapBack() {
    const { element, back } = swipe

    element.style.transition = 'transform 0.18s ease'
    element.style.transform = ''
    // The backdrop waits for the card to cover it again — taken away now, the
    // gap the card is still sitting beside would show the page through it.
    setTimeout(() => {
      back.remove()
      element.style.transition = ''
      element.classList.remove('is-swiping')
    }, 190)

    swipe = null
    lastEnd = Date.now()
  }

  /** Send it the rest of the way, then tell the view. The view archives on
   *  being told, which re-renders and takes the card with it — so the flight
   *  has to finish first or there'd be nothing left to fly. */
  function commit(dx) {
    const { element, back } = swipe
    const away = dx < 0 ? -window.innerWidth : window.innerWidth

    element.style.transition = `transform ${FLIGHT_MS}ms ease-in, opacity ${FLIGHT_MS}ms ease-in`
    element.style.transform = `translateX(${away}px)`
    element.style.opacity = '0'

    swipe = null
    lastEnd = Date.now()

    flight = setTimeout(() => {
      flight = null
      back.remove()
      onSwipe(element)

      // The view archives by re-rendering, so by now this card is usually a
      // detached node and the rest is a no-op. When it isn't — the view turned
      // the gesture down because it was already busy — the card comes back
      // rather than staying off the side of the screen.
      element.style.transition = ''
      element.style.transform = ''
      element.style.opacity = ''
      element.classList.remove('is-swiping')
    }, FLIGHT_MS)
  }

  /* ---------------------------------------------------------------
     Pointer plumbing
     --------------------------------------------------------------- */

  function detach() {
    document.removeEventListener('pointermove', onPointerMove)
    document.removeEventListener('pointerup', onPointerUp)
    document.removeEventListener('pointercancel', onPointerCancel)
    document.removeEventListener('touchmove', onTouchMove)
  }

  function onPointerDown(event) {
    if (swipe || press || event.pointerType === 'mouse' || isBlocked()) return

    const element = candidate(event)
    if (!element) return

    press = {
      element,
      pointerId: event.pointerId,
      startX: event.clientX,
      startY: event.clientY,
    }

    document.addEventListener('pointermove', onPointerMove)
    document.addEventListener('pointerup', onPointerUp)
    document.addEventListener('pointercancel', onPointerCancel)
    document.addEventListener('touchmove', onTouchMove, { passive: false })
  }

  function onPointerMove(event) {
    if (press) {
      if (event.pointerId !== press.pointerId) return

      const dx = event.clientX - press.startX
      const dy = event.clientY - press.startY

      // Whichever axis the finger commits to first wins the gesture: down the
      // page is a scroll and this never happened, across is a swipe.
      if (Math.abs(dy) > Math.abs(dx) && Math.abs(dy) > START_PX) return release()
      if (Math.abs(dx) < START_PX || Math.abs(dx) <= Math.abs(dy)) return
      if (isBlocked()) return release()

      begin()
    }

    if (!swipe || event.pointerId !== swipe.pointerId) return

    // The drag engine took the finger while we had it — its long press won,
    // so the card is in the air and belongs to that gesture now.
    if (isBlocked()) return cancel()

    event.preventDefault()
    moveTo(event.clientX - swipe.startX)
  }

  /** Only fires while a swipe is live — that's the whole point of it. */
  function onTouchMove(event) {
    if (swipe && event.cancelable) event.preventDefault()
  }

  function onPointerUp(event) {
    if (swipe && event.pointerId !== swipe.pointerId) return
    if (press && event.pointerId !== press.pointerId) return

    const armed = swipe?.armed
    const dx = swipe ? event.clientX - swipe.startX : 0

    detach()
    press = null
    if (!swipe) return

    if (armed) commit(dx)
    else snapBack()
  }

  function onPointerCancel(event) {
    if (swipe && event.pointerId !== swipe.pointerId) return
    if (press && event.pointerId !== press.pointerId) return
    cancel()
  }

  /** The gesture was taken away from us — put the card back, quietly. */
  function cancel() {
    detach()
    press = null
    if (swipe) snapBack()
  }

  /** Drop the press without it ever becoming a swipe. */
  function release() {
    detach()
    press = null
  }

  root.addEventListener('pointerdown', onPointerDown)

  return {
    destroy() {
      cancel()
      // A card mid-flight when the view goes: the archive was never sent, and
      // there's no screen left for it to have happened on.
      clearTimeout(flight)
      flight = null
      root.removeEventListener('pointerdown', onPointerDown)
    },
    isSwiping: () => Boolean(swipe),
    /** True just after a swipe ended — the click that follows isn't a tap. */
    justSwiped: () => Date.now() - lastEnd < CLICK_GRACE_MS,
  }
}
