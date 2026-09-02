// Reminder push notifications: turning the due-date picker cards already
// have into something that reaches the phone even when pensar isn't open.
//
// Same pub/sub shape as installPrompt.js — plain module state plus listeners
// so whichever view is mounted repaints its button — but there's more state
// here than "available or not", and every transition is a network round
// trip (asking permission, subscribing, writing the row), so callers get a
// `remindersBusy()` to grey the button out mid-flight rather than risking a
// second tap racing the first.
//
// The actual delivery is server-side: `pensar_send_due_reminders()` in the
// reminders migration polls for due cards and calls the pensar-send-reminder
// Edge Function, which is what this module's subscription row exists for in
// the first place. Nothing here ever talks to a push service directly except
// to *subscribe* to it — sending is the server's job.

import { supabase } from './supabaseClient'

const VAPID_PUBLIC_KEY = import.meta.env.VITE_VAPID_PUBLIC_KEY

const listeners = new Set()

function notify() {
  for (const fn of listeners) fn()
}

/** Fires whenever remindersEnabled()/remindersPermission()/remindersBusy()
 *  might have changed. Returns an unsubscribe function. */
export function onReminderStateChange(fn) {
  listeners.add(fn)
  return () => listeners.delete(fn)
}

/** False without a VAPID key configured (reminders not set up server-side
 *  yet) or on a browser missing any of the three APIs this needs. iOS only
 *  has these in an installed, home-screen PWA — same restriction as the
 *  share target, and for the same reason: Safari's tab context doesn't get
 *  them at all. */
export function remindersSupported() {
  return Boolean(VAPID_PUBLIC_KEY) && 'serviceWorker' in navigator && 'PushManager' in window && 'Notification' in window
}

/** 'unsupported' | 'default' | 'granted' | 'denied'. */
export function remindersPermission() {
  return remindersSupported() ? Notification.permission : 'unsupported'
}

let cachedEnabled = false
let busy = false

/** Cached and synchronous, for painting a button without waiting on a
 *  service-worker round trip. Correct as of the last enableReminders(),
 *  disableReminders() or refreshReminderState(). */
export function remindersEnabled() {
  return cachedEnabled
}

export function remindersBusy() {
  return busy
}

/**
 * Re-derives whether *this device* currently holds a live subscription.
 * Worth calling once when a view that shows the button mounts: permission
 * can be revoked from the phone's own Settings without anything here
 * hearing about it in the moment.
 */
export async function refreshReminderState() {
  if (!remindersSupported() || Notification.permission !== 'granted') {
    cachedEnabled = false
    notify()
    return
  }

  try {
    const registration = await navigator.serviceWorker.ready
    cachedEnabled = Boolean(await registration.pushManager.getSubscription())
  } catch {
    cachedEnabled = false
  }
  notify()
}

/** `pushManager.subscribe()` wants the VAPID public key as bytes; it's
 *  written down everywhere (here, .env, Google's docs) as base64url. */
function decodeBase64Url(value) {
  const trimmed = value.trim()
  const padded = (trimmed + '===').slice(0, trimmed.length + ((4 - (trimmed.length % 4)) % 4))
  const base64 = padded.replace(/-/g, '+').replace(/_/g, '/')
  const binary = atob(base64)
  const bytes = new Uint8Array(binary.length)
  for (let i = 0; i < binary.length; i += 1) bytes[i] = binary.charCodeAt(i)
  return bytes
}

/** A rough label for whose row this is, so a stray subscription is
 *  recognisable later in a table view — nothing here ever reads it back. */
function deviceLabel() {
  const ua = navigator.userAgent
  if (/ipad|iphone/i.test(ua)) return 'iPhone/iPad'
  if (/android/i.test(ua)) return 'Android'
  if (/mac os/i.test(ua)) return 'Mac'
  if (/windows/i.test(ua)) return 'Windows'
  return 'Browser'
}

/**
 * Ask for notification permission, subscribe this device, and hand the
 * subscription to `pensar_push_subscriptions` — the row the Edge Function
 * reads to know where to send. A no-op, quietly, if permission is refused;
 * the caller reads that back from remindersPermission() afterwards.
 */
export async function enableReminders() {
  if (!remindersSupported() || busy) return
  busy = true
  notify()

  try {
    const permission = await Notification.requestPermission()
    if (permission !== 'granted') return

    const registration = await navigator.serviceWorker.ready
    const subscription =
      (await registration.pushManager.getSubscription()) ??
      (await registration.pushManager.subscribe({
        userVisibleOnly: true,
        applicationServerKey: decodeBase64Url(VAPID_PUBLIC_KEY),
      }))

    const { keys } = subscription.toJSON()
    const { error } = await supabase.from('pensar_push_subscriptions').upsert({
      endpoint: subscription.endpoint,
      p256dh: keys?.p256dh ?? '',
      auth: keys?.auth ?? '',
      device: deviceLabel(),
      last_seen_at: new Date().toISOString(),
    })
    if (error) throw error

    cachedEnabled = true
  } finally {
    busy = false
    notify()
  }
}

/** Drops this device's row and unsubscribes it from the push service. Other
 *  devices signed into the same account are untouched. */
export async function disableReminders() {
  if (!remindersSupported() || busy) return
  busy = true
  notify()

  try {
    const registration = await navigator.serviceWorker.ready
    const subscription = await registration.pushManager.getSubscription()
    if (subscription) {
      await supabase.from('pensar_push_subscriptions').delete().eq('endpoint', subscription.endpoint)
      await subscription.unsubscribe()
    }
    cachedEnabled = false
  } finally {
    busy = false
    notify()
  }
}
