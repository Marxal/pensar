// A link, looked up: its picture, its title, and the words underneath.
//
// A bare URL says nothing about where it goes. What the Edge Function brings
// back (see linkPreview.js) is the page's own picture, title, description and
// site name, and this module is the single place that knows what to do with
// them — how a link card is built, stored, read back, and drawn on the front
// of a card.
//
// ## Why it is stored as HTML
//
// Markdown can carry a picture inside a link — `[![](img)](url)` — and for a
// while that was all a preview was. A title, a description and a site name
// have nowhere to go in that, so the card is stored as one small piece of
// HTML instead: `marked` hands raw HTML straight back, DOMPurify is content
// with an anchor holding an image and three spans, and turndown gives it back
// verbatim (see markdown.js's `linkCard` rule, which re-serialises from the
// *data* rather than the live DOM, so no editing chrome can leak into what
// gets saved). Previews stored the old way still read fine — `readLinkCard`
// takes the picture and the alt text it has — and are written back in the new
// shape the next time the note is saved.
//
// ## One shape, three sizes
//
// The same children are drawn three ways, chosen by a class on the root:
// nothing — two columns, picture beside the words — inside a note, `is-tile`
// (picture above the words) on a gallery, and `is-row` (a small picture beside
// one line) on a tick list. On the front of a card the root is a `<span>`
// rather than an `<a>`, because the face is already a button and a button may
// not hold a link; everything else about it is the same, stylesheet included.
//
// ## When the page has no picture
//
// The Edge Function falls back to the site's own icon, which is drawn contained
// on a tint rather than cropped (`data-icon`). With not even that, the card
// shows the site's initial on paper — a placeholder that still tells you which
// site it is, which a broken image would not. A picture that fails to load
// later is swapped for the same thing by `dressLinkCards`.

import { updateCard } from './cards'
import { escapeHtml } from './format'
import { urlsIn } from './linkify'
import { fetchLinkPreview } from './linkPreview'

/** The class that marks a link card, both in storage and on screen. */
export const LINK_CARD_CLASS = 'note-link-card'

/** Enough of the page's own words to say what it is, and no more: a link
 *  dropped into a note shouldn't take the note over. */
const TITLE_LIMIT = 120
const DESCRIPTION_LIMIT = 200

/** How many links in one captured line are worth looking up. Past a handful,
 *  a note becomes a wall of previews. */
const MAX_PREVIEWS = 3

function trim(text, limit) {
  const value = (text ?? '').replace(/\s+/g, ' ').trim()
  return value.length > limit ? `${value.slice(0, limit)}…` : value
}

/** The site a URL belongs to, as it should read under a title. */
export function siteOf(url) {
  try {
    return new URL(url).hostname.replace(/^www\./i, '')
  } catch {
    return ''
  }
}

/** The letter that stands in for a missing picture. */
function monogram(site) {
  const letter = (site || '').replace(/[^a-z0-9]/gi, '').charAt(0)
  return letter ? letter.toUpperCase() : '↗'
}

/** Everything a link card needs, from whatever the Edge Function managed. */
export function linkCardData(preview) {
  const url = preview?.url ?? ''
  const site = trim(preview?.site, 60) || siteOf(url)
  return {
    url,
    site,
    title: trim(preview?.title, TITLE_LIMIT),
    description: trim(preview?.description, DESCRIPTION_LIMIT),
    image: preview?.image || preview?.icon || null,
    isIcon: !preview?.image && Boolean(preview?.icon),
  }
}

/** True when a lookup came back with something worth drawing. A card that
 *  would say nothing but the hostname is no better than the link itself. */
export function worthShowing(preview) {
  return Boolean(preview?.title || preview?.description || preview?.image || preview?.icon)
}

function pictureMarkup(data) {
  if (data.image) {
    return `<img class="link-card-image" src="${escapeHtml(data.image)}" alt="" loading="lazy" draggable="false">`
  }
  return `<span class="link-card-blank" aria-hidden="true">${escapeHtml(monogram(data.site))}</span>`
}

/** What a link card is called: the page's own title, the site it's on, or —
 *  with nothing else to go on — the link itself. */
export function linkCardLabel(data) {
  return data.title || data.site || data.url
}

/** The children of a link card — shared by every size and both root tags. */
function innerMarkup(data) {
  const title = linkCardLabel(data)
  return `${pictureMarkup(data)}<span class="link-card-text"><span class="link-card-title">${escapeHtml(
    title
  )}</span>${
    data.description ? `<span class="link-card-desc">${escapeHtml(data.description)}</span>` : ''
  }${data.site ? `<span class="link-card-site">${escapeHtml(data.site)}</span>` : ''}</span>`
}

/**
 * One link card as markup. `tag` is `a` for a note (where it navigates) and
 * `span` for the front of a card (where the face's own button already does);
 * `variant` is '' for the two-column note shape, `is-tile` or `is-row`.
 *
 * Deliberately on one line: this is what ends up inside `body_markdown`, and a
 * blank line in the middle of it would end the HTML block early.
 */
export function linkCardMarkup(data, { tag = 'a', variant = '' } = {}) {
  const classes = [LINK_CARD_CLASS, variant].filter(Boolean).join(' ')
  const icon = data.isIcon ? ' data-icon=""' : ''
  const open =
    tag === 'a'
      ? `<a class="${classes}" href="${escapeHtml(data.url)}"${icon}>`
      : `<span class="${classes}"${icon}>`
  return `${open}${innerMarkup(data)}</${tag}>`
}

/** An anchor that was a preview before there was anything to say about it:
 *  its whole content is one picture. */
function looksLikeOldCard(node) {
  return (
    node.tagName === 'A' &&
    node.children.length === 1 &&
    node.firstElementChild.tagName === 'IMG'
  )
}

/** True for a link card in any shape it has ever been stored in. */
export function isLinkCard(node) {
  return node.classList?.contains(LINK_CARD_CLASS) || looksLikeOldCard(node)
}

/** Read one back out of the DOM. An old picture-only card keeps the title it
 *  put in the picture's alt text, and gets its site name from the URL. */
export function readLinkCard(node) {
  const url = node.getAttribute('href') ?? ''
  const image = node.querySelector('img')
  const text = (selector) => node.querySelector(selector)?.textContent?.trim() ?? ''
  const site = text('.link-card-site') || siteOf(url)

  return {
    url,
    site,
    title: trim(text('.link-card-title') || image?.getAttribute('alt'), TITLE_LIMIT),
    description: trim(text('.link-card-desc'), DESCRIPTION_LIMIT),
    image: image?.getAttribute('src') || null,
    isIcon: node.hasAttribute('data-icon'),
  }
}

/** Already drawn the way this version draws them. */
function isCurrentShape(node) {
  return Boolean(node.querySelector('.link-card-text'))
}

/** A picture that never arrives leaves a broken frame behind, so it stands
 *  down for the placeholder instead. */
function watchPicture(node) {
  const image = node.querySelector('.link-card-image')
  if (!image || image.dataset.linkWatched) return
  image.dataset.linkWatched = '1'

  image.addEventListener(
    'error',
    () => {
      const blank = document.createElement('span')
      blank.className = 'link-card-blank'
      blank.setAttribute('aria-hidden', 'true')
      blank.textContent = monogram(readLinkCard(node).site)
      image.replaceWith(blank)
    },
    { once: true }
  )
}

/** Finish off one link card: bring an old picture-only one up to the current
 *  shape, and give its picture somewhere to fail to. */
export function dressLinkCard(node) {
  node.classList.add(LINK_CARD_CLASS)
  if (!isCurrentShape(node)) node.innerHTML = innerMarkup(readLinkCard(node))
  watchPicture(node)
}

/**
 * The same for every link card under `root` — the ones already in shape, and
 * the old anchors that are only a picture. Run after each render, alongside
 * `hydrateNoteImages`.
 */
export function dressLinkCards(root) {
  const found = new Set(root.querySelectorAll(`.${LINK_CARD_CLASS}`))
  for (const anchor of root.querySelectorAll('a')) {
    if (isLinkCard(anchor)) found.add(anchor)
  }
  for (const node of found) dressLinkCard(node)
}

/* ---------------------------------------------------------------
   Looking a captured line up
   --------------------------------------------------------------- */

/** The links a note already has a card for, so a second pass doesn't add
 *  them twice. */
function alreadyCarded(markdown) {
  const found = new Set()
  for (const tag of markdown.match(/<a\b[^>]*>/g) ?? []) {
    if (!tag.includes(LINK_CARD_CLASS)) continue
    const href = tag.match(/href="([^"]*)"/)?.[1]
    if (href) found.add(href)
  }
  return found
}

/**
 * Look up the links in a freshly captured card and file their previews under
 * it. Returns the updated card, or null when there was nothing to add.
 *
 * Capture stays instant because this runs *after* the card exists rather than
 * before: the note appears the moment it is typed, and gains its pictures a
 * second later. Never throws — a preview that doesn't arrive just leaves the
 * link as a link.
 */
export async function addLinkPreviews(card) {
  try {
    const body = card?.body_markdown ?? ''
    const done = alreadyCarded(body)
    const urls = urlsIn(body)
      .filter((url) => !done.has(url))
      .slice(0, MAX_PREVIEWS)
    if (!urls.length) return null

    const previews = await Promise.all(urls.map((url) => fetchLinkPreview(url)))
    const cards = previews
      .map((preview, index) => ({ ...preview, url: urls[index] }))
      .filter(worthShowing)
      .map((preview) => linkCardMarkup(linkCardData(preview)))
    if (!cards.length) return null

    return await updateCard(card.id, { body_markdown: [body.trim(), ...cards].join('\n\n') })
  } catch {
    return null
  }
}
