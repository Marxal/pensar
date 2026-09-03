// The note sheet: one page, no form.
//
// A note is a title and some words that run straight on from it — not a stack
// of labelled boxes. Pictures are dropped in where they belong, links write
// themselves as you type, and there is no Save button because there is nothing
// to submit: the note saves itself a moment after you stop typing, when you
// close it, and when the phone takes the app away mid-sentence.
//
// Closing is the back gesture on a phone (see backstack.js), Escape on a
// desktop, and the arrow at the top left on both.

import {
  PRIORITIES,
  PRIORITY_LABELS,
  createCard,
  updateCard,
  deleteCard,
  archiveCard,
  trashCard,
} from './cards'
import { pushBackHandler } from './backstack'
import { dueInfo, relativeTime } from './format'
import { openLightbox } from './lightbox'
import { linkifyAtCaret, linkifyTree } from './linkify'
import { fetchLinkPreview } from './linkPreview'
import { hydrateNoteImages, markdownFromEditor, renderMarkdown, isBlankNote } from './markdown'
import { looksLikeImage, uploadNoteImage } from './images'

/** How long after the last keystroke the note writes itself away. */
const SAVE_AFTER_MS = 800

const ICONS = {
  back: `<svg viewBox="0 0 24 24" aria-hidden="true"><path d="M15 5.5 8.5 12l6.5 6.5"/></svg>`,
  more: `<svg viewBox="0 0 24 24" aria-hidden="true"><circle cx="5.5" cy="12" r="1.35" fill="currentColor" stroke="none"/><circle cx="12" cy="12" r="1.35" fill="currentColor" stroke="none"/><circle cx="18.5" cy="12" r="1.35" fill="currentColor" stroke="none"/></svg>`,
  copy: `<svg viewBox="0 0 24 24" aria-hidden="true"><rect x="9" y="9" width="11" height="11" rx="2"/><path d="M15.5 6.5V6a2 2 0 0 0-2-2H6a2 2 0 0 0-2 2v7.5a2 2 0 0 0 2 2h.5"/></svg>`,
  check: `<svg viewBox="0 0 24 24" aria-hidden="true"><path d="M5 12.5l4.5 4.5L19 7"/></svg>`,
  image: `<svg viewBox="0 0 24 24" aria-hidden="true"><rect x="3.5" y="5" width="17" height="14" rx="2"/><circle cx="9" cy="10" r="1.5"/><path d="M4 16.5l4.5-4 3.5 3 3-2.5 4.5 4"/></svg>`,
  link: `<svg viewBox="0 0 24 24" aria-hidden="true"><path d="M10.5 13.5a3.5 3.5 0 0 0 5 0l3-3a3.54 3.54 0 0 0-5-5l-1.4 1.4M13.5 10.5a3.5 3.5 0 0 0-5 0l-3 3a3.54 3.54 0 0 0 5 5l1.4-1.4"/></svg>`,
  list: `<svg viewBox="0 0 24 24" aria-hidden="true"><path d="M9 6.5h11M9 12h11M9 17.5h11"/><circle cx="4.75" cy="6.5" r="1.1" fill="currentColor" stroke="none"/><circle cx="4.75" cy="12" r="1.1" fill="currentColor" stroke="none"/><circle cx="4.75" cy="17.5" r="1.1" fill="currentColor" stroke="none"/></svg>`,
  numbers: `<svg viewBox="0 0 24 24" aria-hidden="true"><path d="M10 6.5h10M10 12h10M10 17.5h10M3.4 4.8l1.4-.8v4.4M3.2 10.6h2.6l-2.6 3.3h2.6M3.2 16.2h2.4v1.6H3.6v1.6h2"/></svg>`,
  calendar: `<svg viewBox="0 0 24 24" aria-hidden="true"><rect x="3.5" y="5.5" width="17" height="14" rx="2"/><path d="M3.5 10h17M8 3.5v4M16 3.5v4"/></svg>`,
  close: `<svg viewBox="0 0 24 24" aria-hidden="true"><path d="M6 6l12 12M18 6L6 18"/></svg>`,
}

/* ---------------------------------------------------------------
   Link cards
   --------------------------------------------------------------- */

/**
 * Turn a preview anchor — one whose whole content is a picture — into a small
 * card with a remove button, so a fresh preview and one hydrated back out of
 * saved markdown look and behave the same. Safe to call twice.
 */
function decorateLinkCard(anchor) {
  if (anchor.classList.contains('note-link-card')) return
  anchor.classList.add('note-link-card')
  anchor.contentEditable = 'false'
  anchor.target = '_blank'
  anchor.rel = 'noopener noreferrer'

  const remove = document.createElement('button')
  remove.type = 'button'
  remove.className = 'note-link-card-remove'
  remove.dataset.editorChrome = ''
  remove.setAttribute('aria-label', 'Remove preview image')
  remove.title = 'Remove preview image'
  remove.textContent = '×'
  anchor.appendChild(remove)
}

function decorateAllLinkCards(root) {
  for (const anchor of root.querySelectorAll('a')) {
    if (anchor.children.length === 1 && anchor.firstElementChild.tagName === 'IMG') {
      decorateLinkCard(anchor)
    }
  }
}

/** Insert `node` after whatever block `anchor` lives in, so a preview lands
 *  under the line the link is on rather than inside the sentence. */
function insertAfterBlock(body, anchor, node) {
  let block = anchor
  while (block.parentElement && block.parentElement !== body) block = block.parentElement
  if (block.parentElement === body) block.after(node)
  else body.append(node)
}

/**
 * Fetch a link's Open Graph picture and drop it under the line it's on, as its
 * own small card. Silent no-op if the page has no picture, the fetch fails, or
 * the note has been closed by the time it comes back.
 */
async function attachLinkPreview(body, anchor, url) {
  const preview = await fetchLinkPreview(url)
  if (!preview?.image || !body.isConnected || !body.contains(anchor)) return

  const card = document.createElement('a')
  card.href = url
  const img = document.createElement('img')
  img.src = preview.image
  img.alt = preview.title || ''
  card.appendChild(img)
  decorateLinkCard(card)

  insertAfterBlock(body, anchor, card)
  return card
}

/* ---------------------------------------------------------------
   Caret helpers
   --------------------------------------------------------------- */

/** Run `fn`, which may rebuild the text under the caret, and put the caret
 *  back where it was. */
function keepingCaret(fn) {
  const selection = window.getSelection()
  const marker = document.createElement('span')
  marker.dataset.editorChrome = ''

  if (selection?.rangeCount) selection.getRangeAt(0).cloneRange().insertNode(marker)
  fn()

  if (!marker.isConnected) return
  const range = document.createRange()
  range.setStartAfter(marker)
  range.collapse(true)
  selection.removeAllRanges()
  selection.addRange(range)
  marker.remove()
}

function caretToEnd(element) {
  const range = document.createRange()
  range.selectNodeContents(element)
  range.collapse(false)
  const selection = window.getSelection()
  selection.removeAllRanges()
  selection.addRange(range)
}

/* ---------------------------------------------------------------
   The sheet
   --------------------------------------------------------------- */

/**
 * Open a note. Pass `card` to edit one, or `drawerId` to start a new one in
 * that drawer (null for Quick notes).
 *
 * `onMove` is optional and adds "Move to…" to the menu. Filing a card is a
 * drag everywhere else, but a drag onto another project can only land in that
 * project's first drawer — so picking an exact drawer lives here instead, and
 * the view underneath supplies it, since that's where the lists and the undo
 * are. It's handed the saved card and returns whether the card actually moved.
 *
 * Resolves once it's closed, with `{ card, changed }` — `card` being the saved
 * row, or null if the note was left empty and never written, and `changed`
 * saying whether the view underneath has anything to reload.
 *
 * `kind` is the drawer's shape ('list' | 'notes' | 'gallery'); a tick list
 * gets a checkbox beside its title, the same tick a card's face already
 * carries, so a task can be finished from inside its own note too.
 */
export function openNote({ card = null, drawerId = null, kind = null, onMove = null } = {}) {
  return new Promise((resolve) => {
    const isNew = !card
    const isList = kind === 'list'
    let saved = card
    let done = Boolean(card?.done)
    let changed = false
    let closed = false
    let saveTimer = null
    let saving = null

    const backdrop = document.createElement('div')
    backdrop.className = 'sheet-backdrop'
    backdrop.innerHTML = `
      <section class="sheet" role="dialog" aria-modal="true" aria-label="Note">
        <header class="sheet-head">
          <button type="button" class="icon-btn" data-close aria-label="Close note" title="Close note">${ICONS.back}</button>
          <span class="sheet-status" data-status aria-live="polite"></span>
          <button type="button" class="icon-btn" data-copy aria-label="Copy text" title="Copy text">${ICONS.copy}</button>
          <div class="menu">
            <button
              type="button"
              class="icon-btn menu-trigger"
              data-menu
              aria-haspopup="true"
              aria-expanded="false"
              aria-label="Note actions"
              title="Note actions"
            >${ICONS.more}</button>
            <div class="menu-list" hidden>
              ${onMove ? '<button type="button" data-act="move">Move to…</button>' : ''}
              <button type="button" data-act="archive">Archive</button>
              <button type="button" class="menu-danger" data-act="delete">Delete</button>
            </div>
          </div>
        </header>

        <div class="note-scroll">
          <p class="note-edited" data-edited hidden></p>
          <div class="note-title-row">
            ${
              isList
                ? `<button
                    type="button"
                    class="card-tick"
                    data-tick
                    role="checkbox"
                    aria-checked="false"
                    aria-label="Mark as done"
                  >${ICONS.check}</button>`
                : ''
            }
            <div
              class="note-title"
              contenteditable="true"
              role="textbox"
              aria-label="Title"
              data-title
              data-placeholder="Title"
            ></div>
          </div>
          <div
            class="note-body markdown-body"
            contenteditable="true"
            role="textbox"
            aria-multiline="true"
            aria-label="Note"
            data-body
            data-placeholder="Write it straight — a line, a link, a picture"
          ></div>
        </div>

        <footer class="note-tools">
          <button type="button" class="note-tool" data-tool="image" aria-label="Add a picture" title="Add a picture">${ICONS.image}</button>
          <button type="button" class="note-tool" data-tool="link" aria-label="Add a link" title="Add a link">${ICONS.link}</button>
          <button type="button" class="note-tool" data-tool="bold" aria-label="Bold" title="Bold"><strong>B</strong></button>
          <button type="button" class="note-tool" data-tool="italic" aria-label="Italic" title="Italic"><em>I</em></button>
          <button type="button" class="note-tool" data-tool="list" aria-label="Bulleted list" title="Bulleted list">${ICONS.list}</button>
          <button type="button" class="note-tool" data-tool="numbers" aria-label="Numbered list" title="Numbered list">${ICONS.numbers}</button>

          <span class="note-tools-gap"></span>

          <div class="note-due" data-due>
            <label class="note-due-pick">
              ${ICONS.calendar}
              <span class="note-due-label" data-due-label hidden></span>
              <input type="date" class="note-due-input" data-due-input aria-label="Due date">
            </label>
            <input
              type="time"
              class="note-due-time-input"
              data-due-time-input
              aria-label="Reminder time"
              title="Reminder time (defaults to 9:00 AM)"
              hidden
            >
            <button type="button" class="note-due-clear" data-due-clear aria-label="Clear due date" title="Clear due date" hidden>${ICONS.close}</button>
          </div>

          <div class="note-priority" role="group" aria-label="Priority">
            ${PRIORITIES.map(
              (value) =>
                `<button type="button" class="pri-dot pri-${value}" data-priority="${value}" aria-pressed="false" aria-label="${PRIORITY_LABELS[value]} priority" title="${PRIORITY_LABELS[value]} priority"></button>`
            ).join('')}
          </div>
        </footer>

        <input type="file" accept="image/*" data-image-input hidden>
        <p class="sheet-error" data-error hidden></p>
      </section>
    `

    const sheet = backdrop.querySelector('.sheet')
    const titleEl = backdrop.querySelector('[data-title]')
    const bodyEl = backdrop.querySelector('[data-body]')
    const statusEl = backdrop.querySelector('[data-status]')
    const errorEl = backdrop.querySelector('[data-error]')
    const dueInput = backdrop.querySelector('[data-due-input]')
    const dueTimeInput = backdrop.querySelector('[data-due-time-input]')
    const dueLabel = backdrop.querySelector('[data-due-label]')
    const dueClear = backdrop.querySelector('[data-due-clear]')
    const imageInput = backdrop.querySelector('[data-image-input]')
    const tickButton = backdrop.querySelector('[data-tick]')
    const copyButton = backdrop.querySelector('[data-copy]')
    const menuTrigger = backdrop.querySelector('[data-menu]')
    const menuList = menuTrigger.nextElementSibling
    const editedEl = backdrop.querySelector('[data-edited]')

    // iOS doesn't shrink the layout viewport when the keyboard comes up, so a
    // sheet pinned to the viewport would hide its own toolbar behind the keys.
    // The visual viewport does know, and the sheet follows it.
    const viewport = window.visualViewport

    let priority = card?.priority ?? null

    document.body.appendChild(backdrop)
    document.body.classList.add('has-overlay')

    /* -------------------------------------------------------------
       Filling it in
       ------------------------------------------------------------- */

    titleEl.textContent = card?.title ?? ''
    bodyEl.innerHTML = card?.body_markdown ? renderMarkdown(card.body_markdown) : ''
    decorateAllLinkCards(bodyEl)
    hydrateNoteImages(bodyEl)
    dueInput.value = card?.due_date ?? ''
    dueTimeInput.value = card?.due_time ?? ''

    const dueChip = backdrop.querySelector('[data-due]')

    function paintDue() {
      const info = dueInfo(dueInput.value)
      dueLabel.hidden = !info
      dueLabel.textContent = info?.label ?? ''
      dueTimeInput.hidden = !info
      dueClear.hidden = !info
      dueChip.classList.toggle('is-set', Boolean(info))
    }

    function paintPriority() {
      for (const dot of backdrop.querySelectorAll('[data-priority]')) {
        dot.setAttribute('aria-pressed', String(dot.dataset.priority === priority))
      }
    }

    function paintDone() {
      if (!tickButton) return
      tickButton.classList.toggle('is-done', done)
      tickButton.setAttribute('aria-checked', String(done))
      tickButton.setAttribute('aria-label', done ? 'Mark as not done' : 'Mark as done')
    }

    function paintEmpty() {
      titleEl.classList.toggle('is-empty', !titleEl.textContent.trim())
      bodyEl.classList.toggle(
        'is-empty',
        !bodyEl.textContent.trim() && !bodyEl.querySelector('img')
      )
    }

    /** A note that's never been written has nothing to date yet. */
    function paintEdited() {
      editedEl.hidden = !saved?.updated_at
      editedEl.textContent = saved?.updated_at ? `Edited ${relativeTime(saved.updated_at)}` : ''
    }

    function setStatus(text) {
      statusEl.textContent = text ?? ''
    }

    function setError(message) {
      errorEl.hidden = !message
      errorEl.textContent = message ?? ''
    }

    paintDue()
    paintPriority()
    paintDone()
    paintEmpty()
    paintEdited()

    /* -------------------------------------------------------------
       Saving
       ------------------------------------------------------------- */

    function values() {
      return {
        title: titleEl.textContent.trim(),
        body_markdown: markdownFromEditor(bodyEl),
        due_date: dueInput.value || null,
        due_time: dueInput.value ? dueTimeInput.value || null : null,
        priority,
        ...(isList ? { done } : {}),
      }
    }

    function isBlank(fields) {
      return !fields.title && !fields.due_date && !fields.priority && isBlankNote(fields.body_markdown)
    }

    function unchanged(fields) {
      return (
        saved &&
        saved.title === fields.title &&
        saved.body_markdown === fields.body_markdown &&
        (saved.due_date ?? null) === fields.due_date &&
        (saved.due_time ?? null) === fields.due_time &&
        (saved.priority ?? null) === fields.priority &&
        (!isList || Boolean(saved.done) === fields.done)
      )
    }

    async function write(fields) {
      try {
        saved = saved ? await updateCard(saved.id, fields) : await createCard(drawerId, fields)
        changed = true
        setError(null)
        setStatus('Saved')
        paintEdited()
        return true
      } catch (error) {
        setStatus('')
        setError(error?.message || 'That did not save.')
        return false
      }
    }

    /**
     * Write the note away, one save at a time, and report whether what's on
     * screen is now in the database. A caller that arrives while a save is in
     * flight waits for it and then looks again — so the last thing typed
     * always reaches the database, and a save with nothing new to say costs
     * nothing.
     */
    async function save() {
      clearTimeout(saveTimer)
      while (saving) await saving

      const fields = values()
      if (unchanged(fields)) return true
      // Nothing has been written yet and there's nothing worth writing.
      if (!saved && isBlank(fields)) return true

      setStatus('Saving…')
      saving = write(fields)
      try {
        return await saving
      } finally {
        saving = null
      }
    }

    function scheduleSave() {
      clearTimeout(saveTimer)
      setStatus('')
      saveTimer = setTimeout(save, SAVE_AFTER_MS)
    }

    function markDirty() {
      paintEmpty()
      scheduleSave()
    }

    /* -------------------------------------------------------------
       Closing
       ------------------------------------------------------------- */

    let releaseBack = pushBackHandler(() => close({ fromHistory: true }))

    async function close({ fromHistory = false, discarded = false } = {}) {
      if (closed) return

      if (!discarded) {
        clearTimeout(saveTimer)

        // Closing is not worth losing words over. If the write didn't land —
        // no signal on the train, most likely — the note stays open with the
        // error showing, and closing again tries once more.
        if (!(await save())) {
          if (fromHistory) releaseBack = pushBackHandler(() => close({ fromHistory: true }))
          return
        }

        // A note opened, glanced at and left empty was never a note. Only one
        // started here is cleaned up — clearing an existing card is a thing
        // someone might mean.
        if (isNew && saved && isBlank(values())) {
          try {
            await deleteCard(saved.id)
            saved = null
          } catch {
            // Leaving an empty card behind is a blemish, not a failure.
          }
        }
      }

      closed = true
      clearTimeout(saveTimer)

      document.removeEventListener('keydown', onKeydown, true)
      document.removeEventListener('click', onDocumentClick)
      window.removeEventListener('pagehide', onLeaving)
      document.removeEventListener('visibilitychange', onLeaving)
      viewport?.removeEventListener('resize', fitToViewport)
      viewport?.removeEventListener('scroll', fitToViewport)

      backdrop.remove()
      if (!document.querySelector('.lightbox, .sheet')) {
        document.body.classList.remove('has-overlay')
      }
      if (!fromHistory) releaseBack()
      resolve({ card: saved, changed })
    }

    /** The app is going away — write now, without waiting for the debounce.
     *  This is the one that catches a note left open when the phone locks. */
    function onLeaving(event) {
      if (event.type === 'pagehide' || document.visibilityState === 'hidden') save()
    }

    /* -------------------------------------------------------------
       Editing
       ------------------------------------------------------------- */

    titleEl.addEventListener('input', markDirty)
    bodyEl.addEventListener('input', () => {
      const anchor = linkifyAtCaret(bodyEl, { trailing: true })
      if (anchor) attachLinkPreview(bodyEl, anchor, anchor.href)
      markDirty()
    })

    titleEl.addEventListener('keydown', (event) => {
      if (event.key !== 'Enter') return
      event.preventDefault()
      bodyEl.focus()
      caretToEnd(bodyEl)
    })

    bodyEl.addEventListener('keydown', (event) => {
      if (event.key !== 'Enter') return
      const anchor = linkifyAtCaret(bodyEl)
      if (anchor) attachLinkPreview(bodyEl, anchor, anchor.href)
    })

    // The note is a page, so the empty space below the words is still the
    // note: tapping it carries on writing rather than doing nothing.
    backdrop.querySelector('.note-scroll').addEventListener('mousedown', (event) => {
      if (event.target !== event.currentTarget) return
      event.preventDefault()
      bodyEl.focus()
      caretToEnd(bodyEl)
    })

    bodyEl.addEventListener('blur', () => {
      const anchor = linkifyAtCaret(bodyEl)
      if (anchor) {
        attachLinkPreview(bodyEl, anchor, anchor.href)
        markDirty()
      }
    })

    // Both fields take plain text only: a paste should bring the words, not
    // whatever font the page it came from was using.
    for (const field of [titleEl, bodyEl]) {
      field.addEventListener('paste', (event) => {
        const file = [...(event.clipboardData?.files ?? [])].find((f) => looksLikeImage(f.type))
        if (file) {
          event.preventDefault()
          addImage(file)
          return
        }

        const text = event.clipboardData?.getData('text/plain')
        if (text == null) return
        event.preventDefault()

        if (field === titleEl) {
          document.execCommand('insertText', false, text.replace(/\s+/g, ' ').trim())
          markDirty()
          return
        }

        document.execCommand('insertText', false, text)
        keepingCaret(() => {
          for (const anchor of linkifyTree(bodyEl)) {
            attachLinkPreview(bodyEl, anchor, anchor.href)
          }
        })
        markDirty()
      })
    }

    /* -------------------------------------------------------------
       Pictures
       ------------------------------------------------------------- */

    async function addImage(file) {
      setError(null)
      setStatus('Adding picture…')
      try {
        const path = await uploadNoteImage(file)
        if (closed) return

        const image = document.createElement('img')
        image.dataset.noteImage = path
        image.alt = ''

        // Land it where the caret is if the caret is in the note, and at the
        // end otherwise — a picture chosen from the toolbar has no caret.
        const selection = window.getSelection()
        if (selection?.rangeCount && bodyEl.contains(selection.anchorNode)) {
          const range = selection.getRangeAt(0)
          range.collapse(false)
          range.insertNode(image)
          range.setStartAfter(image)
          range.collapse(true)
          selection.removeAllRanges()
          selection.addRange(range)
        } else {
          bodyEl.append(image)
        }

        await hydrateNoteImages(bodyEl)
        setStatus('')
        markDirty()
      } catch (error) {
        setStatus('')
        setError(error?.message || 'That picture did not go in.')
      }
    }

    imageInput.addEventListener('change', () => {
      const file = imageInput.files[0]
      imageInput.value = ''
      if (file) addImage(file)
    })

    // Tapping a picture opens it full size, which is also where it can be
    // taken back out — that keeps buttons off the pictures themselves.
    bodyEl.addEventListener('click', (event) => {
      if (event.target.closest('[data-editor-chrome]')) return
      const image = event.target.closest('img')
      if (!image) return

      event.preventDefault()
      const source = image.currentSrc || image.getAttribute('src')
      if (!source) return

      openLightbox({
        src: source,
        alt: image.alt,
        onRemove: () => {
          ;(image.closest('a.note-link-card') ?? image).remove()
          markDirty()
        },
      })
    })

    bodyEl.addEventListener('pointerdown', (event) => {
      const remove = event.target.closest('[data-editor-chrome]')
      if (!remove) return
      event.preventDefault()
      event.stopPropagation()
      remove.closest('a')?.remove()
      markDirty()
    })

    sheet.addEventListener('dragover', (event) => {
      event.preventDefault()
      sheet.classList.add('is-dropping')
    })
    sheet.addEventListener('dragleave', (event) => {
      if (event.target === sheet) sheet.classList.remove('is-dropping')
    })
    sheet.addEventListener('drop', (event) => {
      event.preventDefault()
      sheet.classList.remove('is-dropping')
      const file = event.dataTransfer?.files?.[0]
      if (file) addImage(file)
    })

    /* -------------------------------------------------------------
       The bar along the bottom
       ------------------------------------------------------------- */

    const tools = backdrop.querySelector('.note-tools')

    // Stops a toolbar button stealing focus on mousedown, which would collapse
    // the selection the click handler is about to act on.
    tools.addEventListener('mousedown', (event) => {
      if (event.target.closest('[data-tool]')) event.preventDefault()
    })

    tools.addEventListener('click', (event) => {
      const tool = event.target.closest('[data-tool]')
      if (!tool) return

      switch (tool.dataset.tool) {
        case 'image':
          imageInput.click()
          break
        case 'bold':
          document.execCommand('bold')
          markDirty()
          break
        case 'italic':
          document.execCommand('italic')
          markDirty()
          break
        case 'list':
          document.execCommand('insertUnorderedList')
          markDirty()
          break
        case 'numbers':
          document.execCommand('insertOrderedList')
          markDirty()
          break
        case 'link': {
          const url = window.prompt('Link', 'https://')
          if (!url) break
          bodyEl.focus()
          const selection = window.getSelection()
          if (!selection?.rangeCount || !bodyEl.contains(selection.anchorNode)) caretToEnd(bodyEl)
          document.execCommand('createLink', false, url)
          const anchor = [...bodyEl.querySelectorAll('a')].find((a) => a.href === url)
          if (anchor) attachLinkPreview(bodyEl, anchor, url)
          markDirty()
          break
        }
      }
    })

    // The input covers the whole chip at zero opacity, which is what makes a
    // tap open the native picker on a phone. Desktop browsers need asking.
    dueInput.addEventListener('click', () => {
      try {
        dueInput.showPicker?.()
      } catch {
        // Not allowed here (or not implemented) — the input's own click stands.
      }
    })

    dueInput.addEventListener('change', () => {
      paintDue()
      markDirty()
    })

    dueTimeInput.addEventListener('change', markDirty)

    dueClear.addEventListener('click', () => {
      dueInput.value = ''
      dueTimeInput.value = ''
      paintDue()
      markDirty()
    })

    // On a wide screen the sheet is a panel with the page showing around it,
    // and pressing past its edge closes it. On mousedown rather than click, so
    // a text selection that starts inside the note and ends outside it doesn't
    // read as "close" — the same reason the dialogs do it this way.
    backdrop.addEventListener('mousedown', (event) => {
      if (event.target === backdrop) close()
    })

    backdrop.addEventListener('click', (event) => {
      const dot = event.target.closest('[data-priority]')
      if (!dot) return
      priority = priority === dot.dataset.priority ? null : dot.dataset.priority
      paintPriority()
      markDirty()
    })

    tickButton?.addEventListener('click', () => {
      done = !done
      paintDone()
      markDirty()
    })

    /* -------------------------------------------------------------
       Menu and closing
       ------------------------------------------------------------- */

    function closeMenu() {
      menuTrigger.setAttribute('aria-expanded', 'false')
      menuList.hidden = true
    }

    menuTrigger.addEventListener('click', (event) => {
      event.stopPropagation()
      const open = menuTrigger.getAttribute('aria-expanded') === 'true'
      menuTrigger.setAttribute('aria-expanded', String(!open))
      menuList.hidden = open
    })

    // The same flash-to-a-checkmark feedback the card tiles use for their own
    // copy button — no clipboard permission means no visible change, which is
    // fine since there's nothing to recover from.
    copyButton.addEventListener('click', async () => {
      const text = [titleEl.textContent.trim(), bodyEl.textContent.trim()]
        .filter(Boolean)
        .join('\n\n')
      if (!text) return

      try {
        await navigator.clipboard.writeText(text)
      } catch {
        return
      }
      if (closed) return

      copyButton.classList.add('is-copied')
      copyButton.innerHTML = ICONS.check
      setTimeout(() => {
        if (!copyButton.isConnected) return
        copyButton.classList.remove('is-copied')
        copyButton.innerHTML = ICONS.copy
      }, 1200)
    })

    menuList.addEventListener('click', async (event) => {
      const action = event.target.closest('[data-act]')?.dataset.act
      if (!action) return
      closeMenu()

      // Every one of these needs the note to exist first, so whatever is on
      // screen is written away before it's filed somewhere.
      await save()
      if (!saved) {
        close({ discarded: true })
        return
      }

      try {
        if (action === 'move') {
          // Cancelled, or it didn't go through: the note stays open and the
          // view underneath has already said why.
          if (await onMove(saved)) {
            changed = true
            close({ discarded: true })
          }
          return
        }

        if (action === 'archive') await archiveCard(saved.id)
        else await trashCard(saved.id)
        changed = true
        close({ discarded: true })
      } catch (error) {
        setError(error?.message || 'That did not go through.')
      }
    })

    function onDocumentClick(event) {
      if (!event.target.closest('.sheet-head .menu')) closeMenu()
    }
    document.addEventListener('click', onDocumentClick)

    backdrop.querySelector('[data-close]').addEventListener('click', () => close())

    function onKeydown(event) {
      if (event.key !== 'Escape') return
      // The picture viewer sits above and handles its own Escape.
      if (document.querySelector('.lightbox')) return
      event.preventDefault()
      close()
    }
    document.addEventListener('keydown', onKeydown, true)

    window.addEventListener('pagehide', onLeaving)
    document.addEventListener('visibilitychange', onLeaving)

    /* -------------------------------------------------------------
       Sitting above the phone keyboard
       ------------------------------------------------------------- */

    // Only on a phone, where the sheet fills the screen. On a wide screen it's
    // a centred panel that the keyboard never reaches, and forcing a height on
    // it would just stretch it to the window.
    const fullScreen = window.matchMedia('(max-width: 40rem)')

    function fitToViewport() {
      if (!viewport || !fullScreen.matches) {
        sheet.style.height = ''
        sheet.style.transform = ''
        return
      }
      sheet.style.height = `${viewport.height}px`
      sheet.style.transform = `translateY(${viewport.offsetTop}px)`
    }

    viewport?.addEventListener('resize', fitToViewport)
    viewport?.addEventListener('scroll', fitToViewport)
    fitToViewport()

    if (isNew) {
      bodyEl.focus()
      caretToEnd(bodyEl)
    }
  })
}
