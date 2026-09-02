// Converts between the markdown stored in body_markdown and the rendered HTML
// the note editor actually shows and edits — the editor is WYSIWYG, so
// markdown itself never appears on screen.
//
// ## Pictures inside a note
//
// The bucket is private, so a note's own pictures can only ever be shown
// through a signed URL that expires within the hour. Writing one of those into
// body_markdown would mean saving a link that is dead by tomorrow, so what
// gets stored is the *storage path*, marked as ours:
//
//     ![](pensar-image/<user id>/n/<uuid>.jpg)
//
// `renderMarkdown` turns that into `<img data-note-image="…">` with no src at
// all, and `hydrateNoteImages` fills the src in once the links come back. The
// round trip out of the editor puts the path back. External pictures — a link
// preview's Open Graph image — are ordinary URLs and pass through untouched.

import { marked } from 'marked'
import DOMPurify from 'dompurify'
import TurndownService from 'turndown'

import { signImages, cachedImage } from './images'

marked.setOptions({ breaks: true })

const turndown = new TurndownService({ bulletListMarker: '-', emDelimiter: '*' })

/** Marks an <img> src as a path in our bucket rather than a URL to fetch.
 *  Deliberately not a custom `scheme:` — a relative-looking path survives
 *  DOMPurify, where an unknown protocol would simply be stripped. */
const NOTE_IMAGE_PREFIX = 'pensar-image/'

/**
 * Parse HTML somewhere inert. A `<template>`'s content belongs to a separate,
 * document-less fragment, so nothing inside it loads, runs or renders — which
 * matters because half the point of these helpers is to look at `<img>` tags
 * before deciding what their src should be.
 */
function parse(html) {
  const template = document.createElement('template')
  template.innerHTML = html
  return template
}

/** Markdown → sanitised HTML, with our own pictures left waiting for a link. */
export function renderMarkdown(text) {
  const template = parse(DOMPurify.sanitize(marked.parse(text ?? '')))

  for (const img of template.content.querySelectorAll('img')) {
    const src = img.getAttribute('src') ?? ''
    if (!src.startsWith(NOTE_IMAGE_PREFIX)) continue
    img.setAttribute('data-note-image', src.slice(NOTE_IMAGE_PREFIX.length))
    img.removeAttribute('src')
  }

  return template.innerHTML
}

/**
 * Give every `<img data-note-image>` under `root` a src. Links already in hand
 * are applied synchronously, so a re-render of something that was on screen a
 * moment ago doesn't blink; anything left over is signed and filled in when it
 * arrives. Safe to call on a subtree that gets replaced meanwhile — an image
 * that has left the document is skipped.
 */
export async function hydrateNoteImages(root) {
  const images = [...root.querySelectorAll('img[data-note-image]')]
  if (!images.length) return

  const missing = []
  for (const img of images) {
    const url = cachedImage(img.dataset.noteImage)
    if (url) img.src = url
    else missing.push(img)
  }
  if (!missing.length) return

  const links = await signImages(missing.map((img) => img.dataset.noteImage))
  for (const img of missing) {
    const url = links.get(img.dataset.noteImage)
    if (url && img.isConnected) img.src = url
  }
}

/**
 * Serialize the note editor's live DOM back to markdown for storage.
 *
 * Two things come out first: the buttons the editor hangs on pictures and link
 * cards, which are an editing affordance and never part of the note, and the
 * signed URLs on our own pictures, which go back to being paths.
 */
export function markdownFromEditor(editor) {
  const clone = editor.cloneNode(true)

  for (const chrome of clone.querySelectorAll('[data-editor-chrome]')) chrome.remove()

  for (const img of clone.querySelectorAll('img[data-note-image]')) {
    img.setAttribute('src', NOTE_IMAGE_PREFIX + img.dataset.noteImage)
    img.removeAttribute('data-note-image')
  }

  return turndown.turndown(clone.innerHTML ?? '').trim()
}

/** Plain text for card headings and excerpts — markdown syntax stripped
 *  rather than shown raw. */
export function plainText(markdown) {
  return (parse(renderMarkdown(markdown)).content.textContent ?? '')
    .replace(/\s+/g, ' ')
    .trim()
}

/**
 * The note's first picture, for a card's thumbnail: `{ path }` for one of ours
 * (needs signing) or `{ url }` for an external one, and null when the note has
 * no pictures at all.
 */
export function firstImage(markdown) {
  const img = parse(renderMarkdown(markdown)).content.querySelector('img')
  if (!img) return null
  if (img.dataset.noteImage) return { path: img.dataset.noteImage }
  const url = img.getAttribute('src')
  return url ? { url } : null
}

/** True when a note has nothing in it — no text, no pictures. */
export function isBlankNote(markdown) {
  if (!markdown?.trim()) return true
  const template = parse(renderMarkdown(markdown))
  if (template.content.querySelector('img')) return false
  return !(template.content.textContent ?? '').trim()
}
