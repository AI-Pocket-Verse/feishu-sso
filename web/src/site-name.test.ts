import { describe, expect, it } from 'vitest'

import { DEFAULT_SITE_NAME, fetchSiteName } from './site-name'

const json = (body: unknown, status = 200) => async () => new Response(JSON.stringify(body), { status })

describe('fetchSiteName', () => {
  it('returns the configured name', async () => {
    expect(await fetchSiteName('https://example.com', json({ name: '我的站点' }) as typeof fetch)).toBe('我的站点')
  })
  it('falls back on HTTP errors, bad payloads and network failures', async () => {
    expect(await fetchSiteName('https://example.com', json({}, 500) as typeof fetch)).toBe(DEFAULT_SITE_NAME)
    expect(await fetchSiteName('https://example.com', json({ name: 3 }) as typeof fetch)).toBe(DEFAULT_SITE_NAME)
    const boom = (async () => { throw new TypeError('network') }) as typeof fetch
    expect(await fetchSiteName('https://example.com', boom)).toBe(DEFAULT_SITE_NAME)
  })
})
