// One line along the bottom saying what just happened, with a way to take it
// back.
//
// Everything that moves a card without asking first — a merge, a note dropped
// on a project, a card thrown at the delete bar, a drawer deleted with its
// contents — offers an undo here rather than a confirmation up front. Gestures
// are meant to be fast; a confirm dialog on each of them would undo that, and
// the honest answer to "did you mean that?" is usually "let me see it first".
//
// Only one at a time, and the offer expires: an undo you can still take an
// hour later is a version history, which this isn't.

/** How long the offer stands. Long enough to read the line and reconsider. */
const OFFER_MS = 9000

let toast = null
let timer = null

/** Take the current offer off the screen without acting on it. */
export function dismissUndo() {
  clearTimeout(timer)
  timer = null
  toast?.remove()
  toast = null
}

/**
 * Say what happened, and offer to reverse it.
 *
 * `undo` is whatever puts things back — usually the view's own `mutate(…)`,
 * so a failure lands in the same error banner as everything else and the view
 * reloads itself afterwards.
 */
export function offerUndo({ message, undo, duration = OFFER_MS }) {
  dismissUndo()

  toast = document.createElement('div')
  toast.className = 'undo-toast'
  toast.setAttribute('role', 'status')
  toast.innerHTML = `<span class="undo-text"></span><button type="button" class="undo-btn">Undo</button>`
  toast.querySelector('.undo-text').textContent = message

  toast.querySelector('.undo-btn').addEventListener('click', () => {
    dismissUndo()
    undo()
  })

  document.body.append(toast)
  timer = setTimeout(dismissUndo, duration)
}
