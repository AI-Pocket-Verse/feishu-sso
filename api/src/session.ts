/**
 * Session lifecycle helpers — only place that touches the Session table.
 */
import type { Session } from '../generated/prisma'

import { env } from './env'
import { prisma } from './db'
import { missingScopes } from './scopes'

export async function createSession(input: {
  userId: string
  rememberMe: boolean
  ip?: string
  userAgent?: string
}): Promise<Session> {
  const ttlDays = input.rememberMe ? env.SESSION_REMEMBER_TTL_DAYS : env.SESSION_TTL_DAYS
  const expiresAt = new Date(Date.now() + ttlDays * 24 * 60 * 60 * 1000)
  return prisma.session.create({
    data: {
      user_id: input.userId,
      remember_me: input.rememberMe,
      expires_at: expiresAt,
      ip: input.ip ?? null,
      user_agent: input.userAgent ?? null,
    },
  })
}

export async function loadActiveSession(sessionId: string): Promise<{ session: Session; user: Awaited<ReturnType<typeof prisma.user.findUnique>> } | null> {
  const session = await prisma.session.findUnique({ where: { id: sessionId } })
  if (!session) return null
  if (session.expires_at.getTime() < Date.now()) {
    // Async cleanup; we don't block on it
    prisma.session.delete({ where: { id: sessionId } }).catch(() => undefined)
    return null
  }
  const user = await prisma.user.findUnique({ where: { id: session.user_id } })
  if (!user || user.disabled || user.needs_relogin) return null
  // Force re-consent when the app now requires Feishu scopes this user hasn't
  // granted (FEISHU_SCOPES grew since they last logged in). Compared against the
  // per-user snapshot of *requested* scopes (user.scopes) — see scopes.ts for why
  // requested, not granted, avoids an endless re-login loop.
  if (missingScopes(env.FEISHU_SCOPES, user.scopes).length > 0) return null
  return { session, user }
}

export async function touchSession(sessionId: string): Promise<void> {
  if (!env.SESSION_SLIDING) {
    await prisma.session.update({ where: { id: sessionId }, data: { last_seen_at: new Date() } })
    return
  }
  // Sliding (idle) window: every hit pushes expiry to now + TTL, with NO
  // absolute creation-time cap. An actively-used session therefore stays alive
  // indefinitely; only TTL days of inactivity expire it. Forced logout otherwise
  // comes solely from disabled / needs_relogin / a scope change (loadActiveSession).
  const session = await prisma.session.findUnique({ where: { id: sessionId } })
  if (!session) return
  const ttlMs = (session.remember_me ? env.SESSION_REMEMBER_TTL_DAYS : env.SESSION_TTL_DAYS) * 24 * 60 * 60 * 1000
  const now = Date.now()
  await prisma.session.update({
    where: { id: sessionId },
    data: {
      last_seen_at: new Date(now),
      expires_at: new Date(now + ttlMs),
    },
  })
}

export async function destroySession(sessionId: string): Promise<void> {
  await prisma.session.delete({ where: { id: sessionId } }).catch(() => undefined)
}
