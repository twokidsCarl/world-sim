import { defineConfig } from 'vite'
import react from '@vitejs/plugin-react'

export default defineConfig({
  plugins: [react()],
  server: { port: 5186, strictPort: true, proxy: { '/api': 'http://127.0.0.1:8766' } },
  test: { include: ['tests/**/*.test.ts'] },
})
