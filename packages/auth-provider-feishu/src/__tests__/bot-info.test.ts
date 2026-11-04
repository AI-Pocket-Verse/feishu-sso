import { describe, it, expect, vi, beforeEach } from 'vitest'

// Mock the Lark SDK so the client exposes a fake `request`. /bot/v3/info is
// called with tenant token (no withUserAccessToken).
const { request } = vi.hoisted(() => ({ request: vi.fn() }))
vi.mock('@larksuiteoapi/node-sdk', () => {
  class Client {
    request = request
    im = { message: { create: vi.fn(), patch: vi.fn() } }
  }
  return {
    Client,
    AppType: { SelfBuild: 'self' },
    Domain: { Feishu: 'feishu', Lark: 'lark' },
    withUserAccessToken: (t: string) => ({ token: t }),
  }
})

import { createFeishuDocsClient } from '../docs'

describe('getBotOpenId', () => {
  beforeEach(() => request.mockReset())

  it('returns the bot open_id from /bot/v3/info', async () => {
    request.mockResolvedValue({ code: 0, msg: 'ok', bot: { open_id: 'ou_bot123' } })
    const client = createFeishuDocsClient({ appId: 'a', appSecret: 's' })
    const id = await client.getBotOpenId()
    expect(id).toBe('ou_bot123')
    expect(request).toHaveBeenCalledWith({ method: 'GET', url: '/open-apis/bot/v3/info' })
  })

  it('throws when the response carries no open_id', async () => {
    request.mockResolvedValue({ code: 0, msg: 'ok', bot: {} })
    const client = createFeishuDocsClient({ appId: 'a', appSecret: 's' })
    await expect(client.getBotOpenId()).rejects.toThrow()
  })
})
