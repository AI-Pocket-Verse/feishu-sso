import { createHash } from 'node:crypto'

import type { FastifyPluginAsync } from 'fastify'

import type { Session as SessionDTO, User as UserDTO, WhoamiResponse } from '@feishu-sso/auth-core'

import { setSessionCookie } from '../cookies'
import { env } from '../env'
import { loadActiveSession, touchSession } from '../session'

// whoami is the hot path — hit by the browser AND server-to-server on ~every API
// request across products (behind a 5s cache). Sliding the session on every hit
// would be a write-per-request hotspot, so we re-slide at most once per window.
// The TTL is in days, so an hourly slide never risks premature expiry.
const SLIDE_THROTTLE_MS = 60 * 60 * 1000 // 1h

// Coerce empty strings to null for rows written before the provider learned to
// normalize. Without this, downstream zod schemas would reject the payload.
const s = (v: string | null | undefined): string | null => {
  if (typeof v !== 'string') return null
  return v.trim() === '' ? null : v
}

function toUserDTO(u: {
  id: string
  open_id: string
  union_id: string | null
  name: string
  en_name: string | null
  email: string | null
  mobile: string | null
  avatar_url: string | null
  avatar_thumb: string | null
  tenant_key: string | null
  last_login_at: Date
}): UserDTO {
  return {
    id: u.id,
    open_id: u.open_id,
    union_id: s(u.union_id),
    name: u.name,
    en_name: s(u.en_name),
    email: s(u.email),
    mobile: s(u.mobile),
    avatar_url: s(u.avatar_url),
    avatar_thumb: s(u.avatar_thumb),
    tenant_key: s(u.tenant_key),
    last_login_at: u.last_login_at.toISOString(),
  }
}

function toSessionDTO(s: {
  id: string
  user_id: string
  remember_me: boolean
  expires_at: Date
  last_seen_at: Date
}): SessionDTO {
  return {
    // 真实 session id 就是 httpOnly cookie 的值，不能交给脚本；这里给不可逆的展示用标识。
    id: createHash('sha256').update(s.id).digest('hex').slice(0, 16),
    user_id: s.user_id,
    remember_me: s.remember_me,
    expires_at: s.expires_at.toISOString(),
    last_seen_at: s.last_seen_at.toISOString(),
  }
}

export const whoamiRoutes: FastifyPluginAsync = async (app) => {
  app.get('/api/whoami', async (req, reply) => {
    // Response carries per-session PII (open_id / email / mobile). Never let a
    // shared/intermediary cache retain it.
    reply.header('Cache-Control', 'no-store')
    const sid = req.cookies?.[env.SESSION_COOKIE_NAME]
    if (!sid) return { authenticated: false } satisfies WhoamiResponse
    const loaded = await loadActiveSession(sid)
    if (!loaded || !loaded.user) return { authenticated: false } satisfies WhoamiResponse
    // Slide the session (server expiry + browser cookie) — throttled. Both move
    // in lock-step: the cookie is only re-issued AFTER touchSession() commits the
    // new expires_at, so the browser cookie can never outlive the server session.
    // touchSession extends Session.expires_at; the cookie's max-age is fixed at
    // issue time, so it must be re-set here to keep sliding. (Server-to-server
    // whoami calls ignore the Set-Cookie; only the browser's direct whoami uses it.)
    if (Date.now() - loaded.session.last_seen_at.getTime() > SLIDE_THROTTLE_MS) {
      try {
        await touchSession(sid)
        setSessionCookie(reply, sid, loaded.session.remember_me)
      } catch (err) {
        app.log.warn({ err }, 'touchSession failed')
      }
    }
    return {
      authenticated: true,
      user: toUserDTO(loaded.user),
      session: toSessionDTO(loaded.session),
    } satisfies WhoamiResponse
  })
}
