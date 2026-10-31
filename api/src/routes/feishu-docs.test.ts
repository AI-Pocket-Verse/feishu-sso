import { describe, it, expect, vi } from 'vitest'
import Fastify from 'fastify'
import cookie from '@fastify/cookie'

// Mock auth-internal deps so the route registers without real env / DB / SDK.
vi.mock('../env', () => ({ env: { SESSION_COOKIE_NAME: 'sso_session', INTERNAL_API_TOKEN: 'tkn-internal' } }))
vi.mock('../feishu-token', () => ({
  getFreshUserAccessToken: vi.fn(async () => 'uat-123'),
  FeishuTokenError: class FeishuTokenError extends Error {},
}))
vi.mock('../feishu', () => ({
  feishuDocs: {
    getDocxMeta: vi.fn(async () => ({ title: 'Hello' })),
    listDocxBlocks: vi.fn(async () => [{ block_id: 'a' }]),
    resolveWikiNode: vi.fn(async () => ({ objType: 'docx', objToken: 'doc-1' })),
    downloadMedia: vi.fn(async () => ({ bytes: Buffer.from('img'), mime: 'image/png' })),
    sendInteractiveCard: vi.fn(async () => 'om_1'),
    sendInteractiveCardToChat: vi.fn(async () => 'om_chat_1'),
    replyCard: vi.fn(async () => 'om_reply_1'),
    addReaction: vi.fn(async () => undefined),
  },
}))
// Session is valid iff a cookie/sid is present.
vi.mock('../session', () => ({
  loadActiveSession: vi.fn(async (sid: string) => (sid ? { session: {}, user: { id: 'u1' } } : null)),
}))

import { feishuDocsRoutes } from './feishu-docs'

async function build() {
  const app = Fastify()
  await app.register(cookie)
  await app.register(feishuDocsRoutes)
  return app
}

describe('feishu-docs gateway', () => {
  it('401 without a session cookie', async () => {
    const app = await build()
    const r = await app.inject({ method: 'GET', url: '/api/feishu/docx/doc-1' })
    expect(r.statusCode).toBe(401)
    await app.close()
  })

  it('returns docx meta with a valid session', async () => {
    const app = await build()
    const r = await app.inject({
      method: 'GET',
      url: '/api/feishu/docx/doc-1',
      headers: { cookie: 'sso_session=sid-1' },
    })
    expect(r.statusCode).toBe(200)
    expect(r.json()).toEqual({ title: 'Hello' })
    await app.close()
  })

  it('returns aggregated blocks', async () => {
    const app = await build()
    const r = await app.inject({
      method: 'GET',
      url: '/api/feishu/docx/doc-1/blocks',
      headers: { cookie: 'sso_session=sid-1' },
    })
    expect(r.statusCode).toBe(200)
    expect(r.json()).toEqual({ blocks: [{ block_id: 'a' }] })
    await app.close()
  })

  it('resolves a wiki node', async () => {
    const app = await build()
    const r = await app.inject({
      method: 'GET',
      url: '/api/feishu/wiki/node?token=Wik1',
      headers: { cookie: 'sso_session=sid-1' },
    })
    expect(r.statusCode).toBe(200)
    expect(r.json()).toEqual({ objType: 'docx', objToken: 'doc-1' })
    await app.close()
  })

  it('400 when wiki token is missing', async () => {
    const app = await build()
    const r = await app.inject({
      method: 'GET',
      url: '/api/feishu/wiki/node',
      headers: { cookie: 'sso_session=sid-1' },
    })
    expect(r.statusCode).toBe(400)
    await app.close()
  })
})

describe('POST /api/feishu/notify (internal)', () => {
  it('401 without the internal token', async () => {
    const app = await build()
    const r = await app.inject({
      method: 'POST', url: '/api/feishu/notify',
      payload: { openId: 'ou_1', card: { elements: [] } },
    })
    expect(r.statusCode).toBe(401)
    await app.close()
  })

  it('400 when openId is missing / not an open_id', async () => {
    const app = await build()
    const r = await app.inject({
      method: 'POST', url: '/api/feishu/notify',
      headers: { 'x-internal-token': 'tkn-internal' },
      payload: { openId: 'not-an-open-id', card: {} },
    })
    expect(r.statusCode).toBe(400)
    await app.close()
  })

  it('sends a card and returns messageId with the internal token', async () => {
    const app = await build()
    const r = await app.inject({
      method: 'POST', url: '/api/feishu/notify',
      headers: { 'x-internal-token': 'tkn-internal' },
      payload: { openId: 'ou_1', card: { elements: [] } },
    })
    expect(r.statusCode).toBe(200)
    expect(r.json()).toEqual({ messageId: 'om_1' })
    await app.close()
  })

  it('sends to a chat when chatId(oc_*) is given', async () => {
    const app = await build()
    const r = await app.inject({
      method: 'POST', url: '/api/feishu/notify',
      headers: { 'x-internal-token': 'tkn-internal' },
      payload: { chatId: 'oc_group_1', card: { elements: [] } },
    })
    expect(r.statusCode).toBe(200)
    expect(r.json()).toEqual({ messageId: 'om_chat_1' })
    await app.close()
  })

  it('400 when both openId and chatId are given', async () => {
    const app = await build()
    const r = await app.inject({
      method: 'POST', url: '/api/feishu/notify',
      headers: { 'x-internal-token': 'tkn-internal' },
      payload: { openId: 'ou_1', chatId: 'oc_1', card: { elements: [] } },
    })
    expect(r.statusCode).toBe(400)
    await app.close()
  })

  it('accepts a 2.0 card (schema + body.elements) — 文档体检勾选器清单', async () => {
    const app = await build()
    const r = await app.inject({
      method: 'POST', url: '/api/feishu/notify',
      headers: { 'x-internal-token': 'tkn-internal' },
      payload: {
        chatId: 'oc_group_1',
        card: { schema: '2.0', config: { update_multi: true }, header: { title: { tag: 'plain_text', content: 'x' } }, body: { elements: [{ tag: 'hr' }] } },
      },
    })
    expect(r.statusCode).toBe(200)
    expect(r.json()).toEqual({ messageId: 'om_chat_1' })
    await app.close()
  })

  it('400 on a malformed 2.0 card (body without an elements array)', async () => {
    const app = await build()
    const r = await app.inject({
      method: 'POST', url: '/api/feishu/notify',
      headers: { 'x-internal-token': 'tkn-internal' },
      payload: { chatId: 'oc_group_1', card: { schema: '2.0', body: {} } },
    })
    expect(r.statusCode).toBe(400)
    await app.close()
  })

  it('400 on a body-shaped card with an unknown schema (must be exactly 2.0)', async () => {
    const app = await build()
    const r = await app.inject({
      method: 'POST', url: '/api/feishu/notify',
      headers: { 'x-internal-token': 'tkn-internal' },
      payload: { chatId: 'oc_group_1', card: { schema: '9.9', header: { title: { tag: 'plain_text', content: 'x' } }, body: { elements: [] } } },
    })
    expect(r.statusCode).toBe(400)
    await app.close()
  })
})

describe('POST /api/feishu/reply (internal · 引用回复)', () => {
  it('401 without the internal token', async () => {
    const app = await build()
    const r = await app.inject({
      method: 'POST', url: '/api/feishu/reply',
      payload: { messageId: 'om_x', card: { elements: [] } },
    })
    expect(r.statusCode).toBe(401)
    await app.close()
  })

  it('400 when messageId is missing / not an om_*', async () => {
    const app = await build()
    const r = await app.inject({
      method: 'POST', url: '/api/feishu/reply',
      headers: { 'x-internal-token': 'tkn-internal' },
      payload: { messageId: 'nope', card: { elements: [] } },
    })
    expect(r.statusCode).toBe(400)
    await app.close()
  })

  it('replies (quotes the original) and returns the new messageId', async () => {
    const app = await build()
    const r = await app.inject({
      method: 'POST', url: '/api/feishu/reply',
      headers: { 'x-internal-token': 'tkn-internal' },
      payload: { messageId: 'om_orig', card: { elements: [{ tag: 'div', text: { tag: 'lark_md', content: 'hi' } }] } },
    })
    expect(r.statusCode).toBe(200)
    expect(r.json()).toEqual({ messageId: 'om_reply_1' })
    await app.close()
  })
})

describe('POST /api/feishu/reaction (internal · 点赞)', () => {
  it('401 without the internal token', async () => {
    const app = await build()
    const r = await app.inject({
      method: 'POST', url: '/api/feishu/reaction',
      payload: { messageId: 'om_x', emojiType: 'THUMBSUP' },
    })
    expect(r.statusCode).toBe(401)
    await app.close()
  })

  it('400 when messageId is missing / not an om_*', async () => {
    const app = await build()
    const r = await app.inject({
      method: 'POST', url: '/api/feishu/reaction',
      headers: { 'x-internal-token': 'tkn-internal' },
      payload: { messageId: 'nope', emojiType: 'THUMBSUP' },
    })
    expect(r.statusCode).toBe(400)
    await app.close()
  })

  it('400 when emojiType is not the A-Z_ shape', async () => {
    const app = await build()
    const r = await app.inject({
      method: 'POST', url: '/api/feishu/reaction',
      headers: { 'x-internal-token': 'tkn-internal' },
      payload: { messageId: 'om_orig', emojiType: 'bad-emoji!' },
    })
    expect(r.statusCode).toBe(400)
    await app.close()
  })

  it('adds the reaction and returns ok with the internal token', async () => {
    const app = await build()
    const r = await app.inject({
      method: 'POST', url: '/api/feishu/reaction',
      headers: { 'x-internal-token': 'tkn-internal' },
      payload: { messageId: 'om_orig', emojiType: 'THUMBSUP' },
    })
    expect(r.statusCode).toBe(200)
    expect(r.json()).toEqual({ ok: true })
    await app.close()
  })

  it('rejects path-traversal tokens before they reach the Feishu SDK', async () => {
    const app = await build()
    for (const url of [
      '/api/feishu/docx/..%2F..%2Fcontact%2Fv3%2Fusers%2Fou_x%3Fx%3D',
      '/api/feishu/media/..%2Fx',
      '/api/feishu/bitable/app1/..%2Ftbl/records',
      '/api/feishu/wiki/node?token=..%2Fx',
    ]) {
      const r = await app.inject({ method: 'GET', url, headers: { cookie: 'sso_session=sid-1' } })
      expect(r.statusCode, url).toBe(400)
      expect(r.json().error).toBe('invalid_input')
    }
    await app.close()
  })
})

describe('internal token', () => {
  it('rejects an empty x-internal-token header when the configured token is empty', async () => {
    const { env } = await import('../env')
    const saved = env.INTERNAL_API_TOKEN
    ;(env as { INTERNAL_API_TOKEN: string }).INTERNAL_API_TOKEN = ''
    try {
      const app = await build()
      const r = await app.inject({
        method: 'POST',
        url: '/api/feishu/reaction',
        headers: { 'x-internal-token': '' },
        payload: { messageId: 'om_1', emojiType: 'THUMBSUP' },
      })
      expect(r.statusCode).toBe(401)
      await app.close()
    } finally {
      ;(env as { INTERNAL_API_TOKEN: string }).INTERNAL_API_TOKEN = saved
    }
  })
})
