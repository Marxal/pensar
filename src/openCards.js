// Which cards are folded out, remembered between renders and between visits.
//
// Only *decisions* live here. A card you have never folded either way isn't in
// the list at all, and the view works out how it should start — see
// `cardStartsOpen` in cardTile.js, which shows a note by default and only
// folds the ones big enough to be in the way. So the three states are: you
// opened it, you closed it, or you haven't said.
//
// Kept in localStorage rather than the database because it's about this
// device's screen, not about the note.

const KEY = 'pensar:card-folds'

/** A cap, so a year of reading notes doesn't grow an unbounded list. */
const LIMIT = 300

function read() {
  try {
    const raw = JSON.parse(localStorage.getItem(KEY) ?? '{}')
    return raw && typeof raw === 'object' && !Array.isArray(raw) ? new Map(Object.entries(raw)) : new Map()
  } catch {
    return new Map()
  }
}

const folds = read()

function persist() {
  try {
    const kept = [...folds.entries()].slice(-LIMIT)
    localStorage.setItem(KEY, JSON.stringify(Object.fromEntries(kept)))
  } catch {
    // Private mode, or storage blocked — folding still works for this session.
  }
}

/** True, false, or undefined when you've never said either way. */
export function cardFold(id) {
  return folds.get(id)
}

/** Remember that this card is open, or closed. */
export function setCardFold(id, open) {
  // Re-inserting keeps the most recently touched cards at the end, which is
  // the half the cap above keeps.
  folds.delete(id)
  folds.set(id, Boolean(open))
  persist()
}
