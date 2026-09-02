// pensar's service worker has two jobs: catching what the phone shares, and
// showing a reminder push when one arrives.
//
// The Web Share Target API delivers a share as a POST at the URL named in the
// manifest, and a page can't answer a POST aimed at itself — only a service
// worker can. So this one intercepts that single request, puts any pictures
// somewhere the app can reach them, and sends the browser on to `#/share?…`
// with the words in the query and a key per picture. src/share.js takes it
// from there.
//
// A push arrives the same way niu's does (see that repo's public/sw.js) —
// `pensar-send-reminder` (supabase/functions/pensar-send-reminder/index.ts)
// sends `{ title, body, tag, url }`, and `notificationclick` opens the app on
// whichever board the card is on, or Home for a quick note.
//
// Everything else is deliberately left alone. Nothing is precached and no
// other request is touched, because pensar is an always-online app — an
// offline mode was ruled out from the start, and a worker that caches app
// files would only serve yesterday's build.

const SHARE_CACHE = 'pensar-share'

/** The manifest's share_target action, relative to the worker's scope. */
const SHARE_PATH = 'share-target'

self.addEventListener('install', () => self.skipWaiting())

self.addEventListener('activate', (event) => event.waitUntil(self.clients.claim()))

self.addEventListener('fetch', (event) => {
  if (event.request.method !== 'POST') return

  const url = new URL(event.request.url)
  if (!url.pathname.endsWith(`/${SHARE_PATH}`)) return

  event.respondWith(receiveShare(event.request))
})

async function receiveShare(request) {
  const params = new URLSearchParams()

  try {
    const form = await request.formData()

    for (const key of ['title', 'text', 'url']) {
      const value = form.get(key)
      if (typeof value === 'string' && value.trim()) params.set(key, value.trim())
    }

    const files = form.getAll('files').filter((file) => file && file.size)
    if (files.length) {
      const cache = await caches.open(SHARE_CACHE)

      for (const file of files) {
        const key = new URL(
          `shared/${Date.now()}-${Math.random().toString(36).slice(2)}`,
          self.registration.scope
        ).href

        await cache.put(
          key,
          new Response(file, {
            headers: { 'content-type': file.type || 'application/octet-stream' },
          })
        )
        params.append('file', key)
      }
    }
  } catch {
    // Whatever went wrong, still open the app rather than showing the browser's
    // own error page at a URL that isn't really a page.
  }

  const target = new URL(`#/share?${params.toString()}`, self.registration.scope)
  return Response.redirect(target.href, 303)
}

/* ---------------------------------------------------------------
   Reminders
   --------------------------------------------------------------- */

self.addEventListener('push', (event) => {
  let message = {}
  try {
    message = event.data ? event.data.json() : {}
  } catch {
    // Not JSON. Fall through to the generic notification below.
  }

  const title = message.title || 'pensar'
  const body = message.body || 'A card is due.'

  event.waitUntil(
    self.registration.showNotification(title, {
      body,
      icon: './icons/icon-192.png',
      badge: './icons/icon-192.png',
      // Replaces an earlier notification for the same card rather than
      // stacking a second one under it.
      tag: message.tag || 'pensar-reminder',
      renotify: Boolean(message.tag),
      data: { url: message.url || './' },
      vibrate: [80, 40, 80],
    })
  )
})

/**
 * Tapping a notification opens the app on the card's board (or Home, for a
 * quick note) — see `buildMessage` in pensar-send-reminder/index.ts for
 * where `url` comes from.
 *
 * Focusing a window that's already open matters more than it sounds: opening
 * a second one leaves the person with two copies of an installed app and no
 * idea which is which. So an existing window is found first, and a new one
 * is only opened as a last resort — same reasoning as receiveShare() above
 * not hard-coding a path, since nothing here knows the folder it's served
 * from except its own scope.
 */
async function openReminder(path) {
  const target = new URL(path, self.registration.scope)
  const windows = await self.clients.matchAll({ type: 'window', includeUncontrolled: true })

  for (const client of windows) {
    if (client.url.startsWith(self.registration.scope)) {
      if ('navigate' in client) await client.navigate(target.href)
      if ('focus' in client) return await client.focus()
      return
    }
  }

  await self.clients.openWindow(target.href)
}

self.addEventListener('notificationclick', (event) => {
  event.notification.close()
  event.waitUntil(openReminder(event.notification.data?.url || './'))
})
