import { describe, it, expect, vi, beforeEach } from 'vitest'

// Mock IO + env so importing session.ts pulls neither the real DB nor ./env
// (which validates real env + process.exit on miss). missingScopes is pure and
// left un-mocked so the scope gate is exercised for real.
const { sessionFindUnique, sessionUpdate, sessionDelete, userFindUnique } = vi.hoisted(() => ({
  sessionFindUnique: vi.fn(),
  sessionUpdate: vi.fn(),
  sessionDelete: vi.fn(),
  userFindUnique: vi.fn(),
}))
vi.mock('./db', () => ({
  prisma: {
    session: { findUnique: sessionFindUnique, update: sessionUpdate, delete: sessionDelete },
    user: { findUnique: userFindUnique },
  },
}))
vi.mock('./env', () => ({
  env: {
    SESSION_SLIDING: true,
    SESSION_TTL_DAYS: 30,
    SESSION_REMEMBER_TTL_DAYS: 30,
    FEISHU_SCOPES: 'a b c',
  },
}))

import { loadActiveSession, touchSession } from './session'

const DAY = 24 * 60 * 60 * 1000

describe('loadActiveSession', () => {
  beforeEach(() => {
    sessionFindUnique.mockReset()
    sessionUpdate.mockReset()
    sessionDelete.mockReset()
    userFindUnique.mockReset()
  })

  it('returns null + deletes the row when the session has expired', async () => {
    sessionFindUnique.mockResolvedValue({ id: 's1', user_id: 'u1', expires_at: new Date(Date.now() - 1000) })
    sessionDelete.mockResolvedValue({})
    expect(await loadActiveSession('s1')).toBeNull()
    expect(sessionDelete).toHaveBeenCalledWith({ where: { id: 's1' } })
  })

  it('returns null for a disabled or needs_relogin user', async () => {
    sessionFindUnique.mockResolvedValue({ id: 's1', user_id: 'u1', expires_at: new Date(Date.now() + DAY) })
    userFindUnique.mockResolvedValue({ id: 'u1', disabled: true, needs_relogin: false, scopes: 'a b c' })
    expect(await loadActiveSession('s1')).toBeNull()
  })

  it('returns null when the app requires a scope the user has not granted (scope changed)', async () => {
    sessionFindUnique.mockResolvedValue({ id: 's1', user_id: 'u1', expires_at: new Date(Date.now() + DAY) })
    userFindUnique.mockResolvedValue({ id: 'u1', disabled: false, needs_relogin: false, scopes: 'a b' }) // missing "c"
    expect(await loadActiveSession('s1')).toBeNull()
  })

  it('returns session+user when active and the granted scopes cover what is required', async () => {
    const session = { id: 's1', user_id: 'u1', expires_at: new Date(Date.now() + DAY) }
    const user = { id: 'u1', disabled: false, needs_relogin: false, scopes: 'a b c d' } // superset is fine
    sessionFindUnique.mockResolvedValue(session)
    userFindUnique.mockResolvedValue(user)
    expect(await loadActiveSession('s1')).toEqual({ session, user })
  })
})

describe('touchSession — sliding window with no creation-time cap', () => {
  beforeEach(() => {
    sessionFindUnique.mockReset()
    sessionUpdate.mockReset()
  })

  it('extends expiry to now + TTL even for a session created long ago', async () => {
    const created = new Date(Date.now() - 100 * DAY) // would be long-dead under the old absolute cap
    sessionFindUnique.mockResolvedValue({ id: 's1', remember_me: true, created_at: created })
    sessionUpdate.mockResolvedValue({})

    const before = Date.now()
    await touchSession('s1')

    const arg = sessionUpdate.mock.calls[0]![0] as { data: { expires_at: Date } }
    const next = arg.data.expires_at.getTime()
    // ~now + 30d, NOT pinned to created_at + 30d (which is ~70 days in the past).
    expect(next).toBeGreaterThan(before + 29 * DAY)
    expect(next).toBeLessThan(before + 31 * DAY)
  })
})
