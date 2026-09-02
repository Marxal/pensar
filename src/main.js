import './style.css'
import { supabase } from './supabaseClient'
import { initTheme, cycleTheme, paintThemeButton } from './theme'
import './installPrompt'
import { captureShare } from './share'
import { mountHome } from './homeView'
import { mountBoard } from './boardView'
import { mountArchived } from './archivedView'
import { mountTrash } from './trashView'

const app = document.querySelector('#app')

initTheme()

/* ---------------------------------------------------------------
   Sharing into pensar
   A share from the phone arrives as a fresh load at #/share, put
   there by the service worker — see share.js and public/sw.js.
   It's taken off the URL here, before anything renders, so that a
   refresh doesn't replay it and the login screen doesn't lose it.
   The worker is registered whether or not this load is a share:
   it's what makes the *next* one possible.
   --------------------------------------------------------------- */

if (captureShare()) {
  history.replaceState(null, '', location.pathname + '#/')
}

if ('serviceWorker' in navigator) {
  window.addEventListener('load', () => {
    navigator.serviceWorker
      .register(`${import.meta.env.BASE_URL}sw.js`, { scope: import.meta.env.BASE_URL })
      .catch(() => {
        // No share target on this browser, then. Everything else works.
      })
  })
}

// Tear-down for whatever view is currently mounted, so its listeners go with it.
let unmountView = null
let currentRoute = null

/** Wire a .icon-btn as the theme toggle: system → light → dark → system. */
function mountThemeToggle(button) {
  if (!button) return
  paintThemeButton(button)
  button.addEventListener('click', () => {
    cycleTheme()
    paintThemeButton(button)
  })
}

function renderLogin(errorMessage) {
  app.innerHTML = `
    <div class="login-screen">
      <div>
        <h1>pensar</h1>
        <p>Boards, notes, and a quick-capture inbox, synced across your devices.</p>
      </div>
      <div class="login-card">
        <button class="google-btn" id="google-signin">
          <svg viewBox="0 0 48 48" aria-hidden="true">
            <path fill="#EA4335" d="M24 9.5c3.54 0 6.71 1.22 9.21 3.6l6.85-6.85C35.9 2.38 30.47 0 24 0 14.62 0 6.51 5.38 2.56 13.22l7.98 6.19C12.43 13.72 17.74 9.5 24 9.5z"/>
            <path fill="#4285F4" d="M46.98 24.55c0-1.57-.15-3.09-.38-4.55H24v9.02h12.94c-.58 2.9-2.26 5.36-4.78 7.18l7.73 6c4.51-4.18 7.09-10.36 7.09-17.65z"/>
            <path fill="#FBBC05" d="M10.53 28.59A14.5 14.5 0 0 1 9.5 24c0-1.59.27-3.13.76-4.59l-7.98-6.19A23.94 23.94 0 0 0 0 24c0 3.87.92 7.53 2.56 10.78l7.97-6.19z"/>
            <path fill="#34A853" d="M24 48c6.48 0 11.93-2.13 15.89-5.81l-7.73-6c-2.15 1.45-4.92 2.3-8.16 2.3-6.26 0-11.57-4.22-13.47-9.91l-7.97 6.19C6.51 42.62 14.62 48 24 48z"/>
          </svg>
          Continue with Google
        </button>
        ${errorMessage ? `<p class="login-error">${errorMessage}</p>` : ''}
      </div>
      <button class="icon-btn" id="theme-toggle"></button>
    </div>
  `

  mountThemeToggle(document.querySelector('#theme-toggle'))

  document.querySelector('#google-signin').addEventListener('click', async () => {
    const { error } = await supabase.auth.signInWithOAuth({
      provider: 'google',
      options: { redirectTo: window.location.origin + import.meta.env.BASE_URL },
    })
    if (error) renderLogin(error.message)
  })
}

/* ---------------------------------------------------------------
   Routing
   Hash routes so the phone's back button works and GitHub Pages
   never has to know about our paths.
   --------------------------------------------------------------- */

function parseRoute() {
  const board = location.hash.match(/^#\/board\/([0-9a-f-]{36})$/i)
  if (board) return { name: 'board', id: board[1] }
  if (location.hash === '#/archived') return { name: 'archived' }
  if (location.hash === '#/trash') return { name: 'trash' }
  // Quick notes and projects share the home screen now; #/boards is kept
  // pointing at it so an old bookmark or install shortcut still lands.
  return { name: 'home' }
}

function mountRoute() {
  const view = document.querySelector('#view')
  if (!view) return

  // The "New note" home-screen shortcut (Android only — see the install
  // prompt comment above) lands here as #/new. Scrub it from the URL right
  // away so a refresh or the back button doesn't replay it.
  const isNewNoteShortcut = location.hash === '#/new'
  if (isNewNoteShortcut) {
    history.replaceState(null, '', location.pathname + location.search + '#/')
  }

  const route = parseRoute()

  const key = `${route.name}:${route.id ?? ''}`
  if (key === currentRoute && !isNewNoteShortcut) return
  currentRoute = key

  if (unmountView) unmountView()

  unmountView =
    route.name === 'board'
      ? mountBoard(view, route.id)
      : route.name === 'trash'
        ? mountTrash(view)
        : route.name === 'archived'
          ? mountArchived(view)
          : mountHome(view, { autoFocus: isNewNoteShortcut })
}

// No top header any more — opening a card is the point, and a bar across
// every screen was in the way of that more than it was helping. Trash,
// logout and the theme toggle moved to a quiet row at the foot of Home
// (see homeView.js); a board gets its own way to move between projects
// instead (see boardView.js's project bar).
function renderApp() {
  app.innerHTML = `
    <div class="app-shell">
      <main class="app-content" id="view"></main>
    </div>
  `

  currentRoute = null
  mountRoute()
}

// Auth fires on every token refresh; only rebuild when signed-in state flips.
let signedIn = null

window.addEventListener('hashchange', () => {
  if (signedIn) mountRoute()
})

function render(session) {
  const next = Boolean(session)
  if (next === signedIn) return
  signedIn = next

  if (unmountView) {
    unmountView()
    unmountView = null
  }
  currentRoute = null

  if (next) renderApp()
  else renderLogin()
}

supabase.auth.onAuthStateChange((_event, session) => {
  render(session)
})

supabase.auth.getSession().then(({ data: { session } }) => {
  render(session)
})
