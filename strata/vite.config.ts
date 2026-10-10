import { defineConfig } from 'vite'
import react from '@vitejs/plugin-react'

export default defineConfig({
  plugins: [react()],
  server: { port: 5184, strictPort: true },
  test: { include: ['tests/**/*.test.ts'], testTimeout: 60_000 },
})
