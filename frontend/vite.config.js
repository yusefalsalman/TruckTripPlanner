import { defineConfig } from 'vite'
import react from '@vitejs/plugin-react'
import tailwindcss from '@tailwindcss/vite'

export default defineConfig({
  plugins: [react(), tailwindcss()],
  // Honour an assigned PORT (e.g. preview tooling); default to Vite's 5173.
  server: { port: Number(process.env.PORT) || 5173 },
})
