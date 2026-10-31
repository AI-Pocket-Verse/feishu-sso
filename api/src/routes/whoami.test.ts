import { describe, it, expect, vi, beforeEach } from 'vitest'
import Fastify from 'fastify'
import cookie from '@fastify/cookie'

// Mock env + session so the route registers without real env / DB.
vi.mock('../env', () => ({
  env: {
    SESSION_COOKIE_NAME: 'sso_session',
    SESSION_COOKIE_SECURE: false,
    SESSION_COOKIE_SAMESITE: 'lax',
    SESSION_COOKIE_DOMAIN: '',
    SESSION_TTL_DAYS: 30,
    SESSION_REMEMBER_TTL_DAYS: 30,
  },
}))
vi.mock('../session', () => ({
  loadActiveSession: vi.fn(),
  touchSession: vi.fn(async () => {}),
}))

import { whoamiRoutes } from './whoami'
import { loadActiveSession, touchSession } from '../session'

const mockLoad = vi.mocked(loadActiveSession)
const mockTouch = vi.mocked(touchSession)

async function build() {
  const app = Fastify()
  await app.register(cookie)
  await app.register(whoamiRoutes)
  return app
}

const USER = {
  id: 'u1', open_id: 'ou_1', union_id: null, name: '张三', en_name: null, email: null,
  mobile: null, avatar_url: null, avatar_thumb: null, tenant_key: null, last_login_at: new Date(),
}
function session(lastSeenMsAgo: number) {
  return {
    id: 's1', user_id: 'u1', remember_me: true,
    expires_at: new Date(Date.now() + 30 * 86_400_000),
    last_seen_at: new Date(Date.now() - lastSeenMsAgo),
  }
}
const HOUR = 60 * 60 * 1000

function setCookieHeader(r: { headers: Record<string, unknown> }) {
  const sc = r.headers['set-cookie']
  return Array.isArray(sc) ? sc.join('\n') : String(sc ?? '')
}

describe('GET /api/whoami', () => {
  beforeEach(() => { mockLoad.mockReset(); mockTouch.mockReset() })

  it('authenticated:false when no session cookie is present', async () => {
    const app = await build()
    const r = await app.inject({ url: '/api/whoami' })
    expect(r.json()).toEqual({ authenticated: false })
    await app.close()
  })

  it('authenticated:false when the session is invalid (and sets no cookie)', async () => {
    mockLoad.mockResolvedValue(null)
    const app = await build()
    const r = await app.inject({ url: '/api/whoami', headers: { cookie: 'sso_session=sid' } })
    expect(r.json()).toEqual({ authenticated: false })
    expect(r.headers['set-cookie']).toBeUndefined()
    await app.close()
  })

  it('slides the session + re-issues the cookie when last_seen is older than the throttle', async () => {
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    mockLoad.mockResolvedValue({ session: session(2 * HOUR), user: USER } as any)
    const app = await build()
    const r = await app.inject({ url: '/api/whoami', headers: { cookie: 'sso_session=sid' } })

    const body = r.json() as { authenticated: boolean; user: { id: string }; session: { id: string } }
    expect(body.authenticated).toBe(true)
    expect(body.user.id).toBe('u1')
    // session.id 不能是 cookie 值（httpOnly 凭据），只给不可逆的展示标识。
    expect(body.session.id).not.toBe('s1')
    expect(body.session.id).toMatch(/^[0-9a-f]{16}$/)
    // Slide happened: touchSession called AND the cookie re-issued with a fresh max-age.
    expect(mockTouch).toHaveBeenCalledWith('sid')
    const header = setCookieHeader(r)
    expect(header).toContain('sso_session=sid')
    expect(header).toMatch(/Max-Age=\d+/i)
    await app.close()
  })

  it('throttles: a recently-seen session is NOT re-slid and sets no cookie', async () => {
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    mockLoad.mockResolvedValue({ session: session(5 * 60 * 1000), user: USER } as any) // seen 5 min ago
    const app = await build()
    const r = await app.inject({ url: '/api/whoami', headers: { cookie: 'sso_session=sid' } })

    expect((r.json() as { authenticated: boolean }).authenticated).toBe(true)
    expect(mockTouch).not.toHaveBeenCalled()
    expect(r.headers['set-cookie']).toBeUndefined()
    await app.close()
  })

  it('a malformed cookie value (a=%) does not turn into a 500', async () => {
    mockLoad.mockResolvedValue(null)
    const app = await build()
    const r = await app.inject({ url: '/api/whoami', headers: { cookie: 'other=100%; sso_session=sid' } })
    expect(r.statusCode).toBe(200)
    expect(r.json()).toEqual({ authenticated: false })
    await app.close()
  })
})
