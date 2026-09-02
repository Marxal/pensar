// Promise-based modals: a single-field prompt, a confirm, the drawer settings,
// the board's looks, and the "move this somewhere else" picker.
//
// Plain divs rather than <dialog> so older iOS Safari is covered too. The note
// editor is deliberately not here — a note is a page, not a dialog, and it
// lives in noteEditor.js.

import { escapeHtml } from './format'
import { DRAWER_KINDS, DRAWER_KIND_LABELS, DRAWER_KIND_HINTS } from './drawers'
import { BOARD_COLOURS, boardColour, oneEmoji } from './boardStyle'
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
 * Name a new drawer and say what shape it starts as — the shape can still be
 * changed afterwards from the icons on the drawer itself. Resolves with
 * `{ name, kind }`, or null if dismissed.
 */
export function openDrawerDialog() {
  return openModal({
    build: () => `
      <h2 class="modal-title">New drawer</h2>
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
          />
        </label>

        <div class="field">
          <span class="field-label">Shape</span>
          <div class="kind-list">
            ${DRAWER_KINDS.map(
              (kind) => `
                <label class="kind-option">
                  <input type="radio" name="kind" value="${kind}"${kind === 'notes' ? ' checked' : ''}>
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
          <button type="submit" class="btn btn-primary">Add drawer</button>
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
 *
 * The emoji is whatever your own keyboard offers, typed into a field, rather
 * than a grid of the handful pensar used to ship — see `oneEmoji`. The picture
 * is a tap on the square, or one dropped onto it.
 */
export function openBoardDialog({ board = null } = {}) {
  const editing = Boolean(board)

  return openModal({
    build: () => `
      <h2 class="modal-title">${editing ? 'Project' : 'New project'}</h2>
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
          <div class="icon-picker">
            <button
              type="button"
              class="icon-picked"
              data-icon-preview
              data-tint="${boardColour(board)}"
              aria-label="${editing ? 'Use a picture' : 'Pick an emoji'}"
              title="${editing ? 'Use a picture' : 'Pick an emoji'}"
            >
              <img data-icon-image alt="" hidden>
              <span data-icon-emoji>${escapeHtml(board?.emoji ?? '')}</span>
            </button>
            <div class="icon-picker-text">
              <input
                class="field-input emoji-input"
                data-emoji-input
                type="text"
                autocomplete="off"
                autocapitalize="off"
                maxlength="24"
                placeholder="Emoji"
                aria-label="Emoji"
                value="${escapeHtml(board?.emoji ?? '')}"
              />
              <p class="field-hint">
                ${
                  editing
                    ? 'Any emoji your keyboard can type. Or tap the square for a picture — you can drop one on it too.'
                    : 'Any emoji your keyboard can type. A picture can go on once the project exists.'
                }
              </p>
            </div>
          </div>
          ${
            editing
              ? `<div class="icon-file">
                   <button type="button" class="btn btn-ghost btn-sm menu-danger" data-icon-drop hidden>Remove picture</button>
                   <span class="icon-file-status" data-icon-status hidden></span>
                   <input type="file" accept="image/*" data-icon-input hidden>
                 </div>`
              : ''
          }
        </div>

        <div class="modal-actions">
          <button type="button" class="btn btn-ghost" data-close>Cancel</button>
          <button type="submit" class="btn btn-primary">${editing ? 'Save' : 'Create project'}</button>
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

      const emojiInput = modal.querySelector('[data-emoji-input]')

      let colour = boardColour(board)
      let emoji = board?.emoji ?? ''
      let iconPath = board?.icon_path ?? null

      function paint() {
        for (const swatch of modal.querySelectorAll('[data-colour]')) {
          swatch.setAttribute('aria-pressed', String(swatch.dataset.colour === colour))
        }
        preview.dataset.tint = colour
        previewEmoji.textContent = iconPath ? '' : emoji
        previewImage.hidden = !iconPath
        preview.classList.toggle('is-empty', !iconPath && !emoji)
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

      emojiInput.addEventListener('input', () => {
        emoji = oneEmoji(emojiInput.value)
        // What the field holds and what the board gets are the same thing.
        if (emojiInput.value !== emoji) emojiInput.value = emoji
        // An emoji and a picture are two answers to the same question.
        if (emoji) iconPath = null
        paint()
      })

      const iconInput = modal.querySelector('[data-icon-input]')

      /** Put a picture on the board. It saves itself: there's no board id to
       *  store it against until the board exists, so this only runs when
       *  editing one that already does. */
      async function useIcon(file) {
        if (!editing || !file) return

        status.hidden = false
        status.textContent = 'Uploading…'
        try {
          iconPath = await uploadBoardIcon(board.id, file)
          await setBoardStyle(board.id, { icon_path: iconPath })
          emoji = ''
          emojiInput.value = ''
          status.hidden = true
          paint()
          await showIcon()
        } catch (error) {
          status.textContent = error?.message || 'That upload did not go through.'
        }
      }

      // The square is the picture: tap it to pick one, or drop one on it. With
      // no board to store it against yet, it sends you to the emoji instead.
      preview.addEventListener('click', () => {
        if (editing) iconInput.click()
        else emojiInput.focus()
      })

      if (editing) {
        preview.addEventListener('dragover', (event) => {
          if (![...(event.dataTransfer?.types ?? [])].includes('Files')) return
          event.preventDefault()
          event.dataTransfer.dropEffect = 'copy'
          preview.classList.add('is-dropping')
        })

        preview.addEventListener('dragleave', () => preview.classList.remove('is-dropping'))

        preview.addEventListener('drop', (event) => {
          event.preventDefault()
          preview.classList.remove('is-dropping')
          useIcon(event.dataTransfer?.files?.[0])
        })
      }

      iconInput?.addEventListener('change', () => {
        const file = iconInput.files[0]
        iconInput.value = ''
        useIcon(file)
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
