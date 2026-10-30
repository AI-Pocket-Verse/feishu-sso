import { describe, it, expect, vi } from 'vitest'

// Mock the auth-internal IO modules so importing feishu-token.ts does NOT pull
// in ./env (which validates real env + process.exit on miss).
const { findUnique } = vi.hoisted(() => ({ findUnique: vi.fn() }))
vi.mock('./db', () => ({
  prisma: { user: { findUnique } },
  secretBox: { encrypt: (s: string) => s, decrypt: (s: string) => s },
}))
vi.mock('./feishu', () => ({ feishu: { refreshUserToken: vi.fn() } }))

import { needsRefresh, getFreshUserAccessToken } from './feishu-token'

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
