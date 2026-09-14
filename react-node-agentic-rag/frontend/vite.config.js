import { defineConfig } from 'vite'
import react from '@vitejs/plugin-react'

export default defineConfig({
  plugins: [react()],
  server: {
    port: 5174, // 避免与 python-rag 前端 5173 冲突
    proxy: { '/api': { target: 'http://localhost:8788', changeOrigin: true } },
  },
})
