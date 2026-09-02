// Promise-based modals: a single-field prompt, a confirm, the drawer settings,
// the board's looks, and the "move this somewhere else" picker.
//
// Plain divs rather than <dialog> so older iOS Safari is covered too. The note
// editor is deliberately not here — a note is a page, not a dialog, and it
// lives in noteEditor.js.

import { escapeHtml } from './format'
import { DRAWER_KINDS, DRAWER_KIND_LABELS, DRAWER_KIND_HINTS } from './drawers'
import { BOARD_COLOURS, BOARD_EMOJI, boardColour } from './boardStyle'
import { uploadBoardIcon, removeImage, signImage } from './images'
import { setBoardStyle } from './boards'

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
    document.body.classList.add('has-overlay')

    let done = false
    function finish(value) {
      if (done) return
      done = true
      document.removeEventListener('keydown', onKeydown, true)
      backdrop.remove()
      if (!document.querySelector('.lightbox, .sheet, .modal-backdrop')) {
        document.body.classList.remove('has-overlay')
      }
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

/* ---------------------------------------------------------------
   Drawers
   --------------------------------------------------------------- */

/**
 * Name a drawer and say what shape it is. Resolves with `{ name, kind }`, or
 * null if dismissed.
 */
export function openDrawerDialog({ drawer = null } = {}) {
  const editing = Boolean(drawer)

  return openModal({
    build: () => `
      <h2 class="modal-title">${editing ? 'Edit drawer' : 'New drawer'}</h2>
      <form class="modal-form" novalidate>
        <label class="field">
          <span class="field-label">Name</span>
          <input
            class="field-input"
            name="name"
            type="text"
            autocomplete="off"
            maxlength="40"
            placeholder="Reading"
            value="${escapeHtml(drawer?.name ?? '')}"
          />
        </label>

        <div class="field">
          <span class="field-label">Shape</span>
          <div class="kind-list">
            ${DRAWER_KINDS.map(
              (kind) => `
                <label class="kind-option">
                  <input type="radio" name="kind" value="${kind}"${
                    (drawer?.kind ?? 'notes') === kind ? ' checked' : ''
                  }>
                  <span class="kind-option-text">
                    <span class="kind-option-name">${DRAWER_KIND_LABELS[kind]}</span>
                    <span class="kind-option-hint">${DRAWER_KIND_HINTS[kind]}</span>
                  </span>
                </label>
              `
            ).join('')}
          </div>
        </div>

        <div class="modal-actions">
          <button type="button" class="btn btn-ghost" data-close>Cancel</button>
          <button type="submit" class="btn btn-primary">${editing ? 'Save' : 'Add drawer'}</button>
        </div>
      </form>
    `,
    wire: (modal, finish) => {
      const form = modal.querySelector('form')
      const name = form.elements.name

      form.addEventListener('submit', (event) => {
        event.preventDefault()
        if (!name.value.trim()) {
          name.focus()
          return
        }
        finish({ name: name.value.trim(), kind: form.elements.kind.value })
      })

      modal.querySelector('[data-close]').addEventListener('click', () => finish(null))
      name.focus()
      name.select()
    },
  })
}

/* ---------------------------------------------------------------
   Boards
   --------------------------------------------------------------- */

/**
 * Name a board and dress it: a colour, and an icon that's either an emoji or a
 * picture. Resolves with `{ name, colour, emoji }`, or null if dismissed.
 *
 * The picture is the odd one out — it uploads and saves the moment it's picked,
 * the way a card's cover does, because it needs a board id to be stored
 * against. That's also why it's only offered for a board that already exists.
 */
export function openBoardDialog({ board = null } = {}) {
  const editing = Boolean(board)

  return openModal({
    build: () => `
      <h2 class="modal-title">${editing ? 'Board' : 'New board'}</h2>
      <form class="modal-form" novalidate>
        <label class="field">
          <span class="field-label">Name</span>
          <input
            class="field-input"
            name="name"
            type="text"
            autocomplete="off"
            maxlength="40"
            placeholder="Reading list"
            value="${escapeHtml(board?.name ?? '')}"
          />
        </label>

        <div class="field">
          <span class="field-label">Colour</span>
          <div class="swatch-row" data-colours>
            ${BOARD_COLOURS.map(
              ({ key, label }) => `
                <button
                  type="button"
                  class="swatch"
                  data-colour="${key}"
                  data-tint="${key}"
                  aria-pressed="${String(boardColour(board) === key)}"
                  aria-label="${label}"
                  title="${label}"
                ></button>
              `
            ).join('')}
          </div>
        </div>

        <div class="field">
          <span class="field-label">Icon</span>
          <div class="icon-picked" data-icon-preview data-tint="${boardColour(board)}">
            <img data-icon-image alt="" hidden>
            <span data-icon-emoji>${escapeHtml(board?.emoji ?? '')}</span>
          </div>
          <div class="emoji-row" data-emoji>
            <button type="button" class="emoji-btn" data-emoji-value="" title="No icon" aria-label="No icon">—</button>
            ${BOARD_EMOJI.map(
              (emoji) =>
                `<button type="button" class="emoji-btn" data-emoji-value="${emoji}" aria-label="${emoji}">${emoji}</button>`
            ).join('')}
          </div>
          ${
            editing
              ? `<div class="icon-file">
                   <button type="button" class="btn btn-ghost btn-sm" data-icon-pick>Use a picture…</button>
                   <button type="button" class="btn btn-ghost btn-sm menu-danger" data-icon-drop hidden>Remove picture</button>
                   <span class="icon-file-status" data-icon-status hidden></span>
                   <input type="file" accept="image/*" data-icon-input hidden>
                 </div>`
              : `<p class="field-hint">A picture can go on once the board exists.</p>`
          }
        </div>

        <div class="modal-actions">
          <button type="button" class="btn btn-ghost" data-close>Cancel</button>
          <button type="submit" class="btn btn-primary">${editing ? 'Save' : 'Create board'}</button>
        </div>
      </form>
    `,
    wire: (modal, finish) => {
      const form = modal.querySelector('form')
      const name = form.elements.name
      const preview = modal.querySelector('[data-icon-preview]')
      const previewImage = modal.querySelector('[data-icon-image]')
      const previewEmoji = modal.querySelector('[data-icon-emoji]')
      const status = modal.querySelector('[data-icon-status]')
      const dropButton = modal.querySelector('[data-icon-drop]')

      let colour = boardColour(board)
      let emoji = board?.emoji ?? ''
      let iconPath = board?.icon_path ?? null

      function paint() {
        for (const swatch of modal.querySelectorAll('[data-colour]')) {
          swatch.setAttribute('aria-pressed', String(swatch.dataset.colour === colour))
        }
        for (const button of modal.querySelectorAll('[data-emoji-value]')) {
          button.classList.toggle(
            'is-picked',
            !iconPath && button.dataset.emojiValue === emoji
          )
        }
        preview.dataset.tint = colour
        previewEmoji.textContent = iconPath ? '' : emoji
        previewImage.hidden = !iconPath
        if (dropButton) dropButton.hidden = !iconPath
      }

      async function showIcon() {
        if (!iconPath) return
        const url = await signImage(iconPath)
        if (url) previewImage.src = url
      }

      paint()
      showIcon()

      modal.querySelector('[data-colours]').addEventListener('click', (event) => {
        const swatch = event.target.closest('[data-colour]')
        if (!swatch) return
        colour = swatch.dataset.colour
        paint()
      })

      modal.querySelector('[data-emoji]').addEventListener('click', (event) => {
        const button = event.target.closest('[data-emoji-value]')
        if (!button) return
        emoji = button.dataset.emojiValue
        // An emoji and a picture are two answers to the same question.
        if (emoji) iconPath = null
        paint()
      })

      const iconInput = modal.querySelector('[data-icon-input]')
      modal.querySelector('[data-icon-pick]')?.addEventListener('click', () => iconInput.click())

      iconInput?.addEventListener('change', async () => {
        const file = iconInput.files[0]
        iconInput.value = ''
        if (!file) return

        status.hidden = false
        status.textContent = 'Uploading…'
        try {
          iconPath = await uploadBoardIcon(board.id, file)
          await setBoardStyle(board.id, { icon_path: iconPath })
          emoji = ''
          status.hidden = true
          paint()
          await showIcon()
        } catch (error) {
          status.textContent = error?.message || 'That upload did not go through.'
        }
      })

      dropButton?.addEventListener('click', async () => {
        const dropped = iconPath
        try {
          await setBoardStyle(board.id, { icon_path: null })
          iconPath = null
          previewImage.removeAttribute('src')
          paint()
          await removeImage(dropped)
        } catch (error) {
          status.hidden = false
          status.textContent = error?.message || 'That did not go through.'
        }
      })

      form.addEventListener('submit', (event) => {
        event.preventDefault()
        if (!name.value.trim()) {
          name.focus()
          return
        }
        finish({ name: name.value.trim(), colour, emoji: emoji || null })
      })

      modal.querySelector('[data-close]').addEventListener('click', () => finish(null))
      name.focus()
      name.select()
    },
  })
}

/* ---------------------------------------------------------------
   Moving a card
   --------------------------------------------------------------- */

/**
 * Pick where a card should go: Quick notes, or any drawer on any board.
 * Resolves with `{ drawerId }` — null meaning Quick notes — or null if
 * dismissed. The card's current home is shown but not offered.
 */
export function openMovePicker({ boards, drawers, currentDrawerId = null }) {
  const byBoard = new Map()
  for (const drawer of drawers) {
    if (!byBoard.has(drawer.board_id)) byBoard.set(drawer.board_id, [])
    byBoard.get(drawer.board_id).push(drawer)
  }

  function row(label, drawerId, current) {
    if (current) {
      return `<span class="picker-row picker-row-current">${escapeHtml(label)} <em>here now</em></span>`
    }
    return `<button type="button" class="picker-row" data-drawer="${drawerId ?? ''}">${escapeHtml(label)}</button>`
  }

  return openModal({
    build: () => `
      <h2 class="modal-title">Move to</h2>
      <div class="picker-list">
        ${row('Quick notes', null, currentDrawerId === null)}
        ${boards
          .map((board) => {
            const inside = byBoard.get(board.id) ?? []
            if (!inside.length) return ''
            return `
              <div class="picker-group">
                <p class="picker-group-name">${escapeHtml(board.name)}</p>
                ${inside
                  .map((drawer) => row(drawer.name, drawer.id, drawer.id === currentDrawerId))
                  .join('')}
              </div>
            `
          })
          .join('')}
      </div>
      <div class="modal-actions">
        <button type="button" class="btn btn-ghost" data-close>Cancel</button>
      </div>
    `,
    wire: (modal, finish) => {
      modal.querySelector('[data-close]').addEventListener('click', () => finish(null))
      modal.addEventListener('click', (event) => {
        const button = event.target.closest('[data-drawer]')
        if (!button) return
        finish({ drawerId: button.dataset.drawer || null })
      })
    },
  })
}
