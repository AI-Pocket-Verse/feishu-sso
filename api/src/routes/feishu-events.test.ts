import { describe, it, expect, vi, beforeEach } from 'vitest'
import Fastify from 'fastify'

// vi.hoisted so the mock factory (hoisted above these statements) can see the spy.
const { bridge, analyzeSpy } = vi.hoisted(() => ({
  bridge: vi.fn(async () => {}),
  analyzeSpy: vi.fn(async () => true),
}))
// Plaintext mode (no encrypt key / verification token) so we exercise the parse
// + dedupe + dispatch path without crypto. The bridge is mocked — we only assert
// the route acks and dispatches.
vi.mock('../env', () => ({
  env: { FEISHU_EVENT_ENCRYPT_KEY: '', FEISHU_EVENT_VERIFICATION_TOKEN: '', INTERNAL_API_TOKEN: 't', BOT_BACKEND_URL: 'http://x' },
}))
vi.mock('../services/feishu-chat-bridge', () => ({ runFeishuChatBridge: bridge, analyzePendingImages: analyzeSpy }))
// Bot identity: pretend the bot's open_id is ou_bot; keep isBotMentioned real.
vi.mock('../services/feishu-bot-identity', () => ({
  getCachedBotOpenId: vi.fn(async () => 'ou_bot'),
  isBotMentioned: (mentions: Array<{ id?: { open_id?: string } }> | undefined, botOpenId: string) =>
    !!botOpenId && !!mentions?.some((m) => m.id?.open_id === botOpenId),
}))

import { env } from '../env'
import { feishuEventsRoutes } from './feishu-events'
import { addPendingImages, pendingKey, clearAllPendingImages } from '../services/feishu-image-buffer'

async function build() {
  const app = Fastify()
  await app.register(feishuEventsRoutes)
  return app
}

function p2pText(eventId: string, text: string) {
  return {
    schema: '2.0',
    header: { event_id: eventId, event_type: 'im.message.receive_v1', token: '' },
    event: {
      sender: { sender_id: { open_id: 'ou_1' } },
      message: { chat_type: 'p2p', message_type: 'text', chat_id: 'oc_1', content: JSON.stringify({ text }) },
    },
  }
}

function groupText(eventId: string, text: string, mentions: Array<{ id: { open_id: string } }>) {
  return {
    schema: '2.0',
    header: { event_id: eventId, event_type: 'im.message.receive_v1', token: '' },
    event: {
      sender: { sender_id: { open_id: 'ou_1' } },
      message: { chat_type: 'group', message_type: 'text', chat_id: 'oc_g', content: JSON.stringify({ text }), mentions },
    },
  }
}

describe('POST /api/feishu/events', () => {
  beforeEach(() => bridge.mockClear())

  it('answers the url_verification challenge', async () => {
    const app = await build()
    const r = await app.inject({
      method: 'POST', url: '/api/feishu/events',
      payload: { type: 'url_verification', challenge: 'abc', token: '' },
    })
    expect(r.statusCode).toBe(200)
    expect(r.json()).toEqual({ challenge: 'abc' })
    await app.close()
  })

  it('acks and dispatches a p2p text message exactly once (dedupe on event_id)', async () => {
    const app = await build()
    const payload = p2pText('evt-dedupe-1', '在吗')

    const r1 = await app.inject({ method: 'POST', url: '/api/feishu/events', payload })
    expect(r1.statusCode).toBe(200)
    const r2 = await app.inject({ method: 'POST', url: '/api/feishu/events', payload }) // Feishu retry
    expect(r2.statusCode).toBe(200)

    await new Promise((res) => setImmediate(res)) // let the dispatched setImmediate run
    expect(bridge).toHaveBeenCalledTimes(1)
    expect(bridge).toHaveBeenCalledWith({ chatId: 'oc_1', openId: 'ou_1', text: '在吗', scope: 'p2p', images: [] })
    await app.close()
  })

  it('dispatches a group message only when the bot is @-mentioned, stripping @ placeholders', async () => {
    const app = await build()
    // @机器人 + 文本:剥掉 @_user_1 占位符后应是「总结一下」。
    const mentioned = groupText('evt-grp-1', '@_user_1 总结一下', [{ id: { open_id: 'ou_bot' } }])
    const r = await app.inject({ method: 'POST', url: '/api/feishu/events', payload: mentioned })
    expect(r.statusCode).toBe(200)
    await new Promise((res) => setImmediate(res))
    expect(bridge).toHaveBeenCalledWith({ chatId: 'oc_g', openId: 'ou_1', text: '总结一下', scope: 'group', images: [] })
    await app.close()
  })

  it('ignores a group message that does NOT @-mention the bot', async () => {
    const app = await build()
    const other = groupText('evt-grp-2', '@_user_1 你好', [{ id: { open_id: 'ou_someone_else' } }])
    const r = await app.inject({ method: 'POST', url: '/api/feishu/events', payload: other })
    expect(r.statusCode).toBe(200)
    await new Promise((res) => setImmediate(res))
    expect(bridge).not.toHaveBeenCalled()
    await app.close()
  })

  it('ignores media messages with no usable content(图片消息但缺 image_key)', async () => {
    const app = await build()
    const payload = {
      header: { event_id: 'evt-img-empty-1', event_type: 'im.message.receive_v1', token: '' },
      event: { sender: { sender_id: { open_id: 'ou_1' } }, message: { chat_type: 'p2p', message_type: 'image', chat_id: 'oc_1', content: '{}' } },
    }
    const r = await app.inject({ method: 'POST', url: '/api/feishu/events', payload })
    expect(r.statusCode).toBe(200)
    await new Promise((res) => setImmediate(res))
    expect(bridge).not.toHaveBeenCalled()
    await app.close()
  })
})

describe('POST /api/feishu/events — 图片/富文本消息', () => {
  beforeEach(() => bridge.mockClear())

  it('p2p 纯图片消息 → 携带 messageId+imageKey 派发(text 为空)', async () => {
    const app = await build()
    const payload = {
      schema: '2.0',
      header: { event_id: 'evt-img-real-1', event_type: 'im.message.receive_v1', token: '' },
      event: {
        sender: { sender_id: { open_id: 'ou_1' } },
        message: {
          message_id: 'om_img1', chat_type: 'p2p', message_type: 'image', chat_id: 'oc_1',
          content: JSON.stringify({ image_key: 'img_k1' }),
        },
      },
    }
    const r = await app.inject({ method: 'POST', url: '/api/feishu/events', payload })
    expect(r.statusCode).toBe(200)
    await new Promise((res) => setImmediate(res))
    expect(bridge).toHaveBeenCalledWith({
      chatId: 'oc_1', openId: 'ou_1', text: '', scope: 'p2p',
      images: [{ messageId: 'om_img1', imageKey: 'img_k1' }],
    })
    await app.close()
  })

  it('群聊富文本(post)@机器人 + 图文 → 派发 text+images;未 @ 不派发', async () => {
    const app = await build()
    const postContent = JSON.stringify({
      title: '',
      content: [
        [{ tag: 'at', user_id: 'ou_bot' }, { tag: 'text', text: '看下这张图' }],
        [{ tag: 'img', image_key: 'img_k2' }],
      ],
    })
    const mk = (eventId: string, mentions: Array<{ id: { open_id: string } }>) => ({
      schema: '2.0',
      header: { event_id: eventId, event_type: 'im.message.receive_v1', token: '' },
      event: {
        sender: { sender_id: { open_id: 'ou_1' } },
        message: {
          message_id: 'om_post1', chat_type: 'group', message_type: 'post', chat_id: 'oc_g',
          content: postContent, mentions,
        },
      },
    })
    // @ 了机器人 → 派发
    await app.inject({ method: 'POST', url: '/api/feishu/events', payload: mk('evt-post-1', [{ id: { open_id: 'ou_bot' } }]) })
    await new Promise((res) => setImmediate(res))
    expect(bridge).toHaveBeenCalledWith({
      chatId: 'oc_g', openId: 'ou_1', text: '看下这张图', scope: 'group',
      images: [{ messageId: 'om_post1', imageKey: 'img_k2' }],
    })
    // 没 @ 机器人 → 不派发
    bridge.mockClear()
    await app.inject({ method: 'POST', url: '/api/feishu/events', payload: mk('evt-post-2', [{ id: { open_id: 'ou_someone' } }]) })
    await new Promise((res) => setImmediate(res))
    expect(bridge).not.toHaveBeenCalled()
    await app.close()
  })
})

describe('POST /api/feishu/events — card.action.trigger(纯图片提示卡片按钮)', () => {
  beforeEach(() => {
    analyzeSpy.mockClear()
    clearAllPendingImages()
  })

  function cardAction(eventId: string, op: string, chatId = 'oc_1', openId = 'ou_1') {
    return {
      schema: '2.0',
      header: { event_id: eventId, event_type: 'card.action.trigger', token: '' },
      event: {
        operator: { open_id: openId },
        action: { tag: 'button', value: { k: 'img_prompt', op } },
        context: { open_message_id: 'om_card', open_chat_id: chatId },
      },
    }
  }

  it('「分析图片」且缓冲存在 → toast 开始分析 + 派发 analyzePendingImages', async () => {
    const app = await build()
    addPendingImages(pendingKey('oc_1', 'ou_1'), ['/uploads/a.png'], 'p2p', Date.now())
    const r = await app.inject({ method: 'POST', url: '/api/feishu/events', payload: cardAction('evt-card-1', 'analyze') })
    expect(r.statusCode).toBe(200)
    expect(r.json()).toMatchObject({ toast: { type: 'info' } })
    await new Promise((res) => setImmediate(res))
    expect(analyzeSpy).toHaveBeenCalledWith({ chatId: 'oc_1', openId: 'ou_1' })
    await app.close()
  })

  it('「分析图片」但缓冲为空(过期/已消费)→ toast 提示重发,不派发', async () => {
    const app = await build()
    const r = await app.inject({ method: 'POST', url: '/api/feishu/events', payload: cardAction('evt-card-2', 'analyze') })
    expect(r.statusCode).toBe(200)
    expect((r.json() as { toast: { type: string; content: string } }).toast.content).toContain('已过期')
    await new Promise((res) => setImmediate(res))
    expect(analyzeSpy).not.toHaveBeenCalled()
    await app.close()
  })

  it('「继续上传图片」/「输入文字」→ 各自的引导 toast,不派发分析', async () => {
    const app = await build()
    const r1 = await app.inject({ method: 'POST', url: '/api/feishu/events', payload: cardAction('evt-card-3', 'more') })
    expect((r1.json() as { toast: { content: string } }).toast.content).toContain('继续发送图片')
    const r2 = await app.inject({ method: 'POST', url: '/api/feishu/events', payload: cardAction('evt-card-4', 'text') })
    expect((r2.json() as { toast: { content: string } }).toast.content).toContain('请输入文字')
    await new Promise((res) => setImmediate(res))
    expect(analyzeSpy).not.toHaveBeenCalled()
    await app.close()
  })
})

describe('POST /api/feishu/events — 文档体检勾选器回调(card.action.trigger)', () => {
  function checkerAction(eventId: string, checked: boolean, h = 'abc123', openId = 'ou_9') {
    return {
      schema: '2.0',
      header: { event_id: eventId, event_type: 'card.action.trigger', token: '' },
      event: {
        operator: { open_id: openId },
        action: { tag: 'checker', checked, value: { k: 'doc_audit_ack', h } },
        context: { open_message_id: 'om_x', open_chat_id: 'oc_1' },
      },
    }
  }

  // 回传 {} 时(无 card)handler 不会动态 import('../feishu'),便于纯单测转发逻辑。
  function stubFetch() {
    const calls: Array<{ url: string; body: unknown }> = []
    vi.stubGlobal('fetch', vi.fn(async (url: string, init: { body: string }) => {
      calls.push({ url, body: JSON.parse(init.body) })
      return { json: async () => ({}) }
    }))
    return calls
  }

  it('勾选 → 3s 内即回 toast 已确认;转发 checked:true(hash/operatorOpenId)异步进行', async () => {
    const app = await build()
    const calls = stubFetch()
    const r = await app.inject({ method: 'POST', url: '/api/feishu/events', payload: checkerAction('evt-ack-1', true) })
    expect(r.statusCode).toBe(200)
    expect((r.json() as { toast: { content: string } }).toast.content).toContain('已确认')
    // 转发在 setImmediate 里(回调不阻塞在内网往返上),等一拍再断言。
    await new Promise((res) => setImmediate(res))
    expect(calls).toHaveLength(1)
    expect(calls[0]?.url).toContain('/api/internal/doc-audit/acknowledge')
    expect(calls[0]?.body).toMatchObject({ hash: 'abc123', operatorOpenId: 'ou_9', checked: true })
    vi.unstubAllGlobals()
    await app.close()
  })

  it('取消勾选 → 即回 toast 已撤销确认;异步转发 checked:false', async () => {
    const app = await build()
    const calls = stubFetch()
    const r = await app.inject({ method: 'POST', url: '/api/feishu/events', payload: checkerAction('evt-ack-2', false) })
    expect(r.statusCode).toBe(200)
    expect((r.json() as { toast: { content: string } }).toast.content).toContain('撤销')
    await new Promise((res) => setImmediate(res))
    expect(calls[0]?.body).toMatchObject({ checked: false })
    vi.unstubAllGlobals()
    await app.close()
  })
})

describe('POST /api/feishu/events — 群聊智能答疑(非@转发 + 👎反馈)', () => {
  beforeEach(() => bridge.mockClear())
  function groupMsg(eventId: string, text: string, opts?: { openId?: string; mentions?: Array<{ id: { open_id: string } }> }) {
    return {
      schema: '2.0',
      header: { event_id: eventId, event_type: 'im.message.receive_v1', token: '' },
      event: {
        sender: { sender_id: { open_id: opts?.openId ?? 'ou_1' } },
        message: { chat_type: 'group', message_type: 'text', chat_id: 'oc_g', message_id: 'om_g1', content: JSON.stringify({ text }), mentions: opts?.mentions ?? [] },
      },
    }
  }
  function stubFetch() {
    const calls: Array<{ url: string; body: unknown }> = []
    vi.stubGlobal('fetch', vi.fn(async (url: string, init: { body: string }) => {
      calls.push({ url, body: JSON.parse(init.body) })
      return { ok: true, json: async () => ({}) }
    }))
    return calls
  }

  it('非 @ 文本群消息 → 转发到 group-observe,不走聊天桥', async () => {
    const app = await build()
    const calls = stubFetch()
    const r = await app.inject({ method: 'POST', url: '/api/feishu/events', payload: groupMsg('evt-go-1', '报销怎么走?') })
    expect(r.statusCode).toBe(200)
    await new Promise((res) => setImmediate(res))
    expect(bridge).not.toHaveBeenCalled()
    expect(calls).toHaveLength(1)
    expect(calls[0]?.url).toContain('/api/internal/feishu/group-observe')
    expect(calls[0]?.body).toMatchObject({ chatId: 'oc_g', messageId: 'om_g1', openId: 'ou_1', text: '报销怎么走?' })
    vi.unstubAllGlobals()
    await app.close()
  })

  it('未配置 BOT_BACKEND_URL → 非 @ 群消息与卡片反馈都不转发,反馈仍即回 toast', async () => {
    const saved = env.BOT_BACKEND_URL
    ;(env as { BOT_BACKEND_URL?: string }).BOT_BACKEND_URL = undefined
    const app = await build()
    const calls = stubFetch()
    try {
      await app.inject({ method: 'POST', url: '/api/feishu/events', payload: groupMsg('evt-off-1', '报销怎么走?') })
      const r = await app.inject({
        method: 'POST',
        url: '/api/feishu/events',
        payload: {
          schema: '2.0',
          header: { event_id: 'evt-off-2', event_type: 'card.action.trigger', token: '' },
          event: { operator: { open_id: 'ou_9' }, action: { tag: 'button', value: { k: 'group_qa_up', h: 'abc12' } }, context: { open_chat_id: 'oc_g' } },
        },
      })
      expect((r.json() as { toast: { content: string } }).toast.content).toContain('谢谢')
      await new Promise((res) => setImmediate(res))
      expect(calls).toHaveLength(0)
    } finally {
      ;(env as { BOT_BACKEND_URL?: string }).BOT_BACKEND_URL = saved
      vi.unstubAllGlobals()
      await app.close()
    }
  })

  it('机器人自己发的群消息 → 不转发', async () => {
    const app = await build()
    const calls = stubFetch()
    await app.inject({ method: 'POST', url: '/api/feishu/events', payload: groupMsg('evt-go-2', '我是机器人', { openId: 'ou_bot' }) })
    await new Promise((res) => setImmediate(res))
    expect(calls).toHaveLength(0)
    vi.unstubAllGlobals()
    await app.close()
  })

  it('@ 机器人的群消息仍走聊天桥(不转发答疑)', async () => {
    const app = await build()
    const calls = stubFetch()
    await app.inject({ method: 'POST', url: '/api/feishu/events', payload: groupMsg('evt-go-3', '在吗', { mentions: [{ id: { open_id: 'ou_bot' } }] }) })
    await new Promise((res) => setImmediate(res))
    expect(bridge).toHaveBeenCalled()
    expect(calls).toHaveLength(0)
    vi.unstubAllGlobals()
    await app.close()
  })

  it('👎 没帮助 → toast + 转发 feedback(helpful:false)', async () => {
    const app = await build()
    const calls = stubFetch()
    const payload = {
      schema: '2.0',
      header: { event_id: 'evt-down-1', event_type: 'card.action.trigger', token: '' },
      event: { operator: { open_id: 'ou_9' }, action: { tag: 'button', value: { k: 'group_qa_down', h: 'abc12' } }, context: { open_message_id: 'om_x', open_chat_id: 'oc_g' } },
    }
    const r = await app.inject({ method: 'POST', url: '/api/feishu/events', payload })
    expect(r.statusCode).toBe(200)
    expect((r.json() as { toast: { content: string } }).toast.content).toContain('已记下')
    await new Promise((res) => setImmediate(res))
    expect(calls[0]?.url).toContain('/api/internal/group-qa/feedback')
    expect(calls[0]?.body).toMatchObject({ hash: 'abc12', helpful: false })
    vi.unstubAllGlobals()
    await app.close()
  })

  it('👍 有帮助 → toast 谢谢 + 转发 feedback(helpful:true)', async () => {
    const app = await build()
    const calls = stubFetch()
    const payload = {
      schema: '2.0',
      header: { event_id: 'evt-up-1', event_type: 'card.action.trigger', token: '' },
      event: { operator: { open_id: 'ou_9' }, action: { tag: 'button', value: { k: 'group_qa_up', h: 'abc12' } }, context: { open_message_id: 'om_x', open_chat_id: 'oc_g' } },
    }
    const r = await app.inject({ method: 'POST', url: '/api/feishu/events', payload })
    expect(r.statusCode).toBe(200)
    expect((r.json() as { toast: { content: string } }).toast.content).toContain('谢谢')
    await new Promise((res) => setImmediate(res))
    expect(calls[0]?.body).toMatchObject({ hash: 'abc12', helpful: true })
    vi.unstubAllGlobals()
    await app.close()
  })
})
