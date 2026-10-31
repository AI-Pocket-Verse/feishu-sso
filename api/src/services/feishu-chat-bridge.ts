// Feishu chat bridge: send a "thinking" card, pull the bot backend's SSE answer
// stream (BOT_BACKEND_URL, protocol in docs/bot-backend.md), and throttle-update
// the card into a "typewriter" reply. This is the ONLY place that joins the
// Feishu bot (this service owns the SDK) to the chat backend. Deps are injected
// so the orchestration is unit-testable without a real Feishu app or backend.
import { feishuDocs } from '../feishu'
import { env } from '../env'
import { shouldFlush, type ThrottleState } from './card-stream-throttle'
import {
  IMAGE_PROMPT_KEY,
  MAX_PENDING_IMAGES,
  addPendingImages,
  pendingKey,
  takePendingImages,
} from './feishu-image-buffer'

// Minimal interactive card carrying a single lark_md text block (passes the
// validCard shape check in routes/feishu-docs: a plain object with an `elements` array).
const textCard = (content: string) => ({ elements: [{ tag: 'div', text: { tag: 'lark_md', content } }] })

/** 没配置对话后端时，机器人对所有提问的统一回复。 */
export const BACKEND_OFF_TEXT = '机器人还没有接入对话后端，暂时无法回答。请联系管理员配置 BOT_BACKEND_URL。'

// 纯图片消息的提示卡片:三个回传交互按钮(value 在 card.action.trigger 回调里
// 原样带回,k 用于路由识别)。达到张数上限时不再渲染「继续上传图片」。
const imagePromptCard = (count: number, dropped: number) => {
  const note = dropped > 0 ? `（最多 ${MAX_PENDING_IMAGES} 张，已忽略多余的 ${dropped} 张）` : ''
  const tail = count >= MAX_PENDING_IMAGES ? '已达上限，可输入文字一起提问，或直接分析。' : '你可以继续发图片、输入文字一起提问，或直接分析。'
  const button = (op: string, label: string, primary = false) => ({
    tag: 'button',
    text: { tag: 'plain_text', content: label },
    type: primary ? 'primary' : 'default',
    value: { k: IMAGE_PROMPT_KEY, op },
  })
  return {
    elements: [
      { tag: 'div', text: { tag: 'lark_md', content: `已收到 ${count} 张图片${note}，10 分钟内有效。${tail}` } },
      {
        tag: 'action',
        actions: [
          ...(count < MAX_PENDING_IMAGES ? [button('more', '继续上传图片')] : []),
          button('text', '输入文字'),
          button('analyze', '分析图片', true),
        ],
      },
    ],
  }
}

export type ChatScope = 'p2p' | 'group'

/** 入站消息携带的图片(image_key 来自事件;下载消息资源还需消息 id)。 */
export interface InboundImage {
  messageId: string
  imageKey: string
}

export interface BridgeDeps {
  /** 是否配置了对话后端；未配置时只回复 BACKEND_OFF_TEXT。 */
  backendConfigured: boolean
  sendCard: (chatId: string, card: unknown) => Promise<string>
  updateCard: (messageId: string, card: unknown) => Promise<void>
  fetchStream: (body: { openId: string; text: string; scope: ChatScope; images?: string[] }) => Promise<Response>
  /** 机器人身份下载消息里的图片字节(im/v1 message resource,tenant token,需 im:resource)。 */
  downloadImage: (messageId: string, fileKey: string) => Promise<{ bytes: Buffer; mime: string }>
  /** 把图片字节交给对话后端落盘,换 /uploads/<file> 视图(供随后的 /chat 引用)。 */
  storeImage: (openId: string, bytes: Buffer) => Promise<string>
  now: () => number
  /** 卡片里的助手称呼，默认「AI」（env ASSISTANT_NAME）。 */
  assistantName?: string
  /** 诊断日志；默认 console.error。不要传入口令。 */
  logError?: (info: Record<string, unknown>, msg: string) => void
}

// 对话后端迟迟不返回响应头就放弃，避免卡片永远停在「思考中」。
const BACKEND_HEADERS_TIMEOUT_MS = 60_000

export const defaultBridgeDeps: BridgeDeps = {
  backendConfigured: !!env.BOT_BACKEND_URL,
  assistantName: env.ASSISTANT_NAME,
  logError: (info, msg) => console.error(`[feishu-sso] ${msg}`, info),
  sendCard: (chatId, card) => feishuDocs.sendInteractiveCardToChat(chatId, card),
  updateCard: (messageId, card) => feishuDocs.updateInteractiveCard(messageId, card),
  fetchStream: (body) =>
    fetch(`${env.BOT_BACKEND_URL}/api/internal/feishu/chat`, {
      method: 'POST',
      headers: { 'content-type': 'application/json', 'x-internal-token': env.INTERNAL_API_TOKEN },
      body: JSON.stringify(body),
      // 只限制等到响应头的时间；回答是长流，不能整体加超时。
      signal: AbortSignal.timeout(BACKEND_HEADERS_TIMEOUT_MS),
    }),
  downloadImage: (messageId, fileKey) => feishuDocs.downloadMessageImage(messageId, fileKey),
  storeImage: async (openId, bytes) => {
    const res = await fetch(`${env.BOT_BACKEND_URL}/api/internal/feishu/image`, {
      method: 'POST',
      headers: {
        'content-type': 'application/octet-stream',
        'x-internal-token': env.INTERNAL_API_TOKEN,
        'x-open-id': openId,
      },
      body: new Uint8Array(bytes),
      signal: AbortSignal.timeout(30_000),
    })
    if (!res.ok) throw new Error(`bot backend image store HTTP ${res.status}`)
    const data = (await res.json()) as { url?: string }
    if (!data.url) throw new Error('bot backend image store returned no url')
    return data.url
  },
  now: () => Date.now(),
}

// 图片缓冲临界区的「按会话串行化」。每条飞书消息在 feishu-events 里独立
// setImmediate 进来,没有这层时:连发两张图会各发一张提示卡(cardMessageId
// 在 await sendCard 之后才写回缓冲,两个并发回合都看到 null);发完图立刻
// 打字,文字回合可能赶在图片落盘之前消费到空缓冲,把图丢下。只串行
// 「下载落盘 + 缓冲读写 + 提示卡」的准备段,LLM 流式不在链上 —— 连续两个
// 文字提问仍然并发出卡(对话后端自有会话锁排队)。
const chatChains = new Map<string, Promise<unknown>>()
function serializePerChat<T>(key: string, fn: () => Promise<T>): Promise<T> {
  const prev = chatChains.get(key) ?? Promise.resolve()
  const run = prev.then(fn, fn) // 前一个失败也不阻断后续回合
  const tail = run.then(() => undefined, () => undefined)
  chatChains.set(key, tail)
  void tail.then(() => { if (chatChains.get(key) === tail) chatChains.delete(key) })
  return run
}

/** Run one Feishu turn end-to-end (called from /api/feishu/events via
 *  setImmediate). scope 'p2p' = 1:1 私聊(有状态);'group' = 群里 @机器人
 *  (无状态、只用公开知识)。卡片发送/更新对 p2p 与 group 的 chat_id 同样适用。
 *
 *  纯图片消息(无文字)不直接进 LLM:先落盘进「待分析缓冲」并回一张带
 *  「继续上传图片 / 输入文字 / 分析图片」按钮的提示卡片(按钮回调见
 *  feishu-events 的 card.action.trigger 分支);随后的文字消息自动合并缓冲
 *  里的图片一起分析。 */
export async function runFeishuChatBridge(
  args: { chatId: string; openId: string; text: string; scope?: ChatScope; images?: InboundImage[] },
  deps: BridgeDeps = defaultBridgeDeps,
): Promise<void> {
  if (!deps.backendConfigured) {
    await deps.sendCard(args.chatId, textCard(BACKEND_OFF_TEXT))
    return
  }
  const turn = await serializePerChat(pendingKey(args.chatId, args.openId), () => prepareTurn(args, deps))
  if (turn) await streamAnswerToCard(turn, deps)
}

/** 串行化的准备段:下载落盘入站图片;纯图片 → 进缓冲 + 提示卡后返回 null
 *  (本回合不进 LLM);文字 → 合并缓冲图片,返回流式段所需的载荷。 */
async function prepareTurn(
  args: { chatId: string; openId: string; text: string; scope?: ChatScope; images?: InboundImage[] },
  deps: BridgeDeps,
): Promise<{ chatId: string; openId: string; text: string; scope: ChatScope; imageUrls: string[] } | null> {
  const scope: ChatScope = args.scope ?? 'p2p'
  const hasText = !!args.text.trim()

  // 图片中转:飞书下载 → 对话后端落盘 → /uploads 视图。逐张 best-effort,
  // 单张失败跳过;全部失败且没有文字时直接收尾(没有可问的内容)。
  const imageUrls: string[] = []
  let imageFailures = 0
  for (const img of args.images ?? []) {
    try {
      const { bytes } = await deps.downloadImage(img.messageId, img.imageKey)
      imageUrls.push(await deps.storeImage(args.openId, bytes))
    } catch {
      imageFailures++
    }
  }

  // 纯图片消息 → 进缓冲 + 提示卡片,等用户下一步动作,本轮不进 LLM。
  if (!hasText && (args.images?.length ?? 0) > 0) {
    if (imageUrls.length === 0) {
      await deps.sendCard(
        args.chatId,
        textCard(imageFailures > 0 ? '图片接收失败了，请重发试试（或检查机器人图片权限）。' : '没有收到可识别的图片内容。'),
      )
      return null
    }
    const { entry, dropped } = addPendingImages(pendingKey(args.chatId, args.openId), imageUrls, scope, deps.now())
    const card = imagePromptCard(entry.urls.length, dropped)
    if (entry.cardMessageId) {
      // 连发多条图片:原地更新计数;卡片可能已被撤回,更新失败就补发新卡。
      try {
        await deps.updateCard(entry.cardMessageId, card)
      } catch {
        entry.cardMessageId = await deps.sendCard(args.chatId, card)
      }
    } else {
      entry.cardMessageId = await deps.sendCard(args.chatId, card)
    }
    return null
  }

  // 文字消息(可能本身还带图):把缓冲里等待的图片合并进来一起分析。
  if (hasText) {
    const buffered = takePendingImages(pendingKey(args.chatId, args.openId), deps.now())
    if (buffered && buffered.urls.length > 0) {
      const merged = [...buffered.urls, ...imageUrls].slice(0, MAX_PENDING_IMAGES)
      imageUrls.length = 0
      imageUrls.push(...merged)
      if (buffered.cardMessageId) {
        await deps
          .updateCard(buffered.cardMessageId, textCard(`✅ 已连同 ${buffered.urls.length} 张图片一起分析。`))
          .catch(() => {})
      }
    }
  }

  return { chatId: args.chatId, openId: args.openId, text: args.text, scope, imageUrls }
}

/** 「分析图片」按钮回调入口:消费缓冲并以空文字 + 图片跑一轮(对话后端对
 *  纯图片轮次有内置兜底提问词)。无可用缓冲(过期/已消费)返回 false ——
 *  路由层 peek 与这里 take 之间存在竞态(双击「分析」/文字消息抢先消费),
 *  此时用户已看到「开始分析」toast,补一张说明卡片而不是静默吞掉。 */
export async function analyzePendingImages(
  args: { chatId: string; openId: string },
  deps: BridgeDeps = defaultBridgeDeps,
): Promise<boolean> {
  const buffered = await serializePerChat(pendingKey(args.chatId, args.openId), async () => {
    const b = takePendingImages(pendingKey(args.chatId, args.openId), deps.now())
    if (!b || b.urls.length === 0) {
      await deps.sendCard(args.chatId, textCard('图片已过期或已分析过，请重新发送图片。')).catch(() => {})
      return null
    }
    if (b.cardMessageId) {
      await deps.updateCard(b.cardMessageId, textCard(`✅ 开始分析 ${b.urls.length} 张图片…`)).catch(() => {})
    }
    return b
  })
  if (!buffered) return false
  await streamAnswerToCard(
    { chatId: args.chatId, openId: args.openId, text: '', scope: buffered.scope, imageUrls: buffered.urls },
    deps,
  )
  return true
}

/** 一轮回答的卡片流式骨架:发「思考中」卡 → 拉对话后端的 SSE → 打字机
 *  节流更新 → 收尾(错误/need_login/空内容都有友好文案)。 */
async function streamAnswerToCard(
  args: { chatId: string; openId: string; text: string; scope: ChatScope; imageUrls: string[] },
  deps: BridgeDeps,
): Promise<void> {
  const { scope, imageUrls } = args
  const name = deps.assistantName ?? 'AI'
  const logError = deps.logError ?? (() => {})
  const messageId = await deps.sendCard(args.chatId, textCard(`${name} 正在思考…`))

  let full = ''
  let errored: string | null = null
  let needLogin: string | null = null
  const state: ThrottleState = { lastFlushAt: deps.now(), lastFlushLen: 0, curLen: 0 }

  try {
    const res = await deps.fetchStream({
      openId: args.openId,
      text: args.text,
      scope,
      ...(imageUrls.length > 0 ? { images: imageUrls } : {}),
    })
    // The backend replies with JSON (NOT SSE) on 401 (token mismatch) / 503
    // (restoring) / 400 (bad input). Without this guard those bytes parse to no
    // frames and the card would settle on a misleading "（无内容）".
    if (!res.ok) {
      logError({ status: res.status }, 'bot backend returned non-2xx')
      errored =
        res.status === 503
          ? `${name} 维护中，请稍后再试。`
          : res.status === 401
            ? '机器人口令与对话后端不一致（bot_backend_unauthorized），请联系管理员检查 INTERNAL_API_TOKEN。'
            : `连接 ${name} 失败（bot_backend_http_${res.status}），请稍后再试。`
    }
    const reader = res.ok ? res.body?.getReader() : undefined
    if (reader) {
      const decoder = new TextDecoder()
      let buf = ''
      for (;;) {
        const { value, done } = await reader.read()
        if (done) break
        buf += decoder.decode(value, { stream: true })
        // Parse complete SSE frames (terminated by a blank line).
        let idx: number
        while ((idx = buf.indexOf('\n\n')) !== -1) {
          const frame = buf.slice(0, idx)
          buf = buf.slice(idx + 2)
          const ev = /event:\s*(\w+)/.exec(frame)?.[1]
          const dataStr = frame
            .split('\n')
            .filter((l) => l.startsWith('data:'))
            .map((l) => l.slice(5).trim())
            .join('\n')
          let data: { text?: string; message?: string } = {}
          try { data = JSON.parse(dataStr || '{}') } catch { /* non-JSON data line */ }

          if (ev === 'token' && data.text) {
            full += data.text
            state.curLen = full.length
            if (shouldFlush(state, deps.now())) {
              // Best-effort intermediate update: a dropped frame is fine, the next
              // flush (or the final one below) re-sends the full accumulated text.
              await deps.updateCard(messageId, textCard(full)).catch(() => {})
              state.lastFlushAt = deps.now()
              state.lastFlushLen = full.length
            }
          } else if (ev === 'queued' && data.message) {
            // 同一会话的上一轮回答还在生成(网页端或飞书端发起),对话后端在
            // 会话锁上排队 —— 把「思考中」换成排队文案;开始流式后会被 token
            // 更新覆盖。Best-effort:丢帧无妨。
            await deps.updateCard(messageId, textCard(data.message)).catch(() => {})
          } else if (ev === 'need_login') {
            needLogin = data.message ?? '请先在网页端登录一次，再回来提问。'
          } else if (ev === 'error') {
            errored = data.message ?? '出错了，请稍后再试。'
          }
        }
      }
    }
  } catch (err) {
    logError({ err: String(err) }, 'bot backend request failed')
    // 拉流中途失败(如对话后端重启 / 网络中断)→ 不让「思考中」卡片卡死,
    // 已累计的部分文本保留,补一句友好错误。
    if (!errored && !needLogin) errored = `连接 ${name} 失败（bot_backend_unreachable），请稍后再试。`
  }

  // Final card state. A final-update failure propagates so the caller logs it.
  const finalText =
    needLogin ?? (errored ? (full ? `${full}\n\n（${errored}）` : errored) : (full || `（${name} 暂时没有返回内容，换个说法再问我试试~）`))
  await deps.updateCard(messageId, textCard(finalText))
}
