// Things shared into pensar from the phone's share sheet.
//
// Android hands a share to a web app through the Web Share Target API: the
// manifest names a URL, the browser POSTs a form at it, and `public/sw.js`
// catches that POST — a service worker being the only thing that can — writes
// any pictures into a Cache, and sends the app to `#/share?…` with the words
// in the query and a key per picture.
//
// This module is the other half. It takes the share off the URL before
// anything else can act on it, keeps it until there is a signed-in home screen
// to put it on, and turns it into quick notes. Nothing is thrown away on the
// way: a share that fails to save (no signal, signed out, a picture that won't
// upload) stays put and is tried again on the next load.
//
// iOS has no share target — Safari doesn't implement it for web apps at all —
// so on an iPhone this simply never fires and nothing else changes.

import { createCard, createQuickNote } from './cards'
import { uploadNoteImage } from './images'
import { linkifyMarkdown } from './linkify'

const PENDING_KEY = 'pensar:pending-share'

/** Where sw.js leaves the pictures. The name is shared with it by hand. */
const SHARE_CACHE = 'pensar-share'

function paramsIn(hash) {
  const start = hash.indexOf('?')
  return new URLSearchParams(start === -1 ? '' : hash.slice(start + 1))
}

function stash(payload) {
  try {
    sessionStorage.setItem(PENDING_KEY, JSON.stringify(payload))
  } catch {
    // Storage blocked: the share is lost, which is no worse than it not
    // having arrived. Nothing else depends on this.
  }
}

function stashed() {
  try {
    const raw = sessionStorage.getItem(PENDING_KEY)
    return raw ? JSON.parse(raw) : null
  } catch {
    return null
  }
}

function forget() {
  try {
    sessionStorage.removeItem(PENDING_KEY)
  } catch {
    // Nothing to do about it.
  }
}

/**
 * If this load is a share, take it off the URL and hold on to it. Returns true
 * when it was one, which is the caller's cue to put the address bar back to
 * the home screen so a refresh doesn't replay it.
 *
 * Words arrive in the hash (our service worker's doing) or in the query (a
 * plain GET share, which is what a browser without file support would send),
 * so both are read.
 */
export function captureShare() {
  if (!location.hash.startsWith('#/share')) return false

  const fromHash = paramsIn(location.hash)
  const fromQuery = new URLSearchParams(location.search)
  const pick = (key) => (fromHash.get(key) || fromQuery.get(key) || '').trim()

  const payload = {
    title: pick('title'),
    text: pick('text'),
    url: pick('url'),
    files: fromHash.getAll('file'),
  }

  if (payload.title || payload.text || payload.url || payload.files.length) stash(payload)
  return true
}

/**
 * What a shared link or note should read as.
 *
 * A share sheet is generous with the same string: Android often sends the page
 * title as `title` *and* inside `text`, and a link as both `text` and `url`.
 * Anything already said is dropped rather than written twice.
 */
function wordsOf({ title, text, url }) {
  const lines = []
  if (title && title !== text && title !== url) lines.push(title)
  if (text && text !== url) lines.push(text)
  if (url && !lines.some((line) => line.includes(url))) lines.push(url)
  return lines.join('\n\n')
}

async function shareCache() {
  try {
    return 'caches' in globalThis ? await caches.open(SHARE_CACHE) : null
  } catch {
    return null
  }
}

async function takeFile(cache, key) {
  if (!cache) return null
  const response = await cache.match(key)
  if (!response) return null

  const blob = await response.blob()
  const type = response.headers.get('content-type') || blob.type || 'image/jpeg'
  return new File([blob], 'shared', { type })
}

/**
 * Write whatever is waiting into Quick notes, and hand back the notes it came
 * to — the caller looks their links up (see linkCard.js), which is the whole
 * point of a share that is a link. Safe to call on every home load: with
 * nothing waiting it does nothing and costs nothing.
 *
 * Throws if a note couldn't be written, leaving whatever hasn't been saved yet
 * for the next attempt.
 */
export async function takeSharedNotes() {
  const payload = stashed()
  if (!payload) return []

  const cache = await shareCache()
  // A share sheet hands over a bare URL; the note stores markdown, so it is
  // linked here rather than left as a row of characters.
  const words = linkifyMarkdown(wordsOf(payload))
  const made = []

  // Each picture is dropped from the payload the moment its note exists, so a
  // failure halfway through doesn't write the earlier ones a second time.
  for (const key of [...(payload.files ?? [])]) {
    const file = await takeFile(cache, key)

    if (file) {
      const path = await uploadNoteImage(file)
      // The words go on the first picture rather than into a note of their
      // own — a photo shared with a caption is one thing, not two.
      const caption = made.length === 0 && words ? `${words}\n\n` : ''
      made.push(await createCard(null, { body_markdown: `${caption}![](pensar-image/${path})` }))
    }

    payload.files = payload.files.filter((other) => other !== key)
    stash(payload)
    await cache?.delete(key)
  }

  if (words && made.length === 0) made.push(await createQuickNote(words))

  forget()
  return made
}
