// Every image pensar stores: a card's cover, the pictures dropped inside a
// note, and a board's icon. All of them live in the private `pensar-images`
// Storage bucket, and all of them are reached through a signed URL that
// expires — see the 20260901115848 migration, which mirrors niu's `avatars`
// bucket: same private-bucket-plus-signed-URL shape, same path-is-the-
// permission security model.

import { supabase } from './supabaseClient'

const BUCKET = 'pensar-images'

/** Longest edge of a stored picture. A phone photo is several megabytes; a
 *  note is never drawn wider than a column of text, so there's no reason to
 *  keep the original size. Icons are small on screen and get less again. */
const MAX_EDGE = 1600
const ICON_MAX_EDGE = 512
const QUALITY = 0.85

/** The largest file worth even trying to decode. Generous, and only here to
 *  fail politely on someone picking a video rather than to police anything. */
const MAX_INPUT_BYTES = 20 * 1024 * 1024

/** How long a signed URL stays valid before it needs to be re-signed. */
const SIGNED_FOR_SECONDS = 60 * 60

/** …and how long we'll reuse one before asking for a fresh one. Comfortably
 *  inside the hour above, so a link handed out from cache can't expire while
 *  it's still on screen. A board full of notes re-renders on every expand,
 *  tick and drag; re-signing each of those would be a round trip a piece. */
const CACHE_FOR_MS = 45 * 60 * 1000

/** Some pickers report no MIME type at all for a perfectly good image. */
export function looksLikeImage(type) {
  return type === '' || String(type).toLowerCase().startsWith('image/')
}

/**
 * Where each kind of image lives in the bucket.
 *
 * **This shape is the security model, not a convention.** Every policy in the
 * 20260901115848 migration reads the owner out of the first folder, so a path
 * built any other way is a path those policies will refuse — which is why
 * these functions and that migration have to change together.
 *
 * Only the first folder is load-bearing; the `n/` and `b/` below are ours, to
 * keep note pictures and board icons apart from each other and from the card
 * covers that used to sit at the root before the 20260901230500 migration
 * folded them into the notes themselves.
 *
 * Note pictures are named after nothing in particular on purpose: a note can
 * hold any number of them, and one dropped into a note that hasn't been saved
 * yet has no card id to be named after.
 */
function notePath(userId) {
  return `${userId}/n/${crypto.randomUUID()}.jpg`
}

function boardIconPath(userId, boardId) {
  return `${userId}/b/${boardId}.jpg`
}

async function currentUserId() {
  const {
    data: { session },
  } = await supabase.auth.getSession()
  if (!session) throw new Error('Signed out.')
  return session.user.id
}

/** Downscale to `maxEdge` and re-encode as JPEG, via an offscreen canvas.
 *  `imageOrientation: 'from-image'` bakes in EXIF rotation so a phone camera
 *  photo doesn't come out sideways once the EXIF tag is dropped. */
async function toJpeg(file, maxEdge = MAX_EDGE) {
  const bitmap = await createImageBitmap(file, { imageOrientation: 'from-image' })
  const scale = Math.min(1, maxEdge / Math.max(bitmap.width, bitmap.height))
  const width = Math.round(bitmap.width * scale)
  const height = Math.round(bitmap.height * scale)

  const canvas = document.createElement('canvas')
  canvas.width = width
  canvas.height = height
  canvas.getContext('2d').drawImage(bitmap, 0, 0, width, height)
  bitmap.close?.()

  return new Promise((resolve, reject) => {
    canvas.toBlob(
      (blob) => (blob ? resolve(blob) : reject(new Error('Could not process that image.'))),
      'image/jpeg',
      QUALITY
    )
  })
}

/** Reject a file that isn't a picture, or is far too big to be one, before
 *  spending a decode on it. Throws with a sentence worth showing. */
function assertUsableImage(file) {
  if (!looksLikeImage(file.type)) throw new Error("That doesn't look like an image.")
  if (file.size > MAX_INPUT_BYTES) throw new Error('That image is too large.')
}

async function upload(path, blob) {
  const { error } = await supabase.storage
    .from(BUCKET)
    .upload(path, blob, { upsert: true, contentType: 'image/jpeg' })
  if (error) throw error
  forget(path)
  return path
}

/** Upload a picture for the body of a note and return its storage path. */
export async function uploadNoteImage(file) {
  assertUsableImage(file)
  const userId = await currentUserId()
  return upload(notePath(userId), await toJpeg(file))
}

/** Upload a board's icon and return its storage path. */
export async function uploadBoardIcon(boardId, file) {
  assertUsableImage(file)
  const userId = await currentUserId()
  return upload(boardIconPath(userId, boardId), await toJpeg(file, ICON_MAX_EDGE))
}

/**
 * Best-effort delete — losing the object is a leftover file, not data loss.
 *
 * Only used where a picture is unambiguously finished with: a board icon,
 * which belongs to one board and nothing else. A picture taken out of a note
 * is deliberately left in the bucket, because merging two notes copies the
 * markdown that refers to it and there is no cheap way to be sure the last
 * mention has gone. An orphaned JPEG is the cheaper mistake.
 */
export async function removeImage(path) {
  if (!path) return
  forget(path)
  await supabase.storage.from(BUCKET).remove([path])
}

/* ---------------------------------------------------------------
   Signing
   --------------------------------------------------------------- */

const cache = new Map() // path → { url, expires }

function forget(path) {
  cache.delete(path)
}

/**
 * Fetch a signed link for every given path, in one call. Returns a Map of
 * path → signed URL; a path that failed to sign is simply missing from it, so
 * a card whose picture won't sign just falls back to showing nothing.
 *
 * Links already in hand are reused rather than re-signed, which is what makes
 * it safe for a view to call this on every render.
 */
export async function signImages(paths) {
  const now = Date.now()
  const links = new Map()
  const wanted = []

  for (const path of new Set(paths.filter(Boolean))) {
    const hit = cache.get(path)
    if (hit && hit.expires > now) links.set(path, hit.url)
    else wanted.push(path)
  }

  if (!wanted.length) return links

  const { data, error } = await supabase.storage
    .from(BUCKET)
    .createSignedUrls(wanted, SIGNED_FOR_SECONDS)
  if (error || !data) return links

  for (const row of data) {
    if (!row.path || !row.signedUrl) continue
    cache.set(row.path, { url: row.signedUrl, expires: now + CACHE_FOR_MS })
    links.set(row.path, row.signedUrl)
  }
  return links
}

/** The signed link for one path, or null. */
export async function signImage(path) {
  if (!path) return null
  const links = await signImages([path])
  return links.get(path) ?? null
}

/** A link already in hand for `path`, without a round trip. Null when there
 *  isn't one — the caller renders blank and lets `signImages` fill it in. */
export function cachedImage(path) {
  const hit = path ? cache.get(path) : null
  return hit && hit.expires > Date.now() ? hit.url : null
}
