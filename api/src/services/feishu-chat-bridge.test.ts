import { describe, it, expect, vi, beforeEach } from 'vitest'

// Importing the bridge pulls in '../feishu' (which constructs the SDK from env)
// and '../env' (which validates real env + would exit). Mock both so the unit
// test loads cleanly; the test injects its own deps anyway.
vi.mock('../env', () => ({ env: { BOT_BACKEND_URL: 'http://backend.invalid', INTERNAL_API_TOKEN: 't' } }))
vi.mock('../feishu', () => ({
  feishuDocs: { sendInteractiveCardToChat: vi.fn(), updateInteractiveCard: vi.fn() },
}))

import { createServer, type Server } from 'node:http'
import type { AddressInfo } from 'node:net'

import { botText } from '../bot-i18n'
import { runFeishuChatBridge, analyzePendingImages, fetchWithHeadersTimeout, type BridgeDeps } from './feishu-chat-bridge'
import { clearAllPendingImages } from './feishu-image-buffer'

// 新增的图片中转 deps:旧用例不涉及图片,统一给个不会被调用的兜底实现。
const imageDeps = {
  downloadImage: async () => ({ bytes: Buffer.alloc(0), mime: 'image/png' }),
  storeImage: async () => '/uploads/stub.png',
}

function sseResponse(body: string): Response {
  return new Response(body)
}
function cardText(card: unknown): string {
  return (card as { elements: Array<{ text: { content: string } }> }).elements[0]?.text.content ?? ''
}

describe('runFeishuChatBridge', () => {
  it('replies "not connected" and touches nothing else when no backend is configured', async () => {
    const sent: string[] = []
    const fetchStream = vi.fn()
    const downloadImage = vi.fn()
    const deps: BridgeDeps = {
      backendConfigured: false,
      sendCard: async (_chat: string, card: unknown) => { sent.push(cardText(card)); return 'om_1' },
      updateCard: vi.fn(),
      fetchStream: fetchStream as unknown as BridgeDeps['fetchStream'],
      downloadImage: downloadImage as unknown as BridgeDeps['downloadImage'],
      storeImage: vi.fn(),
      now: () => 0,
    }

    await runFeishuChatBridge(
      { chatId: 'oc_1', openId: 'ou_1', text: 'hi', images: [{ messageId: 'om_0', imageKey: 'img_1' }] },
      deps,
    )

    expect(sent).toEqual([botText('zh', 'backendOff')])
    expect(fetchStream).not.toHaveBeenCalled()
    expect(downloadImage).not.toHaveBeenCalled()
  })

  it('lang=en 时思考卡、错误说明与未接入提示都是英文', async () => {
    const sent: string[] = []
    const updates: string[] = []
    const base = {
      sendCard: async (_chat: string, card: unknown) => { sent.push(cardText(card)); return 'om_1' },
      updateCard: async (_id: string, card: unknown) => { updates.push(cardText(card)) },
      ...imageDeps,
      now: () => 0,
      lang: 'en' as const,
      assistantName: 'Bot',
    }
    await runFeishuChatBridge({ chatId: 'oc_1', openId: 'ou_1', text: 'hi' }, {
      ...base,
      backendConfigured: false,
      fetchStream: vi.fn() as unknown as BridgeDeps['fetchStream'],
    })
    await runFeishuChatBridge({ chatId: 'oc_1', openId: 'ou_1', text: 'hi' }, {
      ...base,
      backendConfigured: true,
      fetchStream: async () => new Response('{}', { status: 503 }),
    })
    expect(sent).toEqual([botText('en', 'backendOff'), 'Bot is thinking…'])
    expect(updates.at(-1)).toBe('Bot is under maintenance. Please try again later.')
  })

  it('sends a thinking card then updates it with the streamed answer', async () => {
    const updates: string[] = []
    const sendCard = vi.fn(async () => 'om_1')
    const updateCard = vi.fn(async (_id: string, card: unknown) => { updates.push(cardText(card)) })
    let clock = 0
    const deps: BridgeDeps = {
      backendConfigured: true,
      ...imageDeps,
      sendCard,
      updateCard,
      fetchStream: async () =>
        sseResponse(
          'event: token\ndata: {"text":"你好"}\n\n' +
          'event: token\ndata: {"text":"世界"}\n\n' +
          'event: done\ndata: {"ok":true}\n\n',
        ),
      now: () => (clock += 1000), // advance > INTERVAL_MS so every token flushes
    }

    await runFeishuChatBridge({ chatId: 'oc_1', openId: 'ou_1', text: 'hi' }, deps)

    expect(sendCard).toHaveBeenCalledTimes(1)
    expect(updateCard).toHaveBeenCalled()
    expect(updates.at(-1)).toBe('你好世界')
  })

  it('shows the queued notice, then the streamed answer overwrites it', async () => {
    const updates: string[] = []
    let clock = 0
    const deps: BridgeDeps = {
      backendConfigured: true,
      ...imageDeps,
      sendCard: async () => 'om_1',
      updateCard: async (_id: string, card: unknown) => { updates.push(cardText(card)) },
      fetchStream: async () =>
        sseResponse(
          'event: queued\ndata: {"message":"上一条回答还在生成，已为你排队"}\n\n' +
          'event: token\ndata: {"text":"答案"}\n\n' +
          'event: done\ndata: {"ok":true}\n\n',
        ),
      now: () => (clock += 1000),
    }

    await runFeishuChatBridge({ chatId: 'oc_1', openId: 'ou_1', text: 'hi' }, deps)

    expect(updates[0]).toBe('上一条回答还在生成，已为你排队')
    expect(updates.at(-1)).toBe('答案')
  })

  it('renders the need_login message as the final card', async () => {
    const updates: string[] = []
    const deps: BridgeDeps = {
      backendConfigured: true,
      ...imageDeps,
      sendCard: async () => 'om_1',
      updateCard: async (_id: string, card: unknown) => { updates.push(cardText(card)) },
      fetchStream: async () =>
        sseResponse('event: need_login\ndata: {"message":"请先登录开通"}\n\nevent: done\ndata: {}\n\n'),
      now: () => 0,
    }

    await runFeishuChatBridge({ chatId: 'oc_1', openId: 'ou_x', text: 'hi' }, deps)

    expect(updates.at(-1)).toBe('请先登录开通')
  })

  it('passes the scope through to the backend (group)', async () => {
    let captured: unknown = null
    const deps: BridgeDeps = {
      backendConfigured: true,
      ...imageDeps,
      sendCard: async () => 'om_1',
      updateCard: async () => {},
      fetchStream: async (body) => { captured = body; return sseResponse('event: done\ndata: {}\n\n') },
      now: () => 0,
    }
    await runFeishuChatBridge({ chatId: 'oc_g', openId: 'ou_1', text: 'hi', scope: 'group' }, deps)
    expect(captured).toEqual({ openId: 'ou_1', text: 'hi', scope: 'group' })
  })

  it('updates the card with a friendly error if the stream fetch fails (no stuck card)', async () => {
    const updates: string[] = []
    const deps: BridgeDeps = {
      backendConfigured: true,
      ...imageDeps,
      sendCard: async () => 'om_1',
      updateCard: async (_id: string, card: unknown) => { updates.push(cardText(card)) },
      fetchStream: async () => { throw new TypeError('fetch failed: other side closed') },
      now: () => 0,
    }
    // Must NOT throw — the failure is caught and rendered on the card.
    await runFeishuChatBridge({ chatId: 'oc_1', openId: 'ou_1', text: 'hi' }, deps)
    expect(updates.at(-1)).toContain('连接 AI 失败')
  })

  it('shows a maintenance message when the backend is restoring (503, not SSE)', async () => {
    const updates: string[] = []
    const deps: BridgeDeps = {
      backendConfigured: true,
      ...imageDeps,
      sendCard: async () => 'om_1',
      updateCard: async (_id: string, card: unknown) => { updates.push(cardText(card)) },
      fetchStream: async () => new Response(JSON.stringify({ error: 'restoring' }), { status: 503 }),
      now: () => 0,
    }
    await runFeishuChatBridge({ chatId: 'oc_1', openId: 'ou_1', text: 'hi' }, deps)
    expect(updates.at(-1)).toContain('维护中')
  })

  it('shows a friendly error on a non-200 backend response (e.g. 401 token mismatch)', async () => {
    const updates: string[] = []
    const logs: Array<{ info: Record<string, unknown>; msg: string }> = []
    const deps: BridgeDeps = {
      backendConfigured: true,
      ...imageDeps,
      sendCard: async () => 'om_1',
      updateCard: async (_id: string, card: unknown) => { updates.push(cardText(card)) },
      fetchStream: async () => new Response(JSON.stringify({ error: 'unauthorized' }), { status: 401 }),
      now: () => 0,
      logError: (info, msg) => { logs.push({ info, msg }) },
    }
    await runFeishuChatBridge({ chatId: 'oc_1', openId: 'ou_1', text: 'hi' }, deps)
    // 口令不一致要有独立文案，并且写日志供运维排查。
    expect(updates.at(-1)).toContain('口令')
    expect(updates.at(-1)).toContain('bot_backend_unauthorized')
    expect(logs).toEqual([{ info: { status: 401 }, msg: 'bot backend returned non-2xx' }])
  })
})

describe('runFeishuChatBridge — 图片中转', () => {
  it('下载图片→对话后端落盘→/chat 请求体携带 images', async () => {
    const bodies: Array<{ images?: string[]; text: string }> = []
    let clock = 0
    const deps: BridgeDeps = {
      backendConfigured: true,
      sendCard: async () => 'om_1',
      updateCard: async () => {},
      downloadImage: vi.fn(async (mid: string, key: string) => {
        expect(mid).toBe('om_src'); expect(key).toBe('img_k1')
        return { bytes: Buffer.from('png-bytes'), mime: 'image/png' }
      }),
      storeImage: vi.fn(async () => '/uploads/abc.png'),
      fetchStream: async (body) => {
        bodies.push(body)
        return new Response('event: token\ndata: {"text":"图里是猫"}\n\nevent: done\ndata: {"ok":true}\n\n')
      },
      now: () => (clock += 1000),
    }
    await runFeishuChatBridge(
      { chatId: 'oc_1', openId: 'ou_1', text: '这是什么', images: [{ messageId: 'om_src', imageKey: 'img_k1' }] },
      deps,
    )
    expect(deps.downloadImage).toHaveBeenCalledTimes(1)
    expect(deps.storeImage).toHaveBeenCalledWith('ou_1', expect.any(Buffer))
    expect(bodies[0]).toMatchObject({ text: '这是什么', images: ['/uploads/abc.png'] })
  })

  it('图片全部下载失败且无文字 → 错误卡片收尾,不调 /chat、不进缓冲', async () => {
    const sent: string[] = []
    const fetchStream = vi.fn()
    const deps: BridgeDeps = {
      backendConfigured: true,
      sendCard: async (_chatId: string, card: unknown) => { sent.push(cardText(card)); return 'om_1' },
      updateCard: async () => {},
      downloadImage: async () => { throw new Error('no scope') },
      storeImage: async () => '/uploads/never.png',
      fetchStream: fetchStream as unknown as BridgeDeps['fetchStream'],
      now: () => Date.now(),
    }
    await runFeishuChatBridge(
      { chatId: 'oc_fail', openId: 'ou_1', text: '', images: [{ messageId: 'om_src', imageKey: 'img_k1' }] },
      deps,
    )
    expect(fetchStream).not.toHaveBeenCalled()
    expect(sent.at(-1)).toContain('图片接收失败')
  })

  it('单张失败其余照常:剩余图片仍随 /chat 发送', async () => {
    const bodies: Array<{ images?: string[] }> = []
    let n = 0
    let clock = 0
    const deps: BridgeDeps = {
      backendConfigured: true,
      sendCard: async () => 'om_1',
      updateCard: async () => {},
      downloadImage: async () => {
        n++
        if (n === 1) throw new Error('boom')
        return { bytes: Buffer.from('x'), mime: 'image/png' }
      },
      storeImage: async () => '/uploads/ok.png',
      fetchStream: async (body) => {
        bodies.push(body)
        return new Response('event: done\ndata: {"ok":true}\n\n')
      },
      now: () => (clock += 1000),
    }
    await runFeishuChatBridge(
      { chatId: 'oc_1', openId: 'ou_1', text: '看图', images: [
        { messageId: 'om_a', imageKey: 'k_bad' },
        { messageId: 'om_a', imageKey: 'k_good' },
      ] },
      deps,
    )
    expect(bodies[0]?.images).toEqual(['/uploads/ok.png'])
  })
})

describe('runFeishuChatBridge — 纯图片缓冲 + 按钮卡片', () => {
  beforeEach(() => clearAllPendingImages())

  // 提示卡片结构助手:第二个元素是 action 按钮组。
  function cardButtons(card: unknown): string[] {
    const el = (card as { elements: Array<{ tag: string; actions?: Array<{ value: { op: string } }> }> }).elements
    return el.find((e) => e.tag === 'action')?.actions?.map((a) => a.value.op) ?? []
  }

  function makeDeps(overrides: Partial<BridgeDeps> = {}) {
    const sentCards: unknown[] = []
    const updatedCards: Array<{ id: string; card: unknown }> = []
    const bodies: Array<{ text: string; images?: string[]; scope: string }> = []
    let cardN = 0
    let imgN = 0
    let clock = 0
    const deps: BridgeDeps = {
      backendConfigured: true,
      sendCard: vi.fn(async (_chatId: string, card: unknown) => { sentCards.push(card); return `om_${++cardN}` }),
      updateCard: vi.fn(async (id: string, card: unknown) => { updatedCards.push({ id, card }) }),
      downloadImage: async () => ({ bytes: Buffer.from('x'), mime: 'image/png' }),
      storeImage: vi.fn(async () => `/uploads/p${++imgN}.png`),
      fetchStream: vi.fn(async (body: { openId: string; text: string; scope: 'p2p' | 'group'; images?: string[] }) => {
        bodies.push(body)
        return new Response('event: done\ndata: {"ok":true}\n\n')
      }) as unknown as BridgeDeps['fetchStream'],
      now: () => (clock += 1000),
      ...overrides,
    }
    return { deps, sentCards, updatedCards, bodies }
  }

  it('纯图片 → 不进 LLM,发带三按钮的提示卡片;再发一张 → 原地更新计数', async () => {
    const { deps, sentCards, updatedCards, bodies } = makeDeps()
    await runFeishuChatBridge(
      { chatId: 'oc_b', openId: 'ou_1', text: '', images: [{ messageId: 'om_a', imageKey: 'k1' }] },
      deps,
    )
    expect(bodies).toHaveLength(0) // 没有调 /chat
    expect(sentCards).toHaveLength(1)
    expect(cardText(sentCards[0])).toContain('已收到 1 张图片')
    expect(cardButtons(sentCards[0])).toEqual(['more', 'text', 'analyze'])

    // 第二条纯图片消息:同一张提示卡片更新为 2 张。
    await runFeishuChatBridge(
      { chatId: 'oc_b', openId: 'ou_1', text: '', images: [{ messageId: 'om_b', imageKey: 'k2' }] },
      deps,
    )
    expect(sentCards).toHaveLength(1)
    expect(updatedCards).toHaveLength(1)
    expect(updatedCards[0]!.id).toBe('om_1')
    expect(cardText(updatedCards[0]!.card)).toContain('已收到 2 张图片')
  })

  it('缓冲存在时来文字消息 → 合并图片一起进 LLM,提示卡片改写收尾', async () => {
    const { deps, updatedCards, bodies } = makeDeps()
    await runFeishuChatBridge(
      { chatId: 'oc_m', openId: 'ou_1', text: '', images: [{ messageId: 'om_a', imageKey: 'k1' }] },
      deps,
    )
    await runFeishuChatBridge({ chatId: 'oc_m', openId: 'ou_1', text: '这张图是什么' }, deps)
    expect(bodies).toHaveLength(1)
    expect(bodies[0]).toMatchObject({ text: '这张图是什么', images: ['/uploads/p1.png'] })
    // 提示卡片被改写为「已连同…分析」
    expect(updatedCards.some(({ card }) => cardText(card).includes('已连同 1 张图片'))).toBe(true)
    // 缓冲已消费:再发文字不再带图。
    await runFeishuChatBridge({ chatId: 'oc_m', openId: 'ou_1', text: '继续' }, deps)
    expect(bodies[1]).toEqual({ openId: 'ou_1', text: '继续', scope: 'p2p' })
  })

  it('满 3 张后:卡片不再给「继续上传图片」按钮,多余图片丢弃并注明', async () => {
    const { deps, sentCards, updatedCards } = makeDeps()
    await runFeishuChatBridge(
      { chatId: 'oc_full', openId: 'ou_1', text: '', images: [
        { messageId: 'om_a', imageKey: 'k1' },
        { messageId: 'om_a', imageKey: 'k2' },
        { messageId: 'om_a', imageKey: 'k3' },
      ] },
      deps,
    )
    expect(cardButtons(sentCards[0])).toEqual(['text', 'analyze'])
    // 第 4 张:计数仍 3,卡片注明忽略。
    await runFeishuChatBridge(
      { chatId: 'oc_full', openId: 'ou_1', text: '', images: [{ messageId: 'om_b', imageKey: 'k4' }] },
      deps,
    )
    const last = cardText(updatedCards.at(-1)!.card)
    expect(last).toContain('已收到 3 张图片')
    expect(last).toContain('已忽略多余的 1 张')
  })

  it('并发两条纯图片(不互相 await)→ 只发一张提示卡,第二条原地更新为 2 张', async () => {
    const { deps, sentCards, updatedCards, bodies } = makeDeps()
    await Promise.all([
      runFeishuChatBridge({ chatId: 'oc_race', openId: 'ou_1', text: '', images: [{ messageId: 'om_a', imageKey: 'k1' }] }, deps),
      runFeishuChatBridge({ chatId: 'oc_race', openId: 'ou_1', text: '', images: [{ messageId: 'om_b', imageKey: 'k2' }] }, deps),
    ])
    expect(bodies).toHaveLength(0)
    expect(sentCards).toHaveLength(1) // 没有串行化时这里会是 2(双卡,其一变死卡)
    expect(updatedCards).toHaveLength(1)
    expect(cardText(updatedCards[0]!.card)).toContain('已收到 2 张图片')
  })

  it('纯图片后立刻并发来文字 → 文字回合等图片落盘,合并带图分析', async () => {
    const { deps, bodies } = makeDeps()
    await Promise.all([
      runFeishuChatBridge({ chatId: 'oc_seq', openId: 'ou_1', text: '', images: [{ messageId: 'om_a', imageKey: 'k1' }] }, deps),
      runFeishuChatBridge({ chatId: 'oc_seq', openId: 'ou_1', text: '这是什么' }, deps),
    ])
    expect(bodies).toHaveLength(1)
    expect(bodies[0]).toMatchObject({ text: '这是什么', images: ['/uploads/p1.png'] })
  })

  it('analyzePendingImages:消费缓冲,以空文字+图片跑一轮;空缓冲返回 false 并补「已过期」卡片', async () => {
    const { deps, bodies, sentCards } = makeDeps()
    // 空缓冲 → false,不进 LLM,补一张说明卡(路由层 toast 已说「开始分析」)。
    expect(await analyzePendingImages({ chatId: 'oc_an', openId: 'ou_1' }, deps)).toBe(false)
    expect(bodies).toHaveLength(0)
    expect(cardText(sentCards.at(-1))).toContain('已过期')

    await runFeishuChatBridge(
      { chatId: 'oc_an', openId: 'ou_1', text: '', images: [{ messageId: 'om_a', imageKey: 'k1' }] },
      deps,
    )
    expect(await analyzePendingImages({ chatId: 'oc_an', openId: 'ou_1' }, deps)).toBe(true)
    expect(bodies).toHaveLength(1)
    expect(bodies[0]).toMatchObject({ text: '', images: ['/uploads/p1.png'], scope: 'p2p' })
    // 已消费 → 再点一次「分析」返回 false。
    expect(await analyzePendingImages({ chatId: 'oc_an', openId: 'ou_1' }, deps)).toBe(false)
  })
})

// 回答是长流：超时只能管「等到响应头」，不能把之后的流也切断。
describe('fetchWithHeadersTimeout', () => {
  async function serve(handler: Parameters<typeof createServer>[1]): Promise<{ url: string; server: Server }> {
    const server = createServer(handler)
    await new Promise<void>((r) => server.listen(0, '127.0.0.1', r))
    return { url: `http://127.0.0.1:${(server.address() as AddressInfo).port}/`, server }
  }

  it('响应头到达后，超过时限的流仍能读完', async () => {
    const { url, server } = await serve((_req, res) => {
      res.writeHead(200, { 'content-type': 'text/event-stream' })
      res.write('a')
      setTimeout(() => res.end('b'), 1500)
    })
    try {
      // 时限 500ms，流在第 1.5 秒才结束：读完说明计时器只管响应头。
      const res = await fetchWithHeadersTimeout(url, {}, 500)
      expect(await res.text()).toBe('ab')
    } finally {
      server.close()
    }
  })

  it('迟迟不返回响应头时按超时失败', async () => {
    const { url, server } = await serve((_req, res) => {
      setTimeout(() => res.end('late'), 3000)
    })
    try {
      await expect(fetchWithHeadersTimeout(url, {}, 300)).rejects.toMatchObject({ name: 'TimeoutError' })
    } finally {
      server.closeAllConnections()
      server.close()
    }
  })
})
