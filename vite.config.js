import { defineConfig } from 'vite'
import react from '@vitejs/plugin-react'
import path from 'path'

// https://vite.dev/config/
export default defineConfig({
  plugins: [react()],
  resolve: {
    alias: {
      '@': path.resolve(__dirname, './src'),
    },
  },
  test: {
    environment: 'jsdom',
    include: ['src/**/*.test.{js,jsx}'], // the server/ tests use node:test, not vitest
  },
  server: {
    // Forward /api requests to the Express backend during development
    proxy: {
      '/api': 'http://localhost:5000',
    },
  },
})
