import { describe, expect, it } from 'vitest'

import { DEFAULT_SITE_INFO, fetchSiteInfo } from './site-info'

const json = (body: unknown, status = 200) => async () => new Response(JSON.stringify(body), { status })

describe('fetchSiteInfo', () => {
  it('returns the configured name and provider', async () => {
    expect(await fetchSiteInfo('https://example.com', json({ name: '我的站点', provider: 'lark' }) as typeof fetch)).toEqual({
      name: '我的站点',
      provider: 'lark',
    })
  })
  it('未配置站点名时 name 为 null，未知 provider 按飞书处理', async () => {
    expect(await fetchSiteInfo('https://example.com', json({ name: null, provider: 'x' }) as typeof fetch)).toEqual(DEFAULT_SITE_INFO)
  })
  it('falls back on HTTP errors, bad payloads and network failures', async () => {
    expect(await fetchSiteInfo('https://example.com', json({}, 500) as typeof fetch)).toEqual(DEFAULT_SITE_INFO)
    expect(await fetchSiteInfo('https://example.com', json({ name: 3 }) as typeof fetch)).toEqual(DEFAULT_SITE_INFO)
    const boom = (async () => { throw new TypeError('network') }) as typeof fetch
    expect(await fetchSiteInfo('https://example.com', boom)).toEqual(DEFAULT_SITE_INFO)
  })
})
