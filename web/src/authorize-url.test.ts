import { describe, expect, it } from 'vitest'

import { buildAuthorizeUrl, isLarkWebview } from './authorize-url'

describe('buildAuthorizeUrl', () => {
  it('points at the api authorize endpoint and passes return_to through', () => {
    const u = new URL(buildAuthorizeUrl('https://example.com', 'https://example.com/app/?x=1#top'))
    expect(u.origin + u.pathname).toBe('https://example.com/auth/api/feishu/authorize')
    expect(u.searchParams.get('return_to')).toBe('https://example.com/app/?x=1#top')
    expect(u.searchParams.get('remember_me')).toBe('1')
  })

  it('resolves from the origin, not the current path', () => {
    expect(buildAuthorizeUrl('http://localhost:5020', '/')).toBe(
      'http://localhost:5020/auth/api/feishu/authorize?return_to=%2F&remember_me=1',
    )
  })
})

describe('isLarkWebview', () => {
  it('detects the Feishu / Lark in-app browser', () => {
    expect(isLarkWebview('Mozilla/5.0 (iPhone) AppleWebKit Lark/7.1.0 LarkLocale/zh_CN')).toBe(true)
    expect(isLarkWebview('Mozilla/5.0 Feishu/7.0')).toBe(true)
    expect(isLarkWebview('Mozilla/5.0 (Macintosh) Chrome/130.0')).toBe(false)
  })
})
