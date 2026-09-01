// Small formatting helpers shared by the views and the modals.

const longDate = new Intl.DateTimeFormat(undefined, {
  day: 'numeric',
  month: 'short',
  year: 'numeric',
})

const shortDate = new Intl.DateTimeFormat(undefined, {
  day: 'numeric',
  month: 'short',
})

export function escapeHtml(value) {
  return String(value).replace(
    /[&<>"']/g,
    (ch) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[ch]
  )
}

/** Format a timestamptz. */
export function formatDate(value) {
  return value ? longDate.format(new Date(value)) : ''
}

export function plural(count, singular, pluralForm = `${singular}s`) {
  return `${count} ${count === 1 ? singular : pluralForm}`
}

/**
 * Parse a `YYYY-MM-DD` date column as a *local* date. `new Date(string)` would
 * read it as UTC midnight, which shows the wrong day west of Greenwich.
 */
function parseDateOnly(value) {
  const [year, month, day] = String(value).split('-').map(Number)
  return new Date(year, month - 1, day)
}

/** Trim a `YYYY-MM-DD` out of a Date, for prefilling <input type="date">. */
export function toDateInput(date) {
  const pad = (n) => String(n).padStart(2, '0')
  return `${date.getFullYear()}-${pad(date.getMonth() + 1)}-${pad(date.getDate())}`
}

/**
 * Describe a due date relative to today: `{ label, overdue, today }`.
 * Returns null when there is no due date.
 */
export function dueInfo(value) {
  if (!value) return null

  const date = parseDateOnly(value)
  const today = new Date()
  today.setHours(0, 0, 0, 0)

  const days = Math.round((date - today) / 86400000)

  let label
  if (days === 0) label = 'Today'
  else if (days === 1) label = 'Tomorrow'
  else if (days === -1) label = 'Yesterday'
  else if (date.getFullYear() === today.getFullYear()) label = shortDate.format(date)
  else label = longDate.format(date)

  return { label, overdue: days < 0, today: days === 0 }
}
