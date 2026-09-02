/*
 * pensar-send-reminder — the one piece of pensar that runs on a server.
 *
 * `pensar_send_due_reminders()` (supabase/migrations/20260902140000_pensar_
 * reminders.sql) polls every five minutes for cards whose `remind_at` has
 * arrived and calls this with nothing but their ids and owning user — the
 * same "told who, never what" shape as niu's own push function
 * (niu/supabase/functions/niu-push/index.ts), and for the same reason: the
 * shared secret below should stop a forged call, but if it ever leaked, the
 * worst a stranger could do is make a phone repeat a reminder for a card
 * that's already due — not write their own words onto Marçal's lock screen.
 * Title and note both get read here, from the database, with the service
 * role, never trusted from the payload.
 *
 * ## The library
 *
 * `jsr:@negrel/webpush`, same choice as niu-push and for the same reason:
 * Deno-native, built on SubtleCrypto, no Node shims — which is what makes it
 * work inside a Supabase Edge Function at all.
 *
 * ## Deploying it
 *
 * From a real terminal (Claude Code's sandboxed shell can't reach the CLI's
 * login session — same constraint as `db push`):
 *
 *   supabase functions deploy pensar-send-reminder --no-verify-jwt
 *
 * `--no-verify-jwt` for the same reason as pensar-link-preview: the caller
 * is Postgres, which has no user session and authenticates with the shared
 * secret header instead.
 *
 * Then three secrets:
 *
 *   supabase secrets set \
 *     PENSAR_VAPID_KEYS="$(cat vapid-keys.local)" \
 *     PENSAR_PUSH_SECRET=<a long random string> \
 *     PENSAR_CONTACT_EMAIL=<an address a push service can complain to>
 *
 * `vapid-keys.local` is generated once (see the reminders migration's own
 * trailing comment) and never committed — the `.local` suffix is in
 * .gitignore for exactly that reason. Its public half is `.env`'s
 * `VITE_VAPID_PUBLIC_KEY`, which is meant to be public; the private half
 * lives only in that file and, after this step, in Supabase.
 *
 * Last, the same random string as PENSAR_PUSH_SECRET goes into
 * `pensar_push_config.shared_secret` — see the migration's trailing comment
 * for the exact insert.
 */

import * as webpush from 'jsr:@negrel/webpush@0.5.0'
import { createClient } from 'npm:@supabase/supabase-js@2'

const vapidJson = Deno.env.get('PENSAR_VAPID_KEYS') ?? ''
const sharedSecret = Deno.env.get('PENSAR_PUSH_SECRET') ?? ''
const contactEmail = Deno.env.get('PENSAR_CONTACT_EMAIL') ?? 'admin@example.com'

const supabase = createClient(
  Deno.env.get('SUPABASE_URL') ?? '',
  Deno.env.get('SUPABASE_SERVICE_ROLE_KEY') ?? '',
  { auth: { persistSession: false } },
)

/** Built once per cold start — importing the keys costs a handful of
 *  milliseconds, and there's no reason to pay it once per card. */
let appServerPromise: Promise<webpush.ApplicationServer> | null = null

function applicationServer(): Promise<webpush.ApplicationServer> {
  appServerPromise ??= (async () => {
    const vapidKeys = await webpush.importVapidKeys(JSON.parse(vapidJson), {
      extractable: false,
    })
    return await webpush.ApplicationServer.new({
      contactInformation: `mailto:${contactEmail}`,
      vapidKeys,
    })
  })()
  return appServerPromise
}

/* -------------------------------------------------------------------------- */
/* What the notification says                                                  */
/* -------------------------------------------------------------------------- */

interface CardRow {
  id: string
  title: string
  body_markdown: string
  due_date: string | null
  board_id: string | null
}

/** Markdown syntax stripped just enough for two lines on a lock screen — not
 *  the real renderer in markdown.js, which needs a DOM this function has no
 *  use for. */
function plainExcerpt(markdown: string, limit = 120): string {
  const text = markdown
    .replace(/!\[[^\]]*\]\([^)]*\)/g, '')
    .replace(/\[([^\]]*)\]\([^)]*\)/g, '$1')
    .replace(/[#*_`>~-]/g, ' ')
    .replace(/\s+/g, ' ')
    .trim()
  return text.length > limit ? `${text.slice(0, limit)}…` : text
}

function cardHeading(card: CardRow): string {
  const title = card.title.trim()
  if (title) return title
  const excerpt = plainExcerpt(card.body_markdown, 60)
  return excerpt || 'Reminder'
}

interface Message {
  title: string
  body: string
  /** Replaces an earlier notification for the same card rather than
   *  stacking a second one under it. */
  tag: string
  /** Where notificationclick sends the tap — see public/sw.js. */
  url: string
}

function buildMessage(card: CardRow): Message {
  const heading = cardHeading(card)
  const excerpt = plainExcerpt(card.body_markdown)
  const body = (card.title.trim() && excerpt) || 'Due now'

  return {
    title: heading,
    body,
    tag: `pensar-reminder-${card.id}`,
    url: card.board_id ? `#/board/${card.board_id}` : '#/',
  }
}

/* -------------------------------------------------------------------------- */
/* POST /, called by Postgres                                                  */
/* -------------------------------------------------------------------------- */

interface DueCard {
  id: string
  user_id: string
}

interface TriggerPayload {
  cards: DueCard[]
}

function ok(note: string): Response {
  return new Response(JSON.stringify({ note }), {
    status: 200,
    headers: { 'Content-Type': 'application/json' },
  })
}

async function sendToUser(
  server: webpush.ApplicationServer,
  userId: string,
  cards: CardRow[],
): Promise<{ sent: number; gone: string[] }> {
  const { data: subs } = await supabase
    .from('pensar_push_subscriptions')
    .select('endpoint, p256dh, auth')
    .eq('user_id', userId)

  if (!subs || subs.length === 0) return { sent: 0, gone: [] }

  const gone: string[] = []
  let sent = 0

  await Promise.all(
    subs.flatMap((row) =>
      cards.map(async (card) => {
        const subscriber = server.subscribe({
          endpoint: row.endpoint,
          keys: { p256dh: row.p256dh, auth: row.auth },
        })

        const message = buildMessage(card)

        try {
          // High urgency: the whole point of a reminder is that it arrives
          // promptly, not whenever the phone next wakes on its own.
          await subscriber.pushTextMessage(JSON.stringify(message), {
            urgency: webpush.Urgency.High,
          })
          sent += 1
        } catch (error) {
          // 404/410 mean the browser threw this subscription away — app
          // uninstalled, notifications revoked, data cleared. Keeping the
          // row would mean failing for it forever.
          const status = error instanceof webpush.PushMessageError ? error.response.status : 0
          if (status === 404 || status === 410) {
            gone.push(row.endpoint)
          } else {
            console.error('push failed', row.endpoint.slice(-12), String(error))
          }
        }
      }),
    ),
  )

  return { sent, gone }
}

async function handleTrigger(request: Request): Promise<Response> {
  if (sharedSecret === '' || request.headers.get('x-pensar-secret') !== sharedSecret) {
    return new Response('no', { status: 401 })
  }

  let payload: TriggerPayload
  try {
    payload = await request.json()
  } catch {
    return ok('unreadable body')
  }

  const due = payload.cards ?? []
  if (due.length === 0) return ok('nothing to send')

  const ids = [...new Set(due.map((c) => c.id))]
  const { data: cards } = await supabase
    .from('pensar_cards')
    .select('id, title, body_markdown, due_date, board_id')
    .in('id', ids)

  if (!cards || cards.length === 0) return ok('cards are gone')

  const cardsById = new Map(cards.map((c) => [c.id, c as CardRow]))
  const byUser = new Map<string, CardRow[]>()
  for (const { id, user_id: userId } of due) {
    const card = cardsById.get(id)
    if (!card) continue
    if (!byUser.has(userId)) byUser.set(userId, [])
    byUser.get(userId)!.push(card)
  }

  if (byUser.size === 0) return ok('cards are gone')

  const server = await applicationServer()
  const gone: string[] = []
  let sent = 0

  await Promise.all(
    [...byUser.entries()].map(async ([userId, userCards]) => {
      const result = await sendToUser(server, userId, userCards)
      sent += result.sent
      gone.push(...result.gone)
    }),
  )

  if (gone.length > 0) {
    await supabase.from('pensar_push_subscriptions').delete().in('endpoint', gone)
  }

  return ok(`sent ${sent}, dropped ${gone.length}`)
}

Deno.serve((request) => handleTrigger(request))
