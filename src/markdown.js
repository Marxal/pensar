// Converts between the markdown stored in body_markdown and the rendered
// HTML the note editor actually shows and edits (see dialogs.js) — the
// editor is WYSIWYG, so markdown itself never appears on screen.

import { marked } from 'marked'
import DOMPurify from 'dompurify'
import TurndownService from 'turndown'

marked.setOptions({ breaks: true })

const turndown = new TurndownService({ bulletListMarker: '-', emDelimiter: '*' })

export function renderMarkdown(text) {
  const html = marked.parse(text ?? '')
  return DOMPurify.sanitize(html)
}

/** Serialize the editor's live HTML back to markdown for storage. */
export function markdownFromHtml(html) {
  return turndown.turndown(html ?? '').trim()
}

/** Plain text for card-tile excerpts — markdown syntax stripped, not shown raw. */
export function plainText(markdown) {
  const div = document.createElement('div')
  div.innerHTML = renderMarkdown(markdown)
  return (div.textContent ?? '').replace(/\s+/g, ' ').trim()
}

/** The note's first image (a link preview, today) — for the board card's thumbnail. */
export function firstImageUrl(markdown) {
  const div = document.createElement('div')
  div.innerHTML = renderMarkdown(markdown)
  return div.querySelector('img')?.getAttribute('src') ?? null
}
