#!/usr/bin/env node
//
// Generates the one VAPID key pair reminder push notifications sign with.
// Run once (or again if the keys are ever lost — see the reminders
// migration's trailing comment for what that costs).
//
// Writes `vapid-keys.local` at the repo root: a JWK pair, in the exact shape
// `@negrel/webpush`'s `importVapidKeys` wants (the library the Edge Function
// uses — see supabase/functions/pensar-send-reminder/index.ts). That file is
// never committed (`.local` is in .gitignore); its contents become the
// PENSAR_VAPID_KEYS secret on the deployed function.
//
// Also prints the public key in the *raw uncompressed-point* base64url shape
// `pushManager.subscribe()` wants for `applicationServerKey` — paste that
// into `.env` as VITE_VAPID_PUBLIC_KEY. It's meant to be public; only the
// private half in vapid-keys.local is a secret.
//
// Built on Node's own Web Crypto (`crypto.webcrypto`) rather than a new
// dependency — VAPID is just an ECDSA P-256 key pair, and generating one is
// a few lines against an API Node already ships.

const { webcrypto } = require('node:crypto')
const fs = require('node:fs')
const path = require('node:path')

function base64url(buffer) {
  return Buffer.from(buffer).toString('base64').replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '')
}

async function main() {
  const pair = await webcrypto.subtle.generateKey({ name: 'ECDSA', namedCurve: 'P-256' }, true, [
    'sign',
    'verify',
  ])

  const publicKey = await webcrypto.subtle.exportKey('jwk', pair.publicKey)
  const privateKey = await webcrypto.subtle.exportKey('jwk', pair.privateKey)

  const outFile = path.join(__dirname, '..', 'vapid-keys.local')
  fs.writeFileSync(outFile, JSON.stringify({ publicKey, privateKey }, null, 2) + '\n')

  // The raw uncompressed EC point (0x04 || x || y) is the format
  // applicationServerKey needs, derived from the same JWK's coordinates.
  const rawPoint = Buffer.concat([
    Buffer.from([0x04]),
    Buffer.from(publicKey.x, 'base64url'),
    Buffer.from(publicKey.y, 'base64url'),
  ])

  console.log(`Wrote ${outFile}`)
  console.log('')
  console.log('Public key (VITE_VAPID_PUBLIC_KEY in .env):')
  console.log(base64url(rawPoint))
}

main()
