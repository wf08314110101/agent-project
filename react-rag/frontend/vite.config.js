// Vite 配置：本地 /api 代理到后端 FastAPI (8000)，规避 CORS 与硬编码地址
import { defineConfig } from 'vite'
import react from '@vitejs/plugin-react'

export default defineConfig({
  plugins: [react()],
  server: {
    port: 5173,
    proxy: {
      // 前端 fetch('/api/...') → http://localhost:8000/api/...
      '/api': {
        target: 'http://localhost:8000',
        changeOrigin: true,
      },
    },
  },
})