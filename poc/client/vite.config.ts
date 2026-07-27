import { defineConfig } from 'vite'
import react from '@vitejs/plugin-react'

// https://vite.dev/config/
export default defineConfig({
  plugins: [react()],
  server: {
    // Without this the auth UI cannot work under `vite dev` at all.
    //
    // /auth/me is fetched with credentials:"include". Pointed at the API's own
    // origin it is cross-origin, the server sends no CORS headers (A2a avoids
    // CORS deliberately — the deployed topology is same-origin behind Caddy),
    // so the fetch rejects, App.tsx degrades to "anonymous", and the client
    // renders the pre-auth flow while the server then refuses the join with
    // "authentication required". Proxying makes /auth/* same-origin in dev
    // exactly as it is in production: one convention, cookies included.
    //
    // Register http://localhost:5173/auth/callback as the OAuth app's callback
    // URL when developing against a real GitHub app — the browser must come
    // back through this origin for the state and session cookies to match.
    proxy: {
      '/auth': {
        target: 'http://localhost:3001',
        changeOrigin: false,
      },
    },
  },
})
