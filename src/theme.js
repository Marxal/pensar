// Theme: 'system' (follow the OS), or a manual 'light' / 'dark' override.
// The override is written to <html data-theme> and persisted in localStorage.
// index.html applies the stored value before first paint so there's no flash.

const STORAGE_KEY = 'pensar:theme'
const MODES = ['system', 'light', 'dark']

const PAPER = { light: '#faf6ef', dark: '#17150f' }

const systemDark = window.matchMedia('(prefers-color-scheme: dark)')
const listeners = new Set()

function readStored() {
  try {
    const value = localStorage.getItem(STORAGE_KEY)
    return MODES.includes(value) ? value : 'system'
  } catch {
    return 'system'
  }
}

let mode = readStored()

export function getTheme() {
  return mode
}

/** The theme actually on screen: 'light' or 'dark'. */
export function getResolvedTheme() {
  if (mode === 'system') return systemDark.matches ? 'dark' : 'light'
  return mode
}

function apply() {
  const root = document.documentElement
  if (mode === 'system') {
    root.removeAttribute('data-theme')
  } else {
    root.setAttribute('data-theme', mode)
  }

  const meta = document.querySelector('meta[name="theme-color"]')
  if (meta) meta.setAttribute('content', PAPER[getResolvedTheme()])

  for (const fn of listeners) fn(mode, getResolvedTheme())
}

export function setTheme(next) {
  mode = MODES.includes(next) ? next : 'system'
  try {
    if (mode === 'system') localStorage.removeItem(STORAGE_KEY)
    else localStorage.setItem(STORAGE_KEY, mode)
  } catch {
    // private mode / storage blocked — the theme still applies for this session
  }
  apply()
}

/** system → light → dark → system */
export function cycleTheme() {
  setTheme(MODES[(MODES.indexOf(mode) + 1) % MODES.length])
  return mode
}

export function onThemeChange(fn) {
  listeners.add(fn)
  return () => listeners.delete(fn)
}

export function initTheme() {
  // Only matters while following the system.
  systemDark.addEventListener('change', () => {
    if (mode === 'system') apply()
  })
  apply()
}

const ICONS = {
  system: `<svg viewBox="0 0 24 24" aria-hidden="true"><rect x="2.75" y="4" width="18.5" height="13" rx="2"/><path d="M8.5 20.5h7M12 17v3.5"/></svg>`,
  light: `<svg viewBox="0 0 24 24" aria-hidden="true"><circle cx="12" cy="12" r="4.25"/><path d="M12 2.5v2.2M12 19.3v2.2M4.28 4.28l1.56 1.56M18.16 18.16l1.56 1.56M2.5 12h2.2M19.3 12h2.2M4.28 19.72l1.56-1.56M18.16 5.84l1.56-1.56"/></svg>`,
  dark: `<svg viewBox="0 0 24 24" aria-hidden="true"><path d="M20.5 14.4A8.6 8.6 0 0 1 9.6 3.5a8.6 8.6 0 1 0 10.9 10.9z"/></svg>`,
}

const LABELS = {
  system: 'Theme: system',
  light: 'Theme: light',
  dark: 'Theme: dark',
}

/** Paint a button element to match the current mode. */
export function paintThemeButton(button) {
  button.innerHTML = ICONS[mode]
  button.setAttribute('aria-label', LABELS[mode])
  button.setAttribute('title', `${LABELS[mode]} — click to change`)
}
