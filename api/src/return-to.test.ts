import { describe, expect, it, vi } from 'vitest'

vi.mock('./env', () => ({ env: { ALLOWED_RETURN_TO: [/^https:\/\/app\.example\.com\//] } }))

import { safeReturnTo } from './return-to'

describe('safeReturnTo (open-redirect guard)', () => {
  it('falls back to the login landing when missing or malformed', () => {
    expect(safeReturnTo(undefined)).toBe('/auth/')
    expect(safeReturnTo('not a url')).toBe('/auth/')
  })

  it('accepts same-origin absolute paths', () => {
    expect(safeReturnTo('/app/list?x=1')).toBe('/app/list?x=1')
  })

  it('rejects protocol-relative and backslash tricks', () => {
    expect(safeReturnTo('//evil.example.org/')).toBe('/auth/')
    expect(safeReturnTo('/\\evil.example.org/')).toBe('/auth/')
  })

  it('accepts cross-origin URLs only when whitelisted', () => {
    expect(safeReturnTo('https://app.example.com/home')).toBe('https://app.example.com/home')
    expect(safeReturnTo('https://evil.example.org/')).toBe('/auth/')
    expect(safeReturnTo('https://app.example.com.evil.example.org/')).toBe('/auth/')
  })
})
