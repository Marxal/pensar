// A picture, full size, on top of everything.
//
// Tapping any image — inside a note being written, or inside one being read on
// a card — opens it here, because a picture in a note is usually the point of
// the note and a thumbnail is not much use. When the editor opens it, it also
// hands over a way to take the picture back out, which is why the editor's
// images carry no buttons of their own.

import { pushBackHandler } from './backstack'

const ICONS = {
  close: `<svg viewBox="0 0 24 24" aria-hidden="true"><path d="M6 6l12 12M18 6L6 18"/></svg>`,
  trash: `<svg viewBox="0 0 24 24" aria-hidden="true"><path d="M5 7h14M9.5 7V5.2A1.2 1.2 0 0 1 10.7 4h2.6a1.2 1.2 0 0 1 1.2 1.2V7M7.5 7l.7 11.3A1.7 1.7 0 0 0 9.9 20h4.2a1.7 1.7 0 0 0 1.7-1.7L16.5 7M10.3 10.5v6M13.7 10.5v6"/></svg>`,
}

/**
 * Show `src` full size. `onRemove`, when given, adds a button that takes the
 * picture out of the note it came from and closes the viewer.
 */
export function openLightbox({ src, alt = '', onRemove = null }) {
  if (!src) return

  const backdrop = document.createElement('div')
  backdrop.className = 'lightbox'
  backdrop.innerHTML = `
    <div class="lightbox-bar">
      ${
        onRemove
          ? `<button type="button" class="lightbox-btn lightbox-btn-danger" data-remove>
               ${ICONS.trash}<span>Remove</span>
             </button>`
          : '<span></span>'
      }
      <button type="button" class="lightbox-btn" data-close aria-label="Close">${ICONS.close}</button>
    </div>
    <img class="lightbox-image" src="${src.replace(/"/g, '&quot;')}" alt="">
  `

  const image = backdrop.querySelector('.lightbox-image')
  image.alt = alt

  document.body.appendChild(backdrop)
  document.body.classList.add('has-overlay')

  let closed = false
  const dispose = pushBackHandler(() => close({ fromHistory: true }))

  function close({ fromHistory = false } = {}) {
    if (closed) return
    closed = true
    document.removeEventListener('keydown', onKeydown, true)
    backdrop.remove()
    if (!document.querySelector('.lightbox, .sheet')) {
      document.body.classList.remove('has-overlay')
    }
    if (!fromHistory) dispose()
  }

  function onKeydown(event) {
    if (event.key !== 'Escape') return
    event.preventDefault()
    event.stopPropagation()
    close()
  }
  document.addEventListener('keydown', onKeydown, true)

  backdrop.addEventListener('click', (event) => {
    if (event.target.closest('[data-remove]')) {
      close()
      onRemove()
      return
    }
    // Anywhere but the picture itself closes — including the close button.
    if (!event.target.closest('.lightbox-image')) close()
  })
}
