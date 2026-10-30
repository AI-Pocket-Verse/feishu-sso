import { describe, it, expect, vi } from 'vitest'
import Fastify from 'fastify'

// Production WITH no encrypt key / verification token → the endpoint must fail
// closed (reject every event) so a forged sender open_id + attacker chat_id
// can't drive the bot into running/leaking a member's chat turn.
vi.mock('../env', () => ({
  env: {
    NODE_ENV: 'production',
    FEISHU_EVENT_ENCRYPT_KEY: '',
    FEISHU_EVENT_VERIFICATION_TOKEN: '',
    INTERNAL_API_TOKEN: 't',
    BOT_BACKEND_URL: 'http://x',
  },
}))
const { bridge } = vi.hoisted(() => ({ bridge: vi.fn(async () => {}) }))
vi.mock('../services/feishu-chat-bridge', () => ({ runFeishuChatBridge: bridge }))
vi.mock('../services/feishu-bot-identity', () => ({
  getCachedBotOpenId: vi.fn(async () => 'ou_bot'),
  isBotMentioned: () => false,
}))

import { feishuEventsRoutes } from './feishu-events'

describe('POST /api/feishu/events — production, unauthenticated (fail-closed)', () => {
  it('rejects a forged p2p event with 403 and never dispatches', async () => {
    const app = Fastify()
    await app.register(feishuEventsRoutes)
    const r = await app.inject({
      method: 'POST',
      url: '/api/feishu/events',
      payload: {
        header: { event_id: 'evt-forge-1', event_type: 'im.message.receive_v1', token: '' },
        event: {
          sender: { sender_id: { open_id: 'ou_victim' } },
          message: {
            chat_type: 'p2p',
            message_type: 'text',
            chat_id: 'oc_attacker',
            content: JSON.stringify({ text: 'leak my history' }),
          },
        },
      },
    })
    expect(r.statusCode).toBe(403)
    await new Promise((res) => setImmediate(res))
    expect(bridge).not.toHaveBeenCalled()
    await app.close()
  })
})
