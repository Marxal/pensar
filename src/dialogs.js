// Promise-based modals: a single-field text prompt, a confirm, and the card editor.
// Plain divs rather than <dialog> so older iOS Safari is covered too.

import { escapeHtml } from './format'
import { PRIORITY_LABELS, STATUSES, STATUS_LABELS } from './cards'
import { renderMarkdown, markdownFromHtml } from './markdown'
import { fetchLinkPreview } from './linkPreview'

/**
 * Mount a modal and resolve with whatever `finish` is called with.
 * `build` returns the inner markup; `wire` gets the modal element and `finish`.
 */
function openModal({ build, wire, wide = false }) {
  return new Promise((resolve) => {
    const previouslyFocused = document.activeElement

    const backdrop = document.createElement('div')
    backdrop.className = 'modal-backdrop'
    backdrop.innerHTML = `<div class="modal${wide ? ' modal-wide' : ''}" role="dialog" aria-modal="true">${build()}</div>`
    document.body.appendChild(backdrop)
    document.body.classList.add('modal-open')

    let done = false
    function finish(value) {
      if (done) return
      done = true
      document.removeEventListener('keydown', onKeydown, true)
      backdrop.remove()
      document.body.classList.remove('modal-open')
      if (previouslyFocused instanceof HTMLElement) previouslyFocused.focus()
      resolve(value)
    }

    function onKeydown(event) {
      if (event.key === 'Escape') {
        event.preventDefault()
        finish(null)
      }
    }
    document.addEventListener('keydown', onKeydown, true)

    backdrop.addEventListener('mousedown', (event) => {
      if (event.target === backdrop) finish(null)
    })

    wire(backdrop.querySelector('.modal'), finish)
  })
}

/**
 * Ask for a line of text. Resolves with the trimmed value, or null if dismissed.
 * Empty input is refused rather than resolved.
 */
export function openPrompt({
  title,
  label = 'Name',
  value = '',
  placeholder = '',
  confirmLabel = 'Save',
}) {
  return openModal({
    build: () => `
      <h2 class="modal-title">${escapeHtml(title)}</h2>
      <form class="modal-form" novalidate>
        <label class="field">
          <span class="field-label">${escapeHtml(label)}</span>
          <input
            class="field-input"
            name="value"
            type="text"
            autocomplete="off"
            maxlength="80"
            placeholder="${escapeHtml(placeholder)}"
            value="${escapeHtml(value)}"
          />
        </label>
        <div class="modal-actions">
          <button type="button" class="btn btn-ghost" data-close>Cancel</button>
          <button type="submit" class="btn btn-primary">${escapeHtml(confirmLabel)}</button>
        </div>
      </form>
    `,
    wire: (modal, finish) => {
      const form = modal.querySelector('form')
      const input = modal.querySelector('.field-input')

      form.addEventListener('submit', (event) => {
        event.preventDefault()
        const next = input.value.trim()
        if (!next) {
          input.focus()
          return
        }
        finish(next)
      })

      modal.querySelector('[data-close]').addEventListener('click', () => finish(null))

      input.focus()
      input.select()
    },
  })
}

/** Resolves true when confirmed, false otherwise. */
export function openConfirm({
  title,
  message = '',
  confirmLabel = 'Confirm',
  cancelLabel = 'Cancel',
  destructive = false,
}) {
  return openModal({
    build: () => `
      <h2 class="modal-title">${escapeHtml(title)}</h2>
      ${message ? `<p class="modal-message">${escapeHtml(message)}</p>` : ''}
      <div class="modal-actions">
        <button type="button" class="btn btn-ghost" data-close>${escapeHtml(cancelLabel)}</button>
        <button type="button" class="btn ${destructive ? 'btn-danger' : 'btn-primary'}" data-confirm>
          ${escapeHtml(confirmLabel)}
        </button>
      </div>
    `,
    wire: (modal, finish) => {
      const confirmButton = modal.querySelector('[data-confirm]')
      confirmButton.addEventListener('click', () => finish(true))
      modal.querySelector('[data-close]').addEventListener('click', () => finish(false))
      confirmButton.focus()
    },
  }).then((result) => result === true)
}

/**
 * Pick a board and column for an inbox card. Resolves with `{ boardId, status }`,
 * `{ newBoard: true }` if there are no boards to pick from and the user wants
 * to make one, or null if dismissed.
 */
export function openBoardPicker({ boards }) {
  return openModal({
    build: () =>
      boards.length
        ? `
          <h2 class="modal-title">Assign to board</h2>
          <div class="picker-list">
            ${boards
              .map(
                (board) => `
                  <div class="picker-row">
                    <span class="picker-row-name">${escapeHtml(board.name)}</span>
                    <div class="picker-row-actions">
                      ${STATUSES.map(
                        (status) =>
                          `<button type="button" class="btn btn-ghost btn-sm" data-board="${board.id}" data-status="${status}">${STATUS_LABELS[status]}</button>`
                      ).join('')}
                    </div>
                  </div>
                `
              )
              .join('')}
          </div>
          <div class="modal-actions">
            <button type="button" class="btn btn-ghost" data-close>Cancel</button>
          </div>
        `
        : `
          <h2 class="modal-title">Assign to board</h2>
          <p class="modal-message">You don't have any boards yet — create one first.</p>
          <div class="modal-actions">
            <button type="button" class="btn btn-ghost" data-close>Cancel</button>
            <button type="button" class="btn btn-primary" data-new-board>New board</button>
          </div>
        `,
    wire: (modal, finish) => {
      modal.querySelector('[data-close]').addEventListener('click', () => finish(null))
      modal.querySelector('[data-new-board]')?.addEventListener('click', () => finish({ newBoard: true }))
      modal.addEventListener('click', (event) => {
        const button = event.target.closest('[data-board]')
        if (!button) return
        finish({ boardId: button.dataset.board, status: button.dataset.status })
      })
    },
  })
}

/**
 * Insert a link at the current selection inside the note editor — the
 * selected text becomes the link text, or the URL itself if nothing was
 * selected. Returns the new <a>, or null if the prompt was cancelled or
 * there was nowhere sensible to put it.
 */
function insertLink(editor) {
  const selection = window.getSelection()
  if (!selection.rangeCount || !editor.contains(selection.anchorNode)) {
    const range = document.createRange()
    range.selectNodeContents(editor)
    range.collapse(false)
    selection.removeAllRanges()
    selection.addRange(range)
  }

  // window.prompt is synchronous but still risks the selection collapsing
  // (Safari especially), so it's saved before and restored after.
  const savedRange = selection.getRangeAt(0).cloneRange()
  const url = window.prompt('Link URL', 'https://')
  if (!url) return null

  selection.removeAllRanges()
  selection.addRange(savedRange)
  const range = selection.getRangeAt(0)

  const anchor = document.createElement('a')
  anchor.href = url
  anchor.textContent = range.collapsed ? url : range.toString()
  range.deleteContents()
  range.insertNode(anchor)

  range.setStartAfter(anchor)
  range.collapse(true)
  selection.removeAllRanges()
  selection.addRange(range)

  return anchor
}

/**
 * Turn a link-preview anchor into a small card with a remove button, so a
 * fresh preview and one hydrated back from saved markdown look and behave
 * the same way. Safe to call more than once — already-decorated anchors
 * are left alone.
 */
function decorateLinkPreview(anchor) {
  if (anchor.classList.contains('editor-link-preview')) return
  anchor.classList.add('editor-link-preview')
  anchor.contentEditable = 'false'
  anchor.target = '_blank'
  anchor.rel = 'noopener noreferrer'

  const remove = document.createElement('button')
  remove.type = 'button'
  remove.className = 'editor-link-preview-remove'
  remove.setAttribute('aria-label', 'Remove preview image')
  remove.title = 'Remove preview image'
  remove.textContent = '×'
  remove.addEventListener('click', (event) => {
    event.preventDefault()
    event.stopPropagation()
    anchor.remove()
  })
  anchor.appendChild(remove)
}

/**
 * Find every link-preview-shaped anchor in the editor — one whose only
 * content is an image — and make sure it's decorated. Run once right after
 * hydrating a saved note, since the markdown round-trip doesn't carry the
 * `editor-link-preview` class itself.
 */
function decorateAllLinkPreviews(editor) {
  editor.querySelectorAll('a').forEach((anchor) => {
    if (anchor.children.length === 1 && anchor.firstElementChild.tagName === 'IMG') {
      decorateLinkPreview(anchor)
    }
  })
}

/**
 * Fetch the link's Open Graph image and drop it right after `anchor`, as
 * its own small link-card thumbnail. Silent no-op if the page has no
 * image, the fetch fails, or the editor/anchor is gone by the time it
 * resolves.
 */
async function attachLinkPreview(editor, anchor, url) {
  const preview = await fetchLinkPreview(url)
  if (!preview?.image || !editor.isConnected || !editor.contains(anchor)) return

  const wrap = document.createElement('a')
  wrap.href = url
  const img = document.createElement('img')
  img.src = preview.image
  img.alt = preview.title || ''
  wrap.appendChild(img)
  decorateLinkPreview(wrap)

  anchor.insertAdjacentElement('afterend', wrap)
  wrap.insertAdjacentHTML('afterend', '<br>')
}

/**
 * The note's markdown, without the remove buttons the editor adds to
 * link-preview cards — those are an editing affordance only, never
 * something that should end up in body_markdown.
 */
function cleanedEditorHtml(editor) {
  const clone = editor.cloneNode(true)
  clone.querySelectorAll('.editor-link-preview-remove').forEach((button) => button.remove())
  return clone.innerHTML
}

/**
 * Card editor: title, note, due date, priority. The note editor is
 * WYSIWYG — it shows formatted text directly, no markdown source or
 * preview toggle. Pasting a link fetches and shows its preview image.
 *
 * Resolves with `{ title, body_markdown, due_date, priority }`, or null if
 * dismissed. Pass `card` to edit an existing one. Title is optional — a
 * note just needs *something*, in the title or the body.
 */
export function openCardEditor({ card = null, columnLabel = '' } = {}) {
  const editing = Boolean(card)

  const priorityOptions = ['', ...Object.keys(PRIORITY_LABELS)]
    .map((value) => {
      const selected = (card?.priority ?? '') === value ? ' selected' : ''
      const label = value ? PRIORITY_LABELS[value] : 'None'
      return `<option value="${value}"${selected}>${label}</option>`
    })
    .join('')

  return openModal({
    wide: true,
    build: () => `
      <h2 class="modal-title">${editing ? 'Edit card' : 'New card'}</h2>
      ${columnLabel ? `<p class="modal-message">In ${escapeHtml(columnLabel)}</p>` : ''}
      <form class="modal-form" novalidate>
        <label class="field">
          <span class="field-label">Title</span>
          <input
            class="field-input"
            name="title"
            type="text"
            autocomplete="off"
            maxlength="200"
            placeholder="Something to do (optional)"
            value="${escapeHtml(card?.title ?? '')}"
          />
        </label>

        <div class="field">
          <span class="field-label">Note</span>
          <div class="editor-toolbar">
            <button type="button" class="editor-tool" data-action="bold" title="Bold" aria-label="Bold"><strong>B</strong></button>
            <button type="button" class="editor-tool" data-action="italic" title="Italic" aria-label="Italic"><em>I</em></button>
            <button type="button" class="editor-tool" data-action="list" title="Bulleted list" aria-label="Bulleted list">&bull; list</button>
            <button type="button" class="editor-tool" data-action="link" title="Link" aria-label="Link">link</button>
          </div>
          <div
            class="field-input editor-body markdown-body"
            contenteditable="true"
            role="textbox"
            aria-multiline="true"
            aria-label="Note"
            data-placeholder="Write it straight — no markdown needed"
          >${card?.body_markdown ? renderMarkdown(card.body_markdown) : ''}</div>
        </div>

        <div class="field-row">
          <label class="field">
            <span class="field-label">Due date</span>
            <input class="field-input" name="due" type="date" value="${escapeHtml(card?.due_date ?? '')}" />
          </label>
          <label class="field">
            <span class="field-label">Priority</span>
            <select class="field-input" name="priority">${priorityOptions}</select>
          </label>
        </div>

        <div class="modal-actions">
          <button type="button" class="btn btn-ghost" data-close>Cancel</button>
          <button type="submit" class="btn btn-primary">${editing ? 'Save' : 'Add card'}</button>
        </div>
      </form>
    `,
    wire: (modal, finish) => {
      const form = modal.querySelector('form')
      const title = form.elements.title
      const editor = modal.querySelector('.editor-body')
      const toolbar = modal.querySelector('.editor-toolbar')

      function syncEmptyState() {
        editor.classList.toggle('is-empty', !editor.textContent.trim())
      }
      decorateAllLinkPreviews(editor)
      syncEmptyState()
      editor.addEventListener('input', syncEmptyState)

      // Prevents the toolbar button from stealing focus on mousedown, which
      // would collapse the selection the click handler needs to act on.
      toolbar.addEventListener('mousedown', (event) => {
        if (event.target.closest('[data-action]')) event.preventDefault()
      })

      toolbar.addEventListener('click', (event) => {
        const button = event.target.closest('[data-action]')
        if (!button) return

        switch (button.dataset.action) {
          case 'bold':
            document.execCommand('bold')
            break
          case 'italic':
            document.execCommand('italic')
            break
          case 'list':
            document.execCommand('insertUnorderedList')
            break
          case 'link': {
            const anchor = insertLink(editor)
            if (anchor) attachLinkPreview(editor, anchor, anchor.href)
            break
          }
        }
        syncEmptyState()
      })

      form.addEventListener('submit', (event) => {
        event.preventDefault()
        const hasTitle = Boolean(title.value.trim())
        const hasBody = Boolean(editor.textContent.trim())
        if (!hasTitle && !hasBody) {
          editor.focus()
          return
        }
        finish({
          title: title.value.trim(),
          body_markdown: markdownFromHtml(cleanedEditorHtml(editor)),
          due_date: form.elements.due.value || null,
          priority: form.elements.priority.value || null,
        })
      })

      modal.querySelector('[data-close]').addEventListener('click', () => finish(null))

      // Editing leads with the title, since there's usually one already;
      // a new card leads with the note, since a title isn't required.
      if (editing) {
        title.focus()
        title.select()
      } else {
        editor.focus()
      }
    },
  })
}
