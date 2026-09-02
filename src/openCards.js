// Which cards are folded out, remembered between renders and between visits.
//
// A card that was open when you left a board should still be open when you
// come back — this is the sort of thing that only becomes annoying when it
// doesn't happen. Kept in localStorage rather than the database because it's
// about this device's screen, not about the note.

const KEY = 'pensar:open-cards'

/** A cap, so a year of reading notes doesn't grow an unbounded list. */
const LIMIT = 200

function read() {
  try {
    const raw = JSON.parse(localStorage.getItem(KEY) ?? '[]')
    return new Set(Array.isArray(raw) ? raw : [])
  } catch {
    return new Set()
  }
}

const open = read()

function persist() {
  try {
    localStorage.setItem(KEY, JSON.stringify([...open].slice(-LIMIT)))
  } catch {
    // Private mode, or storage blocked — folding still works for this session.
  }
}

export function isCardOpen(id) {
  return open.has(id)
}

/** Fold a card out or back, and report which it now is. */
export function toggleCardOpen(id) {
  if (open.has(id)) open.delete(id)
  else open.add(id)
  persist()
  return open.has(id)
}
