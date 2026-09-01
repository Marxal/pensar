/*
 * pensar-link-preview — fetches a pasted URL server-side and reads its
 * Open Graph tags, so the note editor can show the image tied to a link
 * without the browser trying (and CORS-failing) to fetch the page itself.
 *
 * Deploying it: `supabase functions deploy pensar-link-preview --no-verify-jwt`
 * from a real terminal (same constraint as `db push` — Claude Code's
 * sandboxed shell can't reach the CLI's login session).
 *
 * Verify JWT has to be OFF at the platform level, not just handled in code
 * here: when it's on, Supabase's gateway checks every request for a bearer
 * token *before* this function ever runs — including the browser's CORS
 * preflight (OPTIONS), which never carries an Authorization header by
 * design. The gateway 401s the preflight itself, the browser reports it as
 * a CORS failure, and this function never even sees the request. So the
 * auth check moves down into `isAuthorized` below instead, which only runs
 * for the real POST (OPTIONS is answered before it's reached). No secrets
 * to configure — SUPABASE_URL and SUPABASE_ANON_KEY are injected already.
 */

import { createClient } from 'npm:@supabase/supabase-js@2'

const corsHeaders = {
  'Access-Control-Allow-Origin': '*',
  'Access-Control-Allow-Headers': 'authorization, x-client-info, apikey, content-type',
  'Access-Control-Allow-Methods': 'POST, OPTIONS',
}

function json(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { ...corsHeaders, 'Content-Type': 'application/json' },
  })
}

/** Only a signed-in pensar user's own session may make this function fetch a URL. */
async function isAuthorized(request: Request): Promise<boolean> {
  const token = (request.headers.get('Authorization') ?? '').replace(/^Bearer\s+/i, '')
  if (!token) return false

  const supabase = createClient(
    Deno.env.get('SUPABASE_URL') ?? '',
    Deno.env.get('SUPABASE_ANON_KEY') ?? '',
  )
  const { data, error } = await supabase.auth.getUser(token)
  return !error && Boolean(data.user)
}

/** Blocks the obvious SSRF targets — loopback, link-local (cloud metadata), and private ranges. */
function isPrivateHost(hostname: string): boolean {
  const host = hostname.toLowerCase()
  if (host === 'localhost' || host.endsWith('.localhost') || host === '0.0.0.0') return true

  const ipv4 = host.match(/^(\d{1,3})\.(\d{1,3})\.(\d{1,3})\.(\d{1,3})$/)
  if (ipv4) {
    const [a, b] = [Number(ipv4[1]), Number(ipv4[2])]
    if (a === 127 || a === 10 || a === 0) return true
    if (a === 169 && b === 254) return true
    if (a === 172 && b >= 16 && b <= 31) return true
    if (a === 192 && b === 168) return true
    return false
  }

  if (host === '::1' || host.startsWith('fe80:') || host.startsWith('fc') || host.startsWith('fd')) return true
  return false
}

const ENTITIES: Record<string, string> = {
  amp: '&',
  lt: '<',
  gt: '>',
  quot: '"',
  apos: "'",
  '#39': "'",
  '#x27': "'",
}

function decodeEntities(value: string): string {
  return value.replace(/&(#?\w+);/g, (match, name) => ENTITIES[name] ?? match)
}

function metaContent(html: string, keys: string[]): string | null {
  for (const key of keys) {
    const patterns = [
      new RegExp(`<meta[^>]+(?:property|name)=["']${key}["'][^>]*content=["']([^"']*)["']`, 'i'),
      new RegExp(`<meta[^>]+content=["']([^"']*)["'][^>]*(?:property|name)=["']${key}["']`, 'i'),
    ]
    for (const pattern of patterns) {
      const match = html.match(pattern)
      if (match) return decodeEntities(match[1]).trim()
    }
  }
  return null
}

function pageTitle(html: string): string | null {
  const match = html.match(/<title[^>]*>([^<]*)<\/title>/i)
  return match ? decodeEntities(match[1]).trim() : null
}

/** Reads up to `limit` bytes of a response body as text — og tags live in <head>, no need for the rest. */
async function readCapped(response: Response, limit: number): Promise<string> {
  const reader = response.body?.getReader()
  if (!reader) return ''

  const decoder = new TextDecoder()
  let text = ''
  let read = 0

  while (read < limit) {
    const { done, value } = await reader.read()
    if (done) break
    read += value.byteLength
    text += decoder.decode(value, { stream: true })
  }
  await reader.cancel().catch(() => {})
  return text
}

async function handlePreview(request: Request): Promise<Response> {
  let body: { url?: string }
  try {
    body = await request.json()
  } catch {
    return json({ error: 'invalid body' }, 400)
  }

  const rawUrl = body.url?.trim()
  if (!rawUrl) return json({ error: 'missing url' }, 400)

  let target: URL
  try {
    target = new URL(rawUrl)
  } catch {
    return json({ error: 'invalid url' }, 400)
  }

  if (target.protocol !== 'http:' && target.protocol !== 'https:') {
    return json({ error: 'unsupported protocol' }, 400)
  }
  if (isPrivateHost(target.hostname)) {
    return json({ error: 'unsupported host' }, 400)
  }

  const controller = new AbortController()
  const timeout = setTimeout(() => controller.abort(), 6000)

  try {
    const response = await fetch(target, {
      signal: controller.signal,
      redirect: 'follow',
      headers: {
        'User-Agent': 'Mozilla/5.0 (compatible; PensarLinkPreview/1.0; +https://github.com)',
        Accept: 'text/html',
      },
    })

    if (!response.ok) return json({ url: rawUrl, title: null, description: null, image: null })

    const html = await readCapped(response, 300_000)

    const title = metaContent(html, ['og:title', 'twitter:title']) ?? pageTitle(html)
    const description = metaContent(html, ['og:description', 'twitter:description', 'description'])
    let image = metaContent(html, ['og:image', 'og:image:url', 'twitter:image'])
    if (image) {
      try {
        image = new URL(image, response.url).href
      } catch {
        image = null
      }
    }

    return json({ url: rawUrl, title, description, image })
  } catch {
    return json({ url: rawUrl, title: null, description: null, image: null })
  } finally {
    clearTimeout(timeout)
  }
}

Deno.serve(async (request) => {
  if (request.method === 'OPTIONS') return new Response(null, { headers: corsHeaders })
  if (request.method !== 'POST') return json({ error: 'method not allowed' }, 405)
  if (!(await isAuthorized(request))) return json({ error: 'unauthorized' }, 401)
  return handlePreview(request)
})
