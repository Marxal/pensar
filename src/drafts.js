// What's typed into a capture line before it's submitted — quick notes and
// list items alike. A render can happen for reasons that have nothing to do
// with what you're typing (an icon finishing its sign-in, reminders flipping
// on, the install prompt becoming available), and the capture form gets
// rebuilt along with everything else. Without this, that keystroke-in-flight
// text is just gone.
//
// Kept in localStorage rather than the database because it's about this
// device's unsent keystrokes, not a note that exists yet — and it means the
// text survives a reload or a killed tab too, not just an in-app re-render.

const KEY = 'pensar:drafts'

function read() {
  try {
    const raw = JSON.parse(localStorage.getItem(KEY) ?? '{}')
    return raw && typeof raw === 'object' && !Array.isArray(raw) ? raw : {}
  } catch {
    return {}
  }
}

const drafts = read()

function persist() {
  try {
    localStorage.setItem(KEY, JSON.stringify(drafts))
  } catch {
    // Private mode, or storage blocked — drafts still survive in-app renders.
  }
}

/** Whatever's unsent for this field, or '' if there's nothing. */
export function draft(key) {
  return drafts[key] ?? ''
}

/** Remember text typed but not yet submitted. An empty string forgets it. */
export function setDraft(key, text) {
  if (text) drafts[key] = text
  else delete drafts[key]
  persist()
}

/** The field was submitted (or the drawer/note it belonged to is gone) —
 *  nothing left to remember. */
export function clearDraft(key) {
  setDraft(key, '')
}
