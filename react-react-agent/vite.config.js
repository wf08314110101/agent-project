import { defineConfig } from 'vite'
import react from '@vitejs/plugin-react'

// Vite 开发代理：浏览器 fetch 到 /api 会转发到目标地址，绕开 CORS
export default defineConfig({
  plugins: [react()],
  server: {
    proxy: {
      '/api': {
        target: 'https://api.deepseek.com', // 换你用的 provider
        changeOrigin: true,
        rewrite: (p) => p.replace(/^\/api/, ''),
      },
    },
  },
})