import { describe, expect, it, vi } from 'vitest'

vi.mock('./env', () => ({
  env: {
    NODE_ENV: 'test',
    TRUST_PROXY: 'loopback',
    CORS_ORIGINS: '',
    SITE_NAME: '我的站点',
    SESSION_COOKIE_NAME: 'sso_session',
    SESSION_COOKIE_SECURE: false,
    SESSION_COOKIE_SAMESITE: 'lax',
    SESSION_COOKIE_DOMAIN: '',
    SESSION_TTL_DAYS: 30,
    SESSION_REMEMBER_TTL_DAYS: 30,
    INTERNAL_API_TOKEN: 'x'.repeat(32),
    FEISHU_EVENT_ENCRYPT_KEY: '',
    FEISHU_EVENT_VERIFICATION_TOKEN: '',
    ALLOWED_RETURN_TO: [],
  },
}))
vi.mock('./db', () => ({ prisma: {}, secretBox: {}, initDb: async () => {} }))
vi.mock('./session', () => ({ loadActiveSession: vi.fn(), touchSession: vi.fn(), createSession: vi.fn(), destroySession: vi.fn() }))
vi.mock('./feishu', () => ({ feishu: {}, feishuDocs: {}, requestedScopesStr: '' }))
vi.mock('./feishu-token', () => ({ getFreshUserAccessToken: vi.fn(), FeishuTokenError: class extends Error {} }))
vi.mock('./services/feishu-chat-bridge', () => ({ runFeishuChatBridge: vi.fn(), analyzePendingImages: vi.fn(), BACKEND_OFF_TEXT: '' }))

import { buildApp } from './app'

describe('buildApp rate limiting behind a reverse proxy', () => {
  it('buckets by the real client IP: one noisy client cannot lock out the others', async () => {
    const app = await buildApp()
    // nginx 在本机，所有请求的 socket 地址都是 127.0.0.1，真实客户端在 X-Forwarded-For 里。
    const call = (xff: string) =>
      app.inject({ url: '/healthz', remoteAddress: '127.0.0.1', headers: { 'x-forwarded-for': xff } })
    const codes: number[] = []
    for (let i = 0; i < 230; i++) codes.push((await call('198.51.100.7')).statusCode)
    expect(codes.filter((c) => c === 429).length).toBeGreaterThan(0)
    // 另一位用户不受影响
    expect((await call('203.0.113.9')).statusCode).toBe(200)
    await app.close()
  })

  it('exposes the configured site name for the login page', async () => {
    const app = await buildApp()
    const r = await app.inject({ url: '/api/site' })
    expect(r.json()).toEqual({ name: '我的站点' })
    await app.close()
  })
})
