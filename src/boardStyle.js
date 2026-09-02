// The palette a board can be painted with, and the shapes an icon can take.
//
// The colour lives in the database as a key ('clay'), never as a CSS value —
// each key has to answer differently in light and dark, which only the
// stylesheet knows how to do. See the `[data-tint]` block in style.css.

import { escapeHtml } from './format'

export const BOARD_COLOURS = [
  { key: 'teal', label: 'Teal' },
  { key: 'sage', label: 'Sage' },
  { key: 'olive', label: 'Olive' },
  { key: 'amber', label: 'Amber' },
  { key: 'clay', label: 'Clay' },
  { key: 'rose', label: 'Rose' },
  { key: 'plum', label: 'Plum' },
  { key: 'slate', label: 'Slate' },
]

const DEFAULT_BOARD_COLOUR = 'teal'

const KEYS = new Set(BOARD_COLOURS.map((colour) => colour.key))

/** A board's colour key, falling back to the default for anything unknown. */
export function boardColour(board) {
  return KEYS.has(board?.colour) ? board.colour : DEFAULT_BOARD_COLOUR
}

/**
 * One emoji out of whatever was typed — the last one, so picking a second
 * replaces the first rather than being ignored behind it.
 *
 * pensar used to offer a grid of sixteen emoji to choose from. Every phone and
 * every desktop already has an emoji keyboard with all of them in it, and ours
 * could only ever be a worse, shorter version of that — so the field takes
 * whatever the system picker gives it and keeps the last character of it.
 *
 * Graphemes, not code points: a flag, a skin tone or a family is several code
 * points that are one emoji on screen, and cutting through the middle of one
 * leaves nonsense.
 */
export function oneEmoji(value) {
  const text = String(value ?? '').trim()
  if (!text) return ''

  if (typeof Intl !== 'undefined' && typeof Intl.Segmenter === 'function') {
    const parts = [...new Intl.Segmenter(undefined, { granularity: 'grapheme' }).segment(text)]
    return parts.at(-1)?.segment ?? ''
  }
  return [...text].at(-1) ?? ''
}

const FALLBACK_GLYPH = `<svg viewBox="0 0 24 24" aria-hidden="true"><rect x="3" y="4" width="4.5" height="16" rx="1.2"/><rect x="9.75" y="4" width="4.5" height="11" rx="1.2"/><rect x="16.5" y="4" width="4.5" height="7" rx="1.2"/></svg>`

/**
 * The square that stands for a board: its picture if it has one, its emoji if
 * it hasn't, and the drawer glyph if it has neither. `images` is the path →
 * signed URL map the view is holding; a picture still being signed falls back
 * to the glyph for that one render rather than leaving a hole.
 */
export function renderBoardGlyph(board, images = new Map(), { size = '' } = {}) {
  const tint = ` data-tint="${boardColour(board)}"`
  const className = `board-glyph${size ? ` board-glyph-${size}` : ''}`
  const url = board.icon_path ? images.get(board.icon_path) : null

  if (url) {
    return `<span class="${className} has-image"${tint}><img src="${escapeHtml(url)}" alt=""></span>`
  }
  if (board.emoji) {
    return `<span class="${className} is-emoji"${tint}>${escapeHtml(board.emoji)}</span>`
  }
  return `<span class="${className}"${tint} aria-hidden="true">${FALLBACK_GLYPH}</span>`
}
