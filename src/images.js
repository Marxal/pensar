// Cover images for cards: one JPEG per card in the private `pensar-images`
// Storage bucket. See pensar-build-plan.md ("Images") and the
// 20260901115848 migration, which mirrors niu's `avatars` bucket pattern —
// same private-bucket-plus-signed-URL shape, same path-is-the-permission
// security model.

import { supabase } from './supabaseClient'

const BUCKET = 'pensar-images'

/** Longest edge of a stored cover. A phone photo is several megabytes; a
 *  card cover is never drawn larger than the editor's width, so there's no
 *  reason to keep the original size. */
const MAX_EDGE = 1600
const QUALITY = 0.85

/** The largest file worth even trying to decode. Generous, and only here to
 *  fail politely on someone picking a video rather than to police anything. */
export const MAX_INPUT_BYTES = 20 * 1024 * 1024

/** How long a signed URL stays valid before it needs to be re-signed. */
const SIGNED_FOR_SECONDS = 60 * 60

/** Some pickers report no MIME type at all for a perfectly good image. */
export function looksLikeImage(type) {
  return type === '' || type.toLowerCase().startsWith('image/')
}

/**
 * Where a card's cover lives in the bucket.
 *
 * **This shape is the security model, not a convention.** Every policy in
 * the 20260901115848 migration reads the owner out of the first folder, so a
 * path built any other way is a path those policies will refuse — which is
 * why this function and that migration have to change together.
 */
function coverPath(userId, cardId) {
  return `${userId}/${cardId}.jpg`
}

/** Downscale to MAX_EDGE and re-encode as JPEG, via an offscreen canvas.
 *  `imageOrientation: 'from-image'` bakes in EXIF rotation so a phone
 *  camera photo doesn't come out sideways once the EXIF tag is dropped. */
async function toJpeg(file) {
  const bitmap = await createImageBitmap(file, { imageOrientation: 'from-image' })
  const scale = Math.min(1, MAX_EDGE / Math.max(bitmap.width, bitmap.height))
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

/** Upload `file` as `cardId`'s cover image and return the storage path to save. */
export async function uploadCoverImage(cardId, file) {
  const {
    data: { session },
  } = await supabase.auth.getSession()
  if (!session) throw new Error('Signed out.')

  const blob = await toJpeg(file)
  const path = coverPath(session.user.id, cardId)

  const { error } = await supabase.storage
    .from(BUCKET)
    .upload(path, blob, { upsert: true, contentType: 'image/jpeg' })
  if (error) throw error

  return path
}

/** Best-effort delete — losing the object is a leftover file, not data loss. */
export async function removeCoverImage(path) {
  if (!path) return
  await supabase.storage.from(BUCKET).remove([path])
}

/**
 * Fetch a signed link for every given path, in one call. Returns a Map of
 * path → signed URL; a path that failed to sign is simply missing from it,
 * so a card whose cover won't sign just falls back to showing nothing.
 */
export async function signCoverImages(paths) {
  const unique = [...new Set(paths.filter(Boolean))]
  if (!unique.length) return new Map()

  const { data, error } = await supabase.storage.from(BUCKET).createSignedUrls(unique, SIGNED_FOR_SECONDS)
  if (error || !data) return new Map()

  const links = new Map()
  for (const row of data) {
    if (row.path && row.signedUrl) links.set(row.path, row.signedUrl)
  }
  return links
}
