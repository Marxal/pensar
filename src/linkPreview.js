// Asks the pensar-link-preview Edge Function what a URL leads to, so a link
// card can be built from the page's own words and picture without the browser
// CORS-failing a direct fetch of someone else's page.

import { supabase } from './supabaseClient'

/**
 * Resolves with `{ url, title, description, site, image, icon }` — every field
 * null when the page didn't offer it — or null if the call itself failed.
 * `icon` is the site's own icon, sent only when the page has no picture, and
 * `linkCard.js` is what decides how to draw either. Never throws: a missing
 * preview just means the link stays a plain link.
 */
export async function fetchLinkPreview(url) {
  try {
    const { data, error } = await supabase.functions.invoke('pensar-link-preview', {
      body: { url },
    })
    if (error) return null
    return data ?? null
  } catch {
    return null
  }
}
