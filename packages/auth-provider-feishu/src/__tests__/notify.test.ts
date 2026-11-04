import { describe, it, expect, vi, beforeEach } from 'vitest'

// Mock the Lark SDK so the client constructed in createFeishuDocsClient exposes
// a fake im.message.create. Bot messaging uses tenant_access_token (the SDK
// mints it from app creds), so the call must NOT pass withUserAccessToken.
const { create, patch } = vi.hoisted(() => ({ create: vi.fn(), patch: vi.fn() }))
vi.mock('@larksuiteoapi/node-sdk', () => {
  class Client {
    im = { message: { create, patch } }
  }
  return {
    Client,
    AppType: { SelfBuild: 'self' },
    Domain: { Feishu: 'feishu', Lark: 'lark' },
    withUserAccessToken: (t: string) => ({ token: t }),
  }
})

import { createFeishuDocsClient } from '../docs'

describe('sendInteractiveCard', () => {
  beforeEach(() => create.mockReset())

  it('sends an interactive card to an open_id and returns the message_id', async () => {
    create.mockResolvedValue({ code: 0, data: { message_id: 'om_x' } })
    const client = createFeishuDocsClient({ appId: 'a', appSecret: 's' })
    const id = await client.sendInteractiveCard('ou_1', { elements: [] })
    expect(id).toBe('om_x')
    expect(create).toHaveBeenCalledWith({
      params: { receive_id_type: 'open_id' },
      data: { receive_id: 'ou_1', msg_type: 'interactive', content: JSON.stringify({ elements: [] }) },
    })
  })

  it('throws when the SDK returns no message_id', async () => {
    create.mockResolvedValue({ code: 0, data: {} })
    const client = createFeishuDocsClient({ appId: 'a', appSecret: 's' })
    await expect(client.sendInteractiveCard('ou_1', {})).rejects.toThrow()
  })
})

describe('sendInteractiveCardToChat', () => {
  beforeEach(() => create.mockReset())

  it('sends to a chat_id and returns the message_id', async () => {
    create.mockResolvedValue({ code: 0, data: { message_id: 'om_c' } })
    const client = createFeishuDocsClient({ appId: 'a', appSecret: 's' })
    const id = await client.sendInteractiveCardToChat('oc_1', { elements: [] })
    expect(id).toBe('om_c')
    expect(create).toHaveBeenCalledWith({
      params: { receive_id_type: 'chat_id' },
      data: { receive_id: 'oc_1', msg_type: 'interactive', content: JSON.stringify({ elements: [] }) },
    })
  })
})

describe('updateInteractiveCard', () => {
  beforeEach(() => patch.mockReset())

  it('patches the card content by message_id', async () => {
    patch.mockResolvedValue({ code: 0 })
    const client = createFeishuDocsClient({ appId: 'a', appSecret: 's' })
    await client.updateInteractiveCard('om_1', { elements: [{ tag: 'div' }] })
    expect(patch).toHaveBeenCalledWith({
      path: { message_id: 'om_1' },
      data: { content: JSON.stringify({ elements: [{ tag: 'div' }] }) },
    })
  })
})
