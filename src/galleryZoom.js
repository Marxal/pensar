// How many columns a gallery drawer is drawn in, remembered per drawer.
//
// A gallery's shape is `columns` in CSS, and the count used to be whatever the
// browser could fit at a fixed column width — which meant a phone always got
// two and there was no way to say otherwise. Tapping the gallery icon of a
// drawer that is already a gallery cycles the count instead of switching shape,
// and what it lands on is kept here.
//
// A drawer nobody has zoomed isn't in the list at all, and the stylesheet's own
// fallback stands in — two columns normally, four for a drawer being looked at
// on its own. So the two states are: you picked a count, or you haven't.
//
// Kept in localStorage rather than the database because it's about this
// device's screen, not the drawer — the same gallery can reasonably be two
// columns on a phone and four on a desktop.

const KEY = 'pensar:gallery-columns'

/** The counts a tap cycles through, in order. */
export const COLUMN_STEPS = [1, 2, 3, 4]

function read() {
  try {
    const raw = JSON.parse(localStorage.getItem(KEY) ?? '{}')
    return raw && typeof raw === 'object' && !Array.isArray(raw) ? raw : {}
  } catch {
    return {}
  }
}

const columns = read()

function persist() {
  try {
    localStorage.setItem(KEY, JSON.stringify(columns))
  } catch {
    // Private mode, or storage blocked — the zoom still holds for this session.
  }
}

/** The count picked for this drawer, or undefined when nobody has said. */
export function galleryColumns(id) {
  return columns[id]
}

/** Remember a count for this drawer. */
export function setGalleryColumns(id, count) {
  columns[id] = count
  persist()
}

/** The drawer is gone — there's nothing left to remember it by. */
export function forgetGalleryColumns(id) {
  delete columns[id]
  persist()
}

/**
 * The next count in the cycle. With nothing picked yet it starts from what the
 * stylesheet is already showing — `fallback` — so the first tap moves one step
 * from what you can see rather than jumping somewhere arbitrary.
 */
export function nextGalleryColumns(id, fallback) {
  const current = columns[id] ?? fallback
  const at = COLUMN_STEPS.indexOf(current)
  return COLUMN_STEPS[(at + 1) % COLUMN_STEPS.length]
}
