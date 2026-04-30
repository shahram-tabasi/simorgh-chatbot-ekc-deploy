import { defineConfig } from 'vite'
import react from '@vitejs/plugin-react'

// The app is served under /simorgh-draft/ behind two layers of nginx
// (host nginx → docker nginx → container). Vite needs `base` set so the
// generated HTML references assets at /simorgh-draft/assets/... instead
// of /assets/... — otherwise the browser asks the wrong nginx vhost for
// them and gets the landing page HTML back as "JS", failing to boot.
//
// Override at build time with VITE_BASE_PATH if mounting elsewhere.
export default defineConfig({
  plugins: [react()],
  base: process.env.VITE_BASE_PATH || '/simorgh-draft/',
})
