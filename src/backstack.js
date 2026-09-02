// Makes the phone's back gesture close whatever is on top.
//
// Every overlay — the note editor, the picture viewer — pushes an entry here
// when it opens. A back swipe pops the topmost one instead of leaving the
// screen; closing an overlay from its own button hands the history entry back
// so the two stay level and the browser's own back button keeps working.
//
// The pushed entries all sit on the same URL, so `hashchange` never fires for
// them and the router in main.js stays out of it.

const stack = []

/** Pops we caused ourselves, which must not close anything a second time. */
let expected = 0

function onPopState() {
  if (expected > 0) {
    expected -= 1
    return
  }

  const entry = stack.pop()
  if (!stack.length) window.removeEventListener('popstate', onPopState)
  entry?.close()
}

/**
 * Register `close` as the back gesture's job until it's disposed.
 *
 * Returns a dispose function for the overlay to call when it closes itself —
 * that gives the history entry back. Calling it after a back gesture already
 * closed the overlay is a no-op, so a close path doesn't have to know which
 * of the two happened.
 */
export function pushBackHandler(close) {
  if (!stack.length) window.addEventListener('popstate', onPopState)

  history.pushState({ pensarOverlay: stack.length + 1 }, '')
  const entry = { close }
  stack.push(entry)

  return function dispose() {
    const index = stack.indexOf(entry)
    if (index === -1) return // the back gesture got here first

    stack.splice(index, 1)
    if (!stack.length) window.removeEventListener('popstate', onPopState)

    expected += 1
    history.back()
  }
}
