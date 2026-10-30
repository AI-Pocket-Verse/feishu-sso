import react from '@vitejs/plugin-react'
import { defineConfig } from 'vitest/config'

// 登录页固定挂在 /auth/ 下：接入方按 `${VITE_SSO_BASE}/login` 跳转过来，
// 浏览器请求的接口也都在 /auth/api/* 下。
export default defineConfig({
  base: '/auth/',
  plugins: [react()],
  server: {
    port: 5020,
    proxy: {
      // 本地开发时模拟生产的反向代理：/auth/api/* → api 的 /api/*
      '/auth/api': {
        target: 'http://localhost:4020',
        rewrite: (path) => path.replace(/^\/auth/, ''),
      },
    },
  },
  test: {
    environment: 'node',
  },
})
