// pensar's service worker has exactly one job: catching what the phone shares.
//
// The Web Share Target API delivers a share as a POST at the URL named in the
// manifest, and a page can't answer a POST aimed at itself — only a service
// worker can. So this one intercepts that single request, puts any pictures
// somewhere the app can reach them, and sends the browser on to `#/share?…`
// with the words in the query and a key per picture. src/share.js takes it
// from there.
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
