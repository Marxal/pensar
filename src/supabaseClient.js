/*
 * The one Supabase client for the app.
 *
 * flowType: 'pkce' matters because pensar routes on the URL hash (`#/boards`,
 * `#/board/…`) — same as niu. The library's default *implicit* OAuth flow
 * sends you back from Google with the session in the hash
 * (`#access_token=…`), which collides with our own router and never gets
 * parsed into a route. PKCE comes back as `?code=…` in the query string
 * instead, which the library exchanges and strips via history.replaceState,
 * leaving the hash untouched for the router.
 *
 * storageKey: 'pensar.auth' keeps this app's session separate from niu's
 * ('niu.auth') in case they're ever open in a context that shares storage.
 */

import { createClient } from '@supabase/supabase-js'

const supabaseUrl = import.meta.env.VITE_SUPABASE_URL
const supabaseAnonKey = import.meta.env.VITE_SUPABASE_ANON_KEY

export const supabase = createClient(supabaseUrl, supabaseAnonKey, {
  auth: {
    flowType: 'pkce',
    storageKey: 'pensar.auth',
    persistSession: true,
    autoRefreshToken: true,
    detectSessionInUrl: true,
  },
})
