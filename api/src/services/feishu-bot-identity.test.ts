import { describe, it, expect, vi, beforeEach } from 'vitest'

// The module imports '../feishu' (constructs SDK from env) at load — mock both.
vi.mock('../env', () => ({ env: {} }))
vi.mock('../feishu', () => ({ feishuDocs: { getBotOpenId: vi.fn() } }))

import { getCachedBotOpenId, isBotMentioned, __resetBotIdentityCache } from './feishu-bot-identity'

describe('isBotMentioned', () => {
  it('true only when a mention resolves to the bot open_id', () => {
    const mentions = [{ id: { open_id: 'ou_someone' } }, { id: { open_id: 'ou_bot' } }]
    expect(isBotMentioned(mentions, 'ou_bot')).toBe(true)
    expect(isBotMentioned(mentions, 'ou_other')).toBe(false)
    expect(isBotMentioned(undefined, 'ou_bot')).toBe(false)
    expect(isBotMentioned(mentions, '')).toBe(false)
  })
})

describe('getCachedBotOpenId', () => {
  beforeEach(() => __resetBotIdentityCache())

  it('loads once then serves from cache within TTL', async () => {
    const load = vi.fn(async () => 'ou_bot')
    const now = () => 1000
    expect(await getCachedBotOpenId(load, now)).toBe('ou_bot')
    expect(await getCachedBotOpenId(load, now)).toBe('ou_bot')
    expect(load).toHaveBeenCalledTimes(1)
  })

  it('reloads after the cache is reset', async () => {
    const load = vi.fn(async () => 'ou_bot')
    await getCachedBotOpenId(load, () => 1000)
    __resetBotIdentityCache()
    await getCachedBotOpenId(load, () => 1000)
    expect(load).toHaveBeenCalledTimes(2)
  })
})
