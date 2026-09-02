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

const RELATIVE_UNITS = [
  ['year', 31536000],
  ['month', 2592000],
  ['week', 604800],
  ['day', 86400],
  ['hour', 3600],
  ['minute', 60],
]

/** A timestamptz as "just now" / "3 hours ago" / "2 weeks ago" — the discrete
 *  "edited …" line under a note, not a precise clock. */
export function relativeTime(value) {
  if (!value) return ''

  const seconds = Math.floor((Date.now() - new Date(value).getTime()) / 1000)
  if (seconds < 45) return 'just now'

  for (const [unit, unitSeconds] of RELATIVE_UNITS) {
    const count = Math.floor(seconds / unitSeconds)
    if (count >= 1) return `${count} ${unit}${count > 1 ? 's' : ''} ago`
  }
  return 'just now'
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

/** Default reminder time when a due date is set with no time picked — late
 *  enough to have woken up, early enough that the day is still ahead. */
const DEFAULT_REMINDER_TIME = '09:00'

/**
 * The instant a reminder should fire, as an ISO string for `remind_at`, from
 * a `due_date` (`YYYY-MM-DD`) and an optional `due_time` (`HH:MM`). Null when
 * there's no due date — no due date, no reminder.
 *
 * Built with `new Date(year, month, day, hour, minute)` rather than a string
 * Date() would parse as UTC, for the same reason `parseDateOnly` is — a wall
 * clock reading is only what it looks like in the *device's own* timezone,
 * which is the one thing a bare `YYYY-MM-DD` and `HH:MM` never carry with
 * them. Recomputed and re-sent on every save, so editing either field just
 * naturally arms the reminder for the new moment.
 */
export function computeRemindAt(dueDate, dueTime) {
  if (!dueDate) return null

  const [year, month, day] = dueDate.split('-').map(Number)
  const [hour, minute] = (dueTime || DEFAULT_REMINDER_TIME).split(':').map(Number)
  return new Date(year, month - 1, day, hour, minute, 0, 0).toISOString()
}
