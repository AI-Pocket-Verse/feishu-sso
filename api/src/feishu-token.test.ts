import { describe, it, expect, vi } from 'vitest'

// Mock the auth-internal IO modules so importing feishu-token.ts does NOT pull
// in ./env (which validates real env + process.exit on miss).
const { findUnique, update, refreshUserToken } = vi.hoisted(() => ({
  findUnique: vi.fn(),
  update: vi.fn(async () => ({})),
  refreshUserToken: vi.fn(),
}))
vi.mock('./db', () => ({
  prisma: { user: { findUnique, update } },
  secretBox: { encrypt: (s: string) => s, decrypt: (s: string) => s },
}))
vi.mock('./feishu', () => ({ feishu: { refreshUserToken } }))

import { needsRefresh, getFreshUserAccessToken, isTransientRefreshError, FeishuTokenError } from './feishu-token'

describe('needsRefresh', () => {
  const now = new Date('2026-06-05T00:00:00Z')

  it('true when the token expires within the 60s buffer', () => {
    expect(needsRefresh(new Date('2026-06-05T00:00:30Z'), now)).toBe(true)
  })

  it('true when the token is already expired', () => {
    expect(needsRefresh(new Date('2026-06-04T23:59:00Z'), now)).toBe(true)
  })

  it('false when the token is comfortably valid', () => {
    expect(needsRefresh(new Date('2026-06-05T01:00:00Z'), now)).toBe(false)
  })
})

describe('getFreshUserAccessToken — single-flight', () => {
  it('shares one in-flight load for concurrent calls for the same user', async () => {
    findUnique.mockReset()
    findUnique.mockResolvedValue({
      id: 'u1',
      disabled: false,
      needs_relogin: false,
      // Comfortably valid → no refresh, just decrypt-and-return.
      user_token_expires_at: new Date(Date.now() + 3_600_000),
      user_access_token: 'tok',
    })
    const [a, b] = await Promise.all([getFreshUserAccessToken('u1'), getFreshUserAccessToken('u1')])
    expect(a).toBe('tok')
    expect(b).toBe('tok')
    expect(findUnique).toHaveBeenCalledTimes(1) // deduped via the in-flight map
  })
})

describe('refresh failures', () => {
  const dueUser = {
    id: 'u9', disabled: false, needs_relogin: false,
    user_token_expires_at: new Date(Date.now() - 1000),
    refresh_token_expires_at: new Date(Date.now() + 86_400_000),
    refresh_token: 'rt', user_access_token: 'uat',
  }

  it('classifies network errors and 5xx as transient, others as dead token', () => {
    expect(isTransientRefreshError({ code: 'ENOTFOUND' })).toBe(true)
    expect(isTransientRefreshError({ response: { status: 503 } })).toBe(true)
    expect(isTransientRefreshError(new Error('feishu: invalid refresh token (code=20037)'))).toBe(false)
    expect(isTransientRefreshError({ response: { status: 400 } })).toBe(false)
  })

  it('a transient failure does NOT flag the user for re-login', async () => {
    update.mockClear()
    findUnique.mockResolvedValue(dueUser)
    refreshUserToken.mockRejectedValue(Object.assign(new Error('getaddrinfo'), { code: 'EAI_AGAIN' }))
    await expect(getFreshUserAccessToken('u9')).rejects.toMatchObject({ reason: 'upstream_unavailable' })
    expect(update).not.toHaveBeenCalled()
  })

  it('a definitive rejection still flags needs_relogin', async () => {
    update.mockClear()
    findUnique.mockResolvedValue(dueUser)
    refreshUserToken.mockRejectedValue(new Error('feishu: invalid refresh token (code=20037)'))
    const err = await getFreshUserAccessToken('u9').catch((e) => e)
    expect(err).toBeInstanceOf(FeishuTokenError)
    expect(err.reason).toBe('need_relogin')
    expect(update).toHaveBeenCalledWith({ where: { id: 'u9' }, data: { needs_relogin: true } })
  })
})
