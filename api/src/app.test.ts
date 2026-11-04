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
    FEISHU_DOMAIN: 'feishu',
  },
}))
vi.mock('./db', () => ({ prisma: {}, secretBox: {}, initDb: async () => {} }))
vi.mock('./session', () => ({ loadActiveSession: vi.fn(), touchSession: vi.fn(), createSession: vi.fn(), destroySession: vi.fn() }))
vi.mock('./feishu', () => ({ feishu: {}, feishuDocs: {}, requestedScopesStr: '' }))
vi.mock('./feishu-token', () => ({ getFreshUserAccessToken: vi.fn(), FeishuTokenError: class extends Error {} }))
vi.mock('./services/feishu-chat-bridge', () => ({ runFeishuChatBridge: vi.fn(), analyzePendingImages: vi.fn() }))

import { buildApp } from './app'
import { loadActiveSession, touchSession } from './session'

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
    expect(r.json()).toEqual({ name: '我的站点', provider: 'feishu' })
    await app.close()
  })
})

describe('CSRF guard on state-changing requests', () => {
  const logout = (app: Awaited<ReturnType<typeof buildApp>>, remoteAddress: string, headers: Record<string, string>) =>
    app.inject({ method: 'POST', url: '/api/logout', remoteAddress, headers })

  it('经受信任的反向代理同源调用放行，跨站 Origin 拒绝', async () => {
    const app = await buildApp()
    const proxied = { 'x-forwarded-host': 'sso.example.com', 'x-forwarded-proto': 'https' }
    expect((await logout(app, '127.0.0.1', { ...proxied, origin: 'https://sso.example.com' })).statusCode).toBe(204)
    const r = await logout(app, '127.0.0.1', { ...proxied, origin: 'https://evil.example.org' })
    expect(r.statusCode).toBe(403)
    expect(r.json()).toMatchObject({ error: 'csrf' })
    await app.close()
  })

  it('不受信任的客户端自带 X-Forwarded-Host 不能把任意 Origin 伪装成同源', async () => {
    const app = await buildApp()
    const r = await logout(app, '203.0.113.5', {
      host: 'sso.example.com',
      'x-forwarded-host': 'evil.example.org',
      'x-forwarded-proto': 'https',
      origin: 'https://evil.example.org',
    })
    expect(r.statusCode).toBe(403)
    await app.close()
  })
})

describe('POST /api/session/touch', () => {
  it('只给有效会话续期；无效会话不会被 touch 复活', async () => {
    const app = await buildApp()
    vi.mocked(loadActiveSession).mockResolvedValueOnce(null)
    const dead = await app.inject({ method: 'POST', url: '/api/session/touch', cookies: { sso_session: 'expired' } })
    expect(dead.statusCode).toBe(204)
    expect(touchSession).not.toHaveBeenCalled()

    vi.mocked(loadActiveSession).mockResolvedValueOnce({
      session: { remember_me: true },
      user: {},
    } as unknown as Awaited<ReturnType<typeof loadActiveSession>>)
    const live = await app.inject({ method: 'POST', url: '/api/session/touch', cookies: { sso_session: 'alive' } })
    expect(live.statusCode).toBe(204)
    expect(touchSession).toHaveBeenCalledWith('alive')
    expect(live.headers['set-cookie']).toContain('sso_session=alive')
    await app.close()
  })
})
