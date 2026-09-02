// The "Install" button lives on Home now, but `beforeinstallprompt` and
// `appinstalled` are page-lifetime events — they can fire while some other
// view is mounted, not just while Home's button happens to exist in the DOM.
// Kept here, independent of routing, so Home can ask "is one available?"
// whenever it (re)mounts rather than racing the event itself.
//
// Chrome/Edge only (desktop + Android). iOS has no such event — there,
// installing only ever happens via Safari's own Share ▸ Add to Home Screen,
// which needs no button of ours, so `installAvailable()` just stays false.

let deferred = null
const listeners = new Set()

function notify() {
  for (const fn of listeners) fn()
}

window.addEventListener('beforeinstallprompt', (event) => {
  event.preventDefault()
  deferred = event
  notify()
})

window.addEventListener('appinstalled', () => {
  deferred = null
  notify()
})

export function installAvailable() {
  return Boolean(deferred)
}

/** Fires whenever `installAvailable()` might have changed. Returns an
 *  unsubscribe function. */
export function onInstallAvailabilityChange(fn) {
  listeners.add(fn)
  return () => listeners.delete(fn)
}

export async function promptInstall() {
  if (!deferred) return
  deferred.prompt()
  await deferred.userChoice
  deferred = null
  notify()
}
