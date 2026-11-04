import { describe, expect, it } from 'vitest'

import { DEV_INTERNAL_TOKEN, checkInternalToken, parseTrustProxy } from './env-checks'

describe('checkInternalToken', () => {
  it('refuses the placeholder in production', () => {
    expect(checkInternalToken({ NODE_ENV: 'production', HOST: '127.0.0.1', INTERNAL_API_TOKEN: DEV_INTERNAL_TOKEN }).fatal).toBeTruthy()
  })
  it('refuses the placeholder on a non-loopback HOST even when NODE_ENV is development', () => {
    expect(checkInternalToken({ NODE_ENV: 'development', HOST: '0.0.0.0', INTERNAL_API_TOKEN: DEV_INTERNAL_TOKEN }).fatal).toBeTruthy()
  })
  it('only warns about the placeholder on loopback development', () => {
    const r = checkInternalToken({ NODE_ENV: 'development', HOST: '127.0.0.1', INTERNAL_API_TOKEN: DEV_INTERNAL_TOKEN })
    expect(r.fatal).toBeUndefined()
    expect(r.warn).toBeTruthy()
  })
  it('treats an empty token as "internal APIs off" with a warning, not a crash', () => {
    const r = checkInternalToken({ NODE_ENV: 'production', HOST: '127.0.0.1', INTERNAL_API_TOKEN: '' })
    expect(r.fatal).toBeUndefined()
    expect(r.warn).toBeTruthy()
  })
  it('accepts a real secret', () => {
    expect(checkInternalToken({ NODE_ENV: 'production', HOST: '0.0.0.0', INTERNAL_API_TOKEN: 'x'.repeat(32) })).toEqual({})
  })
})

describe('parseTrustProxy', () => {
  it('maps booleans, passes keywords and lists through', () => {
    expect(parseTrustProxy('true')).toBe(true)
    expect(parseTrustProxy('false')).toBe(false)
    expect(parseTrustProxy('loopback')).toBe('loopback')
    expect(parseTrustProxy('10.0.0.0/8,127.0.0.1')).toBe('10.0.0.0/8,127.0.0.1')
    expect(parseTrustProxy('')).toBe('loopback')
  })

  it('rejects hop counts that Fastify 5.12 would silently ignore', () => {
    expect(() => parseTrustProxy('1')).toThrow(/hop count is not supported/)
    expect(() => parseTrustProxy('2')).toThrow(/TRUST_PROXY=2/)
  })
})
