// Asks the pensar-link-preview Edge Function for a URL's Open Graph image,
// so the note editor can show it without the browser CORS-failing a direct
// fetch of someone else's page.

import { supabase } from './supabaseClient'

/**
 * Resolves with `{ url, title, description, image }` (fields null when
 * unavailable), or null if the function call itself failed. Never throws —
 * a missing preview just means the link stays a plain link.
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
