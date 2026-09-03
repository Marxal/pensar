// Turning what looks like a link into one, without being asked.
//
// Typing `marxal.net` and carrying on should leave a link behind, the same way
// pasting `https://marxal.net/some/page` should — a note is a place to throw
// things, not a form with a link field. The cost of guessing is that ordinary
// words must never be swallowed, so a bare domain is only believed when its
// last part is a top-level domain we actually recognise. That is what keeps
// `Node.js`, `index.html` and `etc.` as plain words.
//
// Anything with a scheme, a `www.`, or an @ is unambiguous and gets taken at
// face value.

/** The top-level domains worth believing without a scheme in front of them.
 *  Short on purpose: every addition is another word that stops being a word. */
const BARE_TLDS = new Set([
  'com', 'net', 'org', 'io', 'co', 'dev', 'app', 'me', 'ai', 'xyz', 'info',
  'edu', 'gov', 'tv', 'fm', 'cc', 'online', 'site', 'blog', 'shop', 'store',
  'studio', 'design', 'digital', 'space', 'tech', 'news', 'press', 'photo',
  'art', 'es', 'cat', 'fr', 'de', 'it', 'pt', 'uk', 'eu', 'nl', 'be', 'ch',
  'se', 'no', 'fi', 'dk', 'pl', 'ie', 'at', 'gr', 'cz', 'us', 'ca', 'au',
  'nz', 'jp', 'br', 'mx', 'ar', 'cl', 'in',
])

/** Punctuation that ends a sentence rather than a URL. */
const TRAILING = /[.,;:!?»"'\]}>)]+$/

const HOST = String.raw`[a-z0-9](?:[a-z0-9-]*[a-z0-9])?(?:\.[a-z0-9](?:[a-z0-9-]*[a-z0-9])?)+`

const WITH_SCHEME = new RegExp(String.raw`^https?://\S+$`, 'i')
const BARE = new RegExp(String.raw`^(${HOST})(?::\d{2,5})?([/?#]\S*)?$`, 'i')
const EMAIL = new RegExp(String.raw`^[^\s@]+@(${HOST})$`, 'i')

/**
 * Read one whitespace-free token as a link.
 *
 * Returns `{ href, text }` — `text` being the token with any sentence
 * punctuation trimmed off the end, so "see marxal.net." links the domain and
 * leaves the full stop alone — or null when it isn't a link at all.
 */
function matchUrl(rawToken) {
  const text = rawToken.replace(TRAILING, '')
  if (text.length < 4) return null

  if (WITH_SCHEME.test(text)) return { href: text, text }
  if (EMAIL.test(text)) return { href: `mailto:${text}`, text }

  const bare = BARE.exec(text)
  if (!bare) return null

  // Only a domain we recognise the end of — the point where guessing stops.
  // A leading `www.` is its own proof and skips the check.
  const labels = bare[1].split('.')
  const known = BARE_TLDS.has(labels[labels.length - 1].toLowerCase())
  if (!known && labels[0].toLowerCase() !== 'www') return null

  return { href: `https://${text}`, text }
}

/**
 * Read a whole line the same way, without a DOM in the middle of it.
 *
 * Quick capture and a share from the phone arrive as plain text that is stored
 * as markdown, so the linking has to happen in the string: every token that
 * would have become an anchor in the note editor becomes `[text](href)`
 * instead. Anything already inside markdown link syntax is left alone.
 */
export function linkifyMarkdown(text) {
  return String(text ?? '').replace(/[^\s\u00a0]+/g, (token) => {
    if (token.startsWith('[') || token.startsWith('(') || token.startsWith('!')) return token
    const found = matchUrl(token)
    if (!found) return token
    return `[${found.text}](${found.href})${token.slice(found.text.length)}`
  })
}

/** Every link in a piece of text or markdown, in the order it appears and
 *  without repeats — what a card's previews are looked up from. */
export function urlsIn(text) {
  const found = new Set()

  // Markdown's own links first: `[words](href)` hides the URL from the token
  // scan below, and it is the shape `linkifyMarkdown` leaves behind.
  for (const match of String(text ?? '').matchAll(/\]\(([^)\s]+)\)/g)) {
    if (/^https?:\/\//i.test(match[1])) found.add(match[1])
  }

  for (const match of String(text ?? '').matchAll(/[^\s\u00a0]+/g)) {
    const link = matchUrl(match[0])
    if (link?.href.startsWith('http')) found.add(link.href)
  }

  return [...found]
}

function anchorFor({ href, text }) {
  const anchor = document.createElement('a')
  anchor.href = href
  anchor.textContent = text
  return anchor
}

/** Replace every link-shaped token in one text node. Returns the new anchors. */
function linkifyTextNode(node) {
  const text = node.textContent
  const anchors = []
  const fragment = document.createDocumentFragment()
  let cut = 0

  for (const match of text.matchAll(/[^\s\u00a0]+/g)) {
    const found = matchUrl(match[0])
    if (!found) continue

    if (match.index > cut) fragment.append(text.slice(cut, match.index))
    const anchor = anchorFor(found)
    fragment.append(anchor)
    anchors.push(anchor)
    cut = match.index + found.text.length
  }

  if (!anchors.length) return anchors
  if (cut < text.length) fragment.append(text.slice(cut))
  node.replaceWith(fragment)
  return anchors
}

/**
 * Link everything link-shaped under `root` that isn't already a link. Used
 * after a paste, where a whole block of text arrives at once.
 */
export function linkifyTree(root) {
  const walker = document.createTreeWalker(root, NodeFilter.SHOW_TEXT)
  const nodes = []
  while (walker.nextNode()) nodes.push(walker.currentNode)

  const anchors = []
  for (const node of nodes) {
    if (node.parentElement?.closest('a')) continue
    anchors.push(...linkifyTextNode(node))
  }
  return anchors
}

/**
 * Link the word the caret has just finished typing.
 *
 * `trailing: true` — the `input` case — only fires once a space has been typed
 * after the word, so a domain isn't linked halfway through being written.
 * `trailing: false` — Enter, or leaving the note — takes the word sitting
 * right against the caret.
 *
 * Returns the anchor it made, or null. The caret is put back where the typing
 * left it either way.
 */
export function linkifyAtCaret(editor, { trailing = false } = {}) {
  const selection = window.getSelection()
  if (!selection?.rangeCount) return null

  const range = selection.getRangeAt(0)
  if (!range.collapsed) return null

  const node = range.startContainer
  if (node.nodeType !== Node.TEXT_NODE || !editor.contains(node)) return null
  if (node.parentElement?.closest('a')) return null

  const caret = range.startOffset
  const before = node.textContent.slice(0, caret)

  const pattern = trailing
    ? /(?:^|[\s\u00a0(])([^\s\u00a0]+)([\s\u00a0]+)$/
    : /(?:^|[\s\u00a0(])([^\s\u00a0]+)$/
  const match = pattern.exec(before)
  if (!match) return null

  const found = matchUrl(match[1])
  if (!found) return null

  const start = caret - (trailing ? match[1].length + match[2].length : match[1].length)

  // Cut the token out into a node of its own, then swap that node for a link.
  const token = node.splitText(start)
  const rest = token.splitText(found.text.length)
  const anchor = anchorFor(found)
  token.replaceWith(anchor)

  const after = document.createRange()
  after.setStart(rest, Math.min(caret - start - found.text.length, rest.textContent.length))
  after.collapse(true)
  selection.removeAllRanges()
  selection.addRange(after)

  return anchor
}
