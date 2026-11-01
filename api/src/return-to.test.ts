import { describe, expect, it, vi } from 'vitest'

vi.mock('./env', () => ({ env: { ALLOWED_RETURN_TO: [/^https:\/\/app\.example\.com\//] } }))

import { safeReturnTo } from './return-to'

const ORIGIN = 'https://sso.example.com'

describe('safeReturnTo (open-redirect guard)', () => {
  it('falls back to the login landing when missing or malformed', () => {
    expect(safeReturnTo(undefined)).toBe('/auth/')
    expect(safeReturnTo('not a url')).toBe('/auth/')
  })

  it('accepts same-origin absolute paths', () => {
    expect(safeReturnTo('/app/list?x=1')).toBe('/app/list?x=1')
    expect(safeReturnTo('/app/#top')).toBe('/app/#top')
  })

  // 原样放进 Location 头会让 reply.redirect 抛 ERR_INVALID_CHAR，登录成功后看到 500。
  it('percent-encodes non-ASCII paths so the redirect header stays valid', () => {
    expect(safeReturnTo('/kb/中文?q=é')).toBe('/kb/%E4%B8%AD%E6%96%87?q=%C3%A9')
  })

  it('rejects protocol-relative and backslash tricks', () => {
    expect(safeReturnTo('//evil.example.org/')).toBe('/auth/')
    expect(safeReturnTo('/\\evil.example.org/')).toBe('/auth/')
  })

  it('rejects control characters browsers strip (tab / newline bypass)', () => {
    expect(safeReturnTo('/\t/evil.example.org')).toBe('/auth/')
    expect(safeReturnTo('/\n/evil.example.org')).toBe('/auth/')
    expect(safeReturnTo('/\r/evil.example.org')).toBe('/auth/')
    expect(safeReturnTo('/\t\t/evil.example.org')).toBe('/auth/')
    expect(safeReturnTo('/ /evil.example.org')).toBe('/auth/')
    expect(safeReturnTo('/a\u0000b')).toBe('/auth/')
    expect(safeReturnTo('/a\\b')).toBe('/auth/')
  })

  it('accepts cross-origin URLs only when whitelisted', () => {
    expect(safeReturnTo('https://app.example.com/home')).toBe('https://app.example.com/home')
    expect(safeReturnTo('https://evil.example.org/')).toBe('/auth/')
  })

  it('does not let userinfo or look-alike hosts through the whitelist', () => {
    expect(safeReturnTo('https://app.example.com@evil.example.org/')).toBe('/auth/')
    expect(safeReturnTo('https://app.example.com.evil.example.org/')).toBe('/auth/')
  })

  it('rejects non-http(s) schemes', () => {
    expect(safeReturnTo('javascript:alert(1)')).toBe('/auth/')
    expect(safeReturnTo('data:text/html,hi')).toBe('/auth/')
  })

  describe('absolute URLs on the request origin', () => {
    it('accepts them without any whitelist entry', () => {
      expect(safeReturnTo('https://sso.example.com/kb/doc?id=1#x', ORIGIN)).toBe('https://sso.example.com/kb/doc?id=1#x')
    })

    it('rejects a different scheme, host or port', () => {
      expect(safeReturnTo('http://sso.example.com/kb', ORIGIN)).toBe('/auth/')
      expect(safeReturnTo('https://other.example.com/kb', ORIGIN)).toBe('/auth/')
      expect(safeReturnTo('https://sso.example.com:8443/kb', ORIGIN)).toBe('/auth/')
    })

    it('rejects userinfo and tab tricks that parse to another host', () => {
      expect(safeReturnTo('https://sso.example.com@evil.example.org/', ORIGIN)).toBe('/auth/')
      expect(safeReturnTo('https://sso.example.com\t.evil.example.org/', ORIGIN)).toBe('/auth/')
      expect(safeReturnTo('https:\\\\evil.example.org/', ORIGIN)).toBe('/auth/')
    })

    it('does nothing special when the request origin is unknown', () => {
      expect(safeReturnTo('https://sso.example.com/kb')).toBe('/auth/')
    })
  })
})
