// One card, drawn three ways.
//
// A drawer's kind decides the shape — a line with a tick box, a note tile, or
// a picture — but all three are the same card underneath and share everything
// below: the heading, the tags, the menu, and the fold-out that lets a note be
// read where it sits instead of being opened.
//
// The markup is deliberately plain strings: every view here re-renders by
// replacing innerHTML, and a card that knows how to draw itself in one place is
// what keeps the board and the home screen looking like the same app. Pictures
// go in as `data-note-image` and are filled in afterwards by
// `hydrateNoteImages`, the same way as the ones inside a note — so no view has
// to wait on a signed URL before it can draw.

import { PRIORITY_LABELS } from './cards'
import { escapeHtml, dueInfo } from './format'
import { plainText, firstImage, renderMarkdown } from './markdown'

const ICONS = {
  more: `<svg viewBox="0 0 24 24" aria-hidden="true"><circle cx="5.5" cy="12" r="1.35" fill="currentColor" stroke="none"/><circle cx="12" cy="12" r="1.35" fill="currentColor" stroke="none"/><circle cx="18.5" cy="12" r="1.35" fill="currentColor" stroke="none"/></svg>`,
  chevron: `<svg viewBox="0 0 24 24" aria-hidden="true"><path d="M6 9.5l6 6 6-6"/></svg>`,
  tick: `<svg viewBox="0 0 24 24" aria-hidden="true"><path d="M5 12.5l4.5 4.5L19 7"/></svg>`,
  image: `<svg viewBox="0 0 24 24" aria-hidden="true"><rect x="3.5" y="5" width="17" height="14" rx="2"/><circle cx="9" cy="10" r="1.5"/><path d="M4 16.5l4.5-4 3.5 3 3-2.5 4.5 4"/></svg>`,
}

/** How much of a titleless note stands in for its heading. */
const HEADING_LIMIT = 90

function trim(text, limit) {
  return text.length > limit ? `${text.slice(0, limit)}…` : text
}

/** A title stands in for the heading; a titleless card leans on its note. */
export function cardHeading(card, limit = HEADING_LIMIT) {
  const text = card.title.trim() || plainText(card.body_markdown)
  return trim(text, limit) || 'Untitled'
}

/** The picture a card shows on its face — the first one in its note. One of
 *  ours goes in unresolved; an external one (a link preview) is already a URL. */
function faceImage(picture, className) {
  if (!picture) return ''

  const source = picture.path
    ? `data-note-image="${escapeHtml(picture.path)}"`
    : `src="${escapeHtml(picture.url)}"`

  return `<img class="${className}" ${source} alt="" loading="lazy">`
}

function tags(card) {
  const list = []

  if (card.priority) {
    list.push(
      `<span class="tag tag-pri pri-${card.priority}">${PRIORITY_LABELS[card.priority]}</span>`
    )
  }

  const due = dueInfo(card.due_date)
  if (due) {
    const tone = due.overdue ? ' is-overdue' : due.today ? ' is-today' : ''
    list.push(`<span class="tag tag-due${tone}">${escapeHtml(due.label)}</span>`)
  }

  // Spans rather than a div: most of the faces below are buttons, and a button
  // may only hold phrasing content.
  return list.length ? `<span class="card-tags">${list.join('')}</span>` : ''
}

function menu(card) {
  return `
    <div class="menu">
      <button
        type="button"
        class="icon-btn icon-btn-sm menu-trigger"
        data-act="menu"
        aria-haspopup="true"
        aria-expanded="false"
        aria-label="Card actions"
        title="Card actions"
      >${ICONS.more}</button>
      <div class="menu-list" hidden>
        <button type="button" data-act="open" data-id="${card.id}">Open</button>
        <button type="button" data-act="copy" data-id="${card.id}">Copy text</button>
        <button type="button" data-act="move" data-id="${card.id}">Move to…</button>
        <button type="button" data-act="archive" data-id="${card.id}">Archive</button>
        <button type="button" class="menu-danger" data-act="delete" data-id="${card.id}">Delete</button>
      </div>
    </div>
  `
}

/**
 * Render one card. `kind` is the drawer's shape ('list' | 'notes' | 'gallery')
 * and `expanded` says whether its note is folded out.
 */
export function renderCard(card, { kind = 'notes', expanded = false } = {}) {
  // Parsing the note is the expensive part, and a board redraws on every tick,
  // fold and drag — so it happens once here and the pieces are passed around.
  const title = card.title.trim()
  const bodyText = plainText(card.body_markdown)
  const picture = firstImage(card.body_markdown)
  const heading = trim(title || bodyText, HEADING_LIMIT) || 'Untitled'

  // A titleless card already spends its note on the heading, and an open card
  // is showing the whole thing underneath — either way, repeating it as an
  // excerpt would just be the same words twice.
  const excerpt = title && !expanded ? trim(bodyText, 140) : ''

  // Only offer to unfold when there is something the face isn't already
  // showing: a picture, formatting under a title, or more words than fit.
  const foldable =
    Boolean(card.body_markdown.trim()) &&
    (Boolean(title) || Boolean(picture) || bodyText.length > HEADING_LIMIT)

  const fold = foldable
    ? `<button
         type="button"
         class="card-fold"
         data-act="fold"
         data-id="${card.id}"
         aria-expanded="${String(expanded)}"
         aria-label="${expanded ? 'Collapse note' : 'Read note'}"
         title="${expanded ? 'Collapse note' : 'Read note'}"
       >${ICONS.chevron}</button>`
    : ''

  const note = expanded
    ? `<div class="card-note markdown-body">${renderMarkdown(card.body_markdown)}</div>`
    : ''

  if (kind === 'gallery') {
    const face =
      faceImage(picture, 'gallery-image') ||
      `<span class="gallery-blank" aria-hidden="true">${ICONS.image}</span>`

    // A picture with nothing written on it needs no caption saying "Untitled".
    const caption = title || bodyText ? `<span class="card-title">${escapeHtml(heading)}</span>` : ''
    const tagged = tags(card)

    return `
      <article class="card card-gallery${expanded ? ' is-open' : ''}" data-card="${card.id}" data-drag>
        <button type="button" class="card-face" data-act="open" data-id="${card.id}">
          ${face}
          ${caption || tagged ? `<span class="gallery-caption">${caption}${tagged}</span>` : ''}
        </button>
        ${note}
        <div class="card-actions">${fold}${menu(card)}</div>
      </article>
    `
  }

  if (kind === 'list') {
    return `
      <article
        class="card card-list${card.done ? ' is-done' : ''}${expanded ? ' is-open' : ''}"
        data-card="${card.id}"
        data-drag
      >
        <div class="card-line">
          <button
            type="button"
            class="card-tick"
            data-act="tick"
            data-id="${card.id}"
            role="checkbox"
            aria-checked="${String(Boolean(card.done))}"
            aria-label="${card.done ? 'Mark as not done' : 'Mark as done'}"
          >${ICONS.tick}</button>
          <button type="button" class="card-face" data-act="open" data-id="${card.id}">
            <span class="card-title">${escapeHtml(heading)}</span>
            ${tags(card)}
          </button>
          ${faceImage(picture, 'card-thumb card-thumb-sm')}
          <div class="card-actions">${fold}${menu(card)}</div>
        </div>
        ${note}
      </article>
    `
  }

  return `
    <article class="card card-note-tile${expanded ? ' is-open' : ''}" data-card="${card.id}" data-drag>
      <div class="card-line">
        <button type="button" class="card-face" data-act="open" data-id="${card.id}">
          <span class="card-face-text">
            <span class="card-title">${escapeHtml(heading)}</span>
            ${excerpt ? `<span class="card-excerpt">${escapeHtml(excerpt)}</span>` : ''}
            ${tags(card)}
          </span>
          ${faceImage(picture, 'card-thumb')}
        </button>
        <div class="card-actions">${fold}${menu(card)}</div>
      </div>
      ${note}
    </article>
  `
}

/**
 * Finish off the notes folded out under the cards in `root`: links open away
 * from the app rather than replacing it. Run after every render, alongside
 * `hydrateNoteImages`.
 */
export function dressNotes(root) {
  for (const anchor of root.querySelectorAll('.card-note a[href]')) {
    anchor.target = '_blank'
    anchor.rel = 'noopener noreferrer'
  }
}
