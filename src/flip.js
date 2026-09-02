// Sliding things into place instead of teleporting them.
//
// Reordering by drag moves a card (or a drawer, or a project tile) in the DOM,
// and everything after it jumps to its new spot in a single frame. FLIP is the
// standard trick for that: measure where things are (First), do the move
// (Last), work out the difference (Invert) and let the browser animate it away
// (Play).
//
// Two things keep this cheap enough to run mid-drag. The callers only call it
// when the order has actually changed — hovering over the same gap on every
// pointer move does nothing — and the animation is handed to the Web Animations
// API, which runs it off the main thread and cleans up after itself rather than
// leaving inline styles behind for the next render to trip over.

/**
 * Long enough to read as movement, short enough not to lag the finger — and
 * short on purpose for a second reason: while a card is sliding, its
 * `getBoundingClientRect()` reports where it is *now* rather than where it has
 * landed, and that is what the drag hit-testing reads. A long slide would let
 * the pointer chase a card that hasn't arrived yet.
 */
const SLIDE_MS = 160

/** The slide each element is in the middle of, so a second shuffle can call
 *  off the first one without touching any other animation on it — a hover
 *  transition, say, which `getAnimations()` would also hand back. */
const sliding = new WeakMap()

function stillWanted() {
  return !window.matchMedia('(prefers-reduced-motion: reduce)').matches
}

/**
 * Run `mutate`, which reorders the DOM, and slide `elements` from wherever
 * they were to wherever they end up.
 *
 * `skip` is the element being dragged: it's already following the pointer, so
 * animating it as well would fight the ghost.
 */
export function slideInto(elements, mutate, { skip = null } = {}) {
  if (!stillWanted()) {
    mutate()
    return
  }

  const watched = [...elements].filter((element) => element !== skip)
  const before = new Map(watched.map((element) => [element, element.getBoundingClientRect()]))

  mutate()

  for (const element of watched) {
    const first = before.get(element)
    const last = element.getBoundingClientRect()
    const dx = first.left - last.left
    const dy = first.top - last.top
    if (!dx && !dy) continue

    // A card that's still sliding from the last shuffle starts again from
    // where it is now, rather than stacking two animations on top of it.
    sliding.get(element)?.cancel()

    const slide = element.animate(
      [{ transform: `translate(${dx}px, ${dy}px)` }, { transform: 'none' }],
      { duration: SLIDE_MS, easing: 'cubic-bezier(0.2, 0, 0, 1)' }
    )
    sliding.set(element, slide)
    slide.finished.then(() => {
      if (sliding.get(element) === slide) sliding.delete(element)
    }, () => {})
  }
}
