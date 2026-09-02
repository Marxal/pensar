// One card, drawn three ways.
//
// A drawer's kind decides the shape — a line with a tick box, a note tile, or
// a picture — but all three are the same card underneath and share everything
// below: the heading, the tags, the copy button, the menu, and the fold-out
// that lets a note be read where it sits instead of being opened.
//
// The markup is deliberately plain strings: every view here re-renders by
// replacing innerHTML, and a card that knows how to draw itself in one place is
// what keeps the board and the home screen looking like the same app. Pictures
// go in as `data-note-image` and are filled in afterwards by
// `hydrateNoteImages`, the same way as the ones inside a note — so no view has
// to wait on a signed URL before it can draw.
//
// ## A picture is shown once
//
// A card with a picture in its note used to show it twice over: a thumbnail on
// the face, and the picture itself again in the note folded out underneath.
// The face only carries a thumbnail while the card is folded away, so the
// picture appears exactly once either way.

import { PRIORITY_LABELS } from './cards'
import { cardFold } from './openCards'
import { escapeHtml, dueInfo } from './format'
import { plainText, firstImage, renderMarkdown } from './markdown'

const ICONS = {
  more: `<svg viewBox="0 0 24 24" aria-hidden="true"><circle cx="5.5" cy="12" r="1.35" fill="currentColor" stroke="none"/><circle cx="12" cy="12" r="1.35" fill="currentColor" stroke="none"/><circle cx="18.5" cy="12" r="1.35" fill="currentColor" stroke="none"/></svg>`,
  chevron: `<svg viewBox="0 0 24 24" aria-hidden="true"><path d="M6 9.5l6 6 6-6"/></svg>`,
  tick: `<svg viewBox="0 0 24 24" aria-hidden="true"><path d="M5 12.5l4.5 4.5L19 7"/></svg>`,
  copy: `<svg viewBox="0 0 24 24" aria-hidden="true"><rect x="9" y="9" width="11" height="11" rx="2"/><path d="M15.5 6.5V6a2 2 0 0 0-2-2H6a2 2 0 0 0-2 2v7.5a2 2 0 0 0 2 2h.5"/></svg>`,
  image: `<svg viewBox="0 0 24 24" aria-hidden="true"><rect x="3.5" y="5" width="17" height="14" rx="2"/><circle cx="9" cy="10" r="1.5"/><path d="M4 16.5l4.5-4 3.5 3 3-2.5 4.5 4"/></svg>`,
}

/** How much of a titleless note stands in for its heading. */
const HEADING_LIMIT = 90

/** …and how much of it a gallery tile with no picture gets to show, where the
 *  words are the whole tile rather than a line above a thumbnail. */
const TEXT_TILE_LIMIT = 260

/** How much of the note a folded card shows underneath its title. Generous on
 *  purpose: a folded card is meant to be readable, not a stub. */
const EXCERPT_LIMIT = 320

/** Past this much markdown, or more than one picture, a note is big enough
 *  that it folds itself away until you ask for it. */
const LONG_NOTE_CHARS = 500

/** …and past this many cards, a drawer is busy enough that its notes fold
 *  themselves away too, however short they are. */
export const CROWDED_AT = 8

function trim(text, limit) {
  return text.length > limit ? `${text.slice(0, limit)}…` : text
}

/** A title stands in for the heading; a titleless card leans on its note. */
export function cardHeading(card, limit = HEADING_LIMIT) {
  const text = card.title.trim() || plainText(card.body_markdown)
  return trim(text, limit) || 'Untitled'
}

/**
 * Should this card start folded out?
 *
 * Your own decision wins for as long as you keep it (see openCards.js). With
 * nothing said, a note in a `notes` drawer opens itself — reading a note
 * shouldn't take a click — unless it's long, carries more than one picture, or
 * sits in a drawer that's already crowded. A tick list is for scanning and a
 * gallery is for looking, so neither opens anything on your behalf.
 *
 * Deliberately cheap: it counts raw markdown rather than parsing it, because
 * every card on the board asks this on every render.
 */
export function cardStartsOpen(card, { kind = 'notes', crowded = false } = {}) {
  const decided = cardFold(card.id)
  if (decided !== undefined) return decided

  if (kind !== 'notes') return false

  const body = card.body_markdown ?? ''
  if (!body.trim() || body.length > LONG_NOTE_CHARS) return false
  if ((body.match(/!\[/g) ?? []).length > 1) return false

  return !crowded
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
        <button type="button" data-act="move" data-id="${card.id}">Move to…</button>
        <button type="button" data-act="archive" data-id="${card.id}">Archive</button>
        <button type="button" class="menu-danger" data-act="delete" data-id="${card.id}">Delete</button>
      </div>
    </div>
  `
}

/**
 * Render one card. `kind` is the drawer's shape ('list' | 'notes' | 'gallery')
 * and `expanded` says whether its note is folded out — a card with nothing
 * extra to show ignores it.
 */
export function renderCard(card, { kind = 'notes', expanded = false } = {}) {
  // Parsing the note is the expensive part, and a board redraws on every tick,
  // fold and drag — so it happens once here and the pieces are passed around.
  const title = card.title.trim()
  const bodyText = plainText(card.body_markdown)
  const picture = firstImage(card.body_markdown)

  // Only offer to unfold when there is something the face isn't already
  // showing: a picture, formatting under a title, or more words than fit.
  const foldable =
    Boolean(card.body_markdown.trim()) &&
    (Boolean(title) || Boolean(picture) || bodyText.length > HEADING_LIMIT)

  const open = expanded && foldable
  const heading = trim(title || bodyText, HEADING_LIMIT) || 'Untitled'

  // A titleless card already spends its note on the heading, and an open card
  // is showing the whole thing underneath — either way, repeating it as an
  // excerpt would just be the same words twice.
  const excerpt = title && !open ? trim(bodyText, EXCERPT_LIMIT) : ''

  const fold = foldable
    ? `<button
         type="button"
         class="card-btn card-fold"
         data-act="fold"
         data-id="${card.id}"
         aria-expanded="${String(open)}"
         aria-label="${open ? 'Collapse note' : 'Read note'}"
         title="${open ? 'Collapse note' : 'Read note'}"
       >${ICONS.chevron}</button>`
    : ''

  const copy =
    title || bodyText
      ? `<button
           type="button"
           class="card-btn card-copy"
           data-act="copy"
           data-id="${card.id}"
           aria-label="Copy text"
           title="Copy text"
         >${ICONS.copy}</button>`
      : ''

  const actions = `<div class="card-actions">${copy}${fold}${menu(card)}</div>`

  const note = open
    ? `<div class="card-note markdown-body">${renderMarkdown(card.body_markdown)}</div>`
    : ''

  if (kind === 'gallery') {
    // Folded out, the note shows the picture at full width itself — so the
    // face steps aside rather than showing it twice.
    const face = picture && !open ? faceImage(picture, 'gallery-image') : ''

    // A gallery is where a note without a picture has to hold its own, so the
    // words become the tile: bigger type, and more of them.
    const galleryHeading = face ? heading : trim(title || bodyText, TEXT_TILE_LIMIT) || 'Untitled'
    const words = title || bodyText
    const tagged = tags(card)

    const caption =
      words || tagged
        ? `<span class="gallery-caption">
             ${words ? `<span class="card-title">${escapeHtml(galleryHeading)}</span>` : ''}
             ${excerpt ? `<span class="card-excerpt">${escapeHtml(excerpt)}</span>` : ''}
             ${tagged}
           </span>`
        : ''

    // Neither words nor a picture: a blank stands in so the card is still
    // something you can see and pick up.
    const blank =
      picture || words ? '' : `<span class="gallery-blank" aria-hidden="true">${ICONS.image}</span>`

    return `
      <article
        class="card card-gallery${picture ? '' : ' is-text'}${open ? ' is-open' : ''}"
        data-card="${card.id}"
        data-drag
      >
        <button type="button" class="card-face" data-act="open" data-id="${card.id}">
          ${face}${blank}${caption}
        </button>
        ${note}
        ${actions}
      </article>
    `
  }

  if (kind === 'list') {
    return `
      <article
        class="card card-list${card.done ? ' is-done' : ''}${open ? ' is-open' : ''}"
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
          ${open ? '' : faceImage(picture, 'card-thumb card-thumb-sm')}
          ${actions}
        </div>
        ${note}
      </article>
    `
  }

  return `
    <article class="card card-note-tile${open ? ' is-open' : ''}" data-card="${card.id}" data-drag>
      <div class="card-line">
        <button type="button" class="card-face" data-act="open" data-id="${card.id}">
          <span class="card-face-text">
            <span class="card-title">${escapeHtml(heading)}</span>
            ${excerpt ? `<span class="card-excerpt">${escapeHtml(excerpt)}</span>` : ''}
            ${tags(card)}
          </span>
          ${open ? '' : faceImage(picture, 'card-thumb')}
        </button>
        ${actions}
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
