import cookie from '@fastify/cookie'
import Fastify from 'fastify'
import { describe, expect, it, vi } from 'vitest'

vi.mock('../env', () => ({
  env: {
    SESSION_COOKIE_NAME: 'sso_session',
    SESSION_COOKIE_SECURE: false,
    SESSION_COOKIE_SAMESITE: 'lax',
    SESSION_COOKIE_DOMAIN: '',
    SESSION_TTL_DAYS: 30,
    SESSION_REMEMBER_TTL_DAYS: 30,
    STATE_TTL_SECONDS: 300,
    ALLOWED_RETURN_TO: [],
  },
}))
const upsert = vi.fn(async (_args: unknown) => ({ id: 'u1' }))
vi.mock('../db', () => ({
  prisma: { user: { upsert: (a: unknown) => upsert(a) } },
  secretBox: { encrypt: (s: string) => `enc:${s}` },
}))
vi.mock('../feishu', () => ({
  requestedScopesStr: 'contact:user.base:readonly',
  feishu: {
    getAuthorizeUrl: (state: string) => `https://passport.example.com/authorize?state=${state}`,
    exchangeCode: vi.fn(async () => ({
      tokens: {
        user_access_token: 'uat',
        user_access_token_expires_at: new Date(),
        refresh_token: 'rt',
        refresh_token_expires_at: new Date(),
      },
      user: { open_id: 'ou_1', name: 'Alice', raw: {} },
    })),
  },
}))
vi.mock('../session', () => ({ createSession: vi.fn(async () => ({ id: 'sid-1' })) }))

import { feishuRoutes } from './feishu'

async function build() {
  const app = Fastify({ trustProxy: 'loopback' })
  await app.register(cookie)
  await app.register(feishuRoutes)
  return app
}

/** 走完 authorize → callback 两步，返回 callback 的响应。 */
async function login(app: Awaited<ReturnType<typeof build>>, returnTo: string) {
  const a = await app.inject({
    url: `/api/feishu/authorize?return_to=${encodeURIComponent(returnTo)}`,
    remoteAddress: '127.0.0.1',
    headers: { host: 'sso.example.com', 'x-forwarded-proto': 'https', 'x-forwarded-host': 'sso.example.com' },
  })
  const state = new URL(a.headers.location as string).searchParams.get('state')!
  const nonce = /sso_oauth_state=([^;]+)/.exec(String(a.headers['set-cookie']))![1]
  return app.inject({
    url: `/api/feishu/callback?code=c&state=${state}`,
    headers: { cookie: `sso_oauth_state=${nonce}` },
  })
}

describe('feishu login routes', () => {
  it('sends the user back to a same-origin ABSOLUTE return_to (what integrators pass)', async () => {
    const app = await build()
    const r = await login(app, 'https://sso.example.com/kb/doc?id=1')
    expect(r.statusCode).toBe(302)
    expect(r.headers.location).toBe('https://sso.example.com/kb/doc?id=1')
    await app.close()
  })

  it('falls back to /auth/ for another origin and for the tab-character bypass', async () => {
    const app = await build()
    expect((await login(app, 'https://evil.example.org/')).headers.location).toBe('/auth/')
    expect((await login(app, '/\t/evil.example.org')).headers.location).toBe('/auth/')
    await app.close()
  })

  it('does not clear users.disabled when a user logs in again', async () => {
    upsert.mockClear()
    const app = await build()
    await login(app, '/')
    const arg = upsert.mock.calls[0]![0] as { update: Record<string, unknown> }
    expect(arg.update).not.toHaveProperty('disabled')
    expect(arg.update.needs_relogin).toBe(false)
    await app.close()
  })
})
