import { defineConfig } from 'vite'

export default defineConfig({
  base: '/pensar/',
  server: {
    host: true, // so a phone on the same wifi can open the dev server
    // Google OAuth via Supabase can only ever validate a *hostname* redirect,
    // never a raw LAN IP (Supabase's Auth server hard-rejects any redirect_to
    // whose host parses as an IP address, unless it's loopback — see CLAUDE.md).
    // Bonjour/mDNS gives this Mac a stable "<name>.local" hostname for free;
    // Vite's own DNS-rebinding guard needs it allow-listed here too.
    allowedHosts: ['.local', 'dev.bitochess.com'],
  },
})
