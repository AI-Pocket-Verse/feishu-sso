/**
 * Feishu event-subscription receiver (bot inbound). Registered on the SAME
 * Feishu app as SSO, so a message sender's open_id equals the open_id that
 * whoami returns for that user — the bot backend can map senders to accounts.
 *
 * Security: when an Encrypt Key is configured, the `encrypt` field is decrypted
 * (only the holder of the key can produce a valid ciphertext). We additionally
 * check the Verification Token carried in the (decrypted) payload. This avoids
 * needing the raw request body for X-Lark-Signature (no rawBody plugin wired);
 * the signature helper is still exported by the provider package for callers
 * that DO capture the raw body.
 *
 * Latency: Feishu retries unless it gets a 200 within ~3s, but a chat turn takes
 * far longer — so we ack immediately and run the bridge in setImmediate.
 */
import type { FastifyPluginAsync } from 'fastify'
import { decryptFeishuEvent } from '@feishu-sso/auth-provider-feishu'
import { botText } from '../bot-i18n'
import { env } from '../env'
import { runFeishuChatBridge, analyzePendingImages } from '../services/feishu-chat-bridge'
import { getPendingImages, pendingKey, IMAGE_PROMPT_KEY, MAX_PENDING_IMAGES } from '../services/feishu-image-buffer'
import { getCachedBotOpenId, isBotMentioned } from '../services/feishu-bot-identity'

// In-memory dedupe of recently-seen event_ids — Feishu retries on a slow ack.
// We ack within the same tick so retries are rare; a short TTL set suffices and
// avoids an auth-side table/migration. NOT shared across restarts (acceptable).
const seen = new Map<string, number>()
const DEDUPE_TTL_MS = 10 * 60_000
function markFresh(id: string, now: number): boolean {
  for (const [k, t] of seen) if (now - t > DEDUPE_TTL_MS) seen.delete(k)
  if (seen.has(id)) return false
  seen.set(id, now)
  return true
}

/** Fire-and-forget POST to the bot backend's internal API (protocol in
 *  docs/bot-backend.md). No-op when BOT_BACKEND_URL is unset: the cards and
 *  messages these forwards react to only exist when a backend is connected. */
function forwardToBotBackend(path: string, body: unknown): Promise<Response | undefined> {
  if (!env.BOT_BACKEND_URL) return Promise.resolve(undefined)
  return fetch(`${env.BOT_BACKEND_URL}${path}`, {
    method: 'POST',
    headers: { 'content-type': 'application/json', 'x-internal-token': env.INTERNAL_API_TOKEN },
    body: JSON.stringify(body),
  })
}

interface FeishuEventPayload {
  type?: string
  challenge?: string
  token?: string
  header?: { token?: string; event_id?: string; event_type?: string }
  event?: {
    message?: {
      message_id?: string
      chat_type?: string
      message_type?: string
      content?: string
      chat_id?: string
      mentions?: Array<{ key?: string; id?: { open_id?: string }; name?: string }>
    }
    sender?: { sender_id?: { open_id?: string } }
    // card.action.trigger(卡片回传交互)字段:点按钮的人 + 按钮 value + 所在会话。
    operator?: { open_id?: string }
    // checker(勾选器)回调多带一个 checked:true=勾(确认)/ false=取消勾(撤销)。
    action?: { tag?: string; checked?: boolean; value?: { k?: string; op?: string; h?: string } }
    context?: { open_message_id?: string; open_chat_id?: string }
  }
}

const MAX_INBOUND_IMAGES = 3

/** 把入站消息统一解析为「文字 + 图片 key 列表」:
 *  - text:  {"text":"..."}
 *  - image: {"image_key":"img_..."}(纯图片消息,无文字)
 *  - post:  富文本(图文混排),content 为段落二维数组,扁平收集 text 与 img 节点
 *  其它类型(文件/表情包等)→ 双空,调用方按「不处理」分支走。 */
function parseInboundMessage(m?: { message_type?: string; content?: string }): { text: string; imageKeys: string[] } {
  let text = ''
  const imageKeys: string[] = []
  try {
    const c = JSON.parse(m?.content ?? '{}') as Record<string, unknown>
    if (m?.message_type === 'text') {
      text = typeof c.text === 'string' ? c.text : ''
    } else if (m?.message_type === 'image') {
      if (typeof c.image_key === 'string') imageKeys.push(c.image_key)
    } else if (m?.message_type === 'post') {
      const rows = Array.isArray(c.content) ? (c.content as unknown[]) : []
      const parts: string[] = []
      for (const row of rows) {
        if (!Array.isArray(row)) continue
        for (const node of row as unknown[]) {
          const n = node as { tag?: string; text?: string; image_key?: string }
          if (n.tag === 'text' && typeof n.text === 'string') parts.push(n.text)
          else if (n.tag === 'img' && typeof n.image_key === 'string') imageKeys.push(n.image_key)
        }
        parts.push('\n')
      }
      text = parts.join('').trim()
    }
  } catch { /* unparseable content → treat as unhandled */ }
  return { text, imageKeys: imageKeys.slice(0, MAX_INBOUND_IMAGES) }
}

export const feishuEventsRoutes: FastifyPluginAsync = async (app) => {
  // Fail-closed posture. With NEITHER an Encrypt Key NOR a Verification Token,
  // anyone who knows this URL can forge an `im.message.receive_v1` carrying a
  // victim's open_id + an attacker-controlled chat_id and make the bot run (and
  // leak) that member's chat turn. Warn always; in production, REJECT until at
  // least one secret is configured.
  const unauthenticated = !env.FEISHU_EVENT_ENCRYPT_KEY && !env.FEISHU_EVENT_VERIFICATION_TOKEN
  if (unauthenticated) {
    const base =
      'feishu /api/feishu/events has no Encrypt Key / Verification Token — inbound events are UNAUTHENTICATED and forgeable'
    if (env.NODE_ENV === 'production') {
      app.log.error(`${base}; REJECTING all events in production until one is set (FEISHU_EVENT_VERIFICATION_TOKEN or FEISHU_EVENT_ENCRYPT_KEY)`)
    } else {
      app.log.warn(`${base} (permitted outside production)`)
    }
  }

  app.post('/api/feishu/events', async (req, reply) => {
    // Production fail-closed: reject everything until a token/encrypt key is set.
    // Once configured, even Feishu's url_verification carries the token, so the
    // normal setup flow still works — this only blocks the unconfigured window.
    if (env.NODE_ENV === 'production' && !env.FEISHU_EVENT_ENCRYPT_KEY && !env.FEISHU_EVENT_VERIFICATION_TOKEN) {
      req.log.error('feishu event rejected: endpoint unauthenticated in production (set FEISHU_EVENT_VERIFICATION_TOKEN or FEISHU_EVENT_ENCRYPT_KEY)')
      return reply.code(403).send({})
    }
    const raw = (req.body ?? {}) as { encrypt?: string } & FeishuEventPayload

    let payload: FeishuEventPayload
    if (env.FEISHU_EVENT_ENCRYPT_KEY) {
      if (typeof raw.encrypt !== 'string') return reply.code(400).send({})
      try {
        payload = JSON.parse(decryptFeishuEvent(raw.encrypt, env.FEISHU_EVENT_ENCRYPT_KEY)) as FeishuEventPayload
      } catch {
        return reply.code(400).send({})
      }
    } else {
      payload = raw
    }

    // Verification token (present in the url_verification challenge and every
    // event header). Enforced only when configured.
    const token = payload.header?.token ?? payload.token
    if (env.FEISHU_EVENT_VERIFICATION_TOKEN && token !== env.FEISHU_EVENT_VERIFICATION_TOKEN) {
      return reply.code(401).send({})
    }

    if (payload.type === 'url_verification') {
      return reply.send({ challenge: payload.challenge })
    }

    const header = payload.header
    const eventId = header?.event_id
    const fresh = !eventId || markFresh(eventId, Date.now())

    // im.message.receive_v1 — text / image / post(图文)。p2p = 1:1 私聊(有
    // 状态);group = 群里 @机器人(无状态,仅在机器人确被 @ 时响应;注意纯图片
    // 消息没法 @,群场景图片只能经 post 富文本进来)。
    if (fresh && header?.event_type === 'im.message.receive_v1') {
      const m = payload.event?.message
      const openId = payload.event?.sender?.sender_id?.open_id
      const { text: rawText, imageKeys } = parseInboundMessage(m)
      // 图片下载需要消息 id(im/v1/messages/:id/resources)。
      const images = m?.message_id
        ? imageKeys.map((key) => ({ messageId: m.message_id as string, imageKey: key }))
        : []

      if (m?.chat_id && openId && m.chat_type === 'p2p' && (rawText.trim() || images.length > 0)) {
        const chatId = m.chat_id, text = rawText
        app.log.info({ scope: 'p2p', dispatch: true, images: images.length }, 'feishu message-event dispatch decision')
        setImmediate(() => {
          void runFeishuChatBridge({ chatId, openId, text, scope: 'p2p', images }).catch((e) => app.log.error(e, 'feishu chat bridge failed'))
        })
      } else if (m?.chat_id && openId && m.chat_type === 'group') {
        // 群聊:只在机器人确被 @ 时响应(避免 @ 别人时也插话)。取不到 bot
        // open_id 时按「未被 @」处理,宁可不响应也不刷屏。剥掉 @ 占位符。
        const botOpenId = await getCachedBotOpenId().catch(() => '')
        const mentioned = isBotMentioned(m.mentions, botOpenId)
        const text = rawText.replace(/@_user_\d+/g, '').replace(/@_all/g, '').trim()
        app.log.info({ scope: 'group', mentioned, hasText: !!text, images: images.length }, 'feishu message-event dispatch decision')
        if (mentioned && (text || images.length > 0)) {
          const chatId = m.chat_id
          setImmediate(() => {
            void runFeishuChatBridge({ chatId, openId, text, scope: 'group', images }).catch((e) => app.log.error(e, 'feishu group bridge failed'))
          })
        } else if (!mentioned && text && m.message_id && openId !== botOpenId) {
          // 群聊旁听:非 @ 的【文本】消息转发给对话后端判定是否主动答疑。
          // 跳过机器人自己的发言;纯图片/其它类型不转发。fire-and-forget —— 对话后端
          // 立即 200,实际「判定 + 引用回复」在它那侧异步跑。需机器人有
          // im:message.group_msg 权限才会收到这类非 @ 群消息(见 README)。
          const chatId = m.chat_id
          const messageId = m.message_id
          setImmediate(() => {
            void forwardToBotBackend('/api/internal/feishu/group-observe', {
              chatId, messageId, openId, senderName: '', text,
            }).catch((e) => app.log.error(e, 'group-observe forward failed'))
          })
        }
      } else {
        app.log.info({ chatType: m?.chat_type, messageType: m?.message_type, hasChatId: !!m?.chat_id, hasOpenId: !!openId }, 'feishu message-event not dispatched')
      }
    } else if (fresh && header?.event_type === 'card.action.trigger') {
      // 卡片回传交互(需在开放平台「回调订阅」添加,与事件订阅同 URL/加密)。
      // 「纯图片待分析」提示卡片的三个按钮(value.k === IMAGE_PROMPT_KEY)由本服务处理,
      // 其余按钮转发给对话后端。
      // 响应体里的 toast 会在点按钮的人的客户端弹出;须 3s 内同步返回,
      // 「分析图片」的耗时部分照例 setImmediate 派发。
      const v = payload.event?.action?.value
      const openId = payload.event?.operator?.open_id
      const chatId = payload.event?.context?.open_chat_id
      if (v?.k === IMAGE_PROMPT_KEY && openId && chatId) {
        app.log.info({ op: v.op, scope: 'card' }, 'feishu card action received')
        if (v.op === 'analyze') {
          if (!getPendingImages(pendingKey(chatId, openId), Date.now())) {
            return reply.send({ toast: { type: 'warning', content: botText(env.BOT_LANG, 'imagesExpired') } })
          }
          setImmediate(() => {
            void analyzePendingImages({ chatId, openId }).catch((e) => app.log.error(e, 'feishu analyze pending images failed'))
          })
          return reply.send({ toast: { type: 'info', content: botText(env.BOT_LANG, 'toastAnalyzeStart') } })
        }
        if (v.op === 'more') {
          return reply.send({ toast: { type: 'info', content: botText(env.BOT_LANG, 'toastMoreImages', { max: MAX_PENDING_IMAGES }) } })
        }
        if (v.op === 'text') {
          return reply.send({ toast: { type: 'info', content: botText(env.BOT_LANG, 'toastEnterText') } })
        }
      }
      // 文档体检勾选器:勾(checked=true,确认)/ 取消勾(false,撤销)。
      // ⚠️ 必须 3s 内 ack,否则飞书弹「出错了,请稍后重试」(超时)。落库要走
      // 本服务→对话后端的内网往返 + 数据库 + 首次 import('../feishu'),都可能 >3s,故
      // 这里**先**乐观回 toast(勾选器客户端已本地切换),转发 + 重建卡 + PATCH 全异步。
      if (v?.k === 'doc_audit_ack' && v.h && openId) {
        const messageId = payload.event?.context?.open_message_id
        // checker 回调带 action.checked;缺省(老按钮卡)按勾处理。
        const checked = payload.event?.action?.checked ?? true
        const hash = v.h
        const operatorOpenId = openId
        setImmediate(() => {
          void (async () => {
            try {
              const res = await forwardToBotBackend('/api/internal/doc-audit/acknowledge', { hash, operatorOpenId, checked })
              if (!res) return
              const data = (await res.json().catch(() => null)) as { toast?: string; card?: unknown } | null
              // toast 已乐观回过(3s 内),这里只补「持久化 + 广播」。下面两种「没成功」要可观测,
              // 否则用户看到「已确认」但其实没落库(转发失败 / 该条已不在最新卡)会无声无息。
              if (!res.ok) {
                app.log.warn({ status: res.status, hash, checked }, 'doc-audit ack forward returned non-200; toast already sent, not persisted')
                return
              }
              if (!data?.card) {
                app.log.warn({ hash, checked }, 'doc-audit ack: item not on the latest card; toast already sent, not persisted')
                return
              }
              if (messageId) {
                // 动态 import:避免模块顶层引入 ../feishu(import 期读全套 FEISHU_* env,会拖垮
                // 只 mock 了部分 env 的单测);真机里 ../feishu 早被聊天桥加载,命中缓存。
                const { feishuDocs } = await import('../feishu')
                await feishuDocs.updateInteractiveCard(messageId, data.card)
              }
            } catch (e) {
              app.log.error(e, 'doc-audit acknowledge async failed')
            }
          })()
        })
        return reply.send({ toast: { type: checked ? 'success' : 'info', content: botText(env.BOT_LANG, checked ? 'toastAckChecked' : 'toastAckUnchecked') } })
      }
      // 群聊智能答疑反馈:👍 有帮助 / 👎 没帮助。立即回 toast,转发在 setImmediate 异步
      // (同 3s ack 纪律)。👎 触发反对降权(TTL 内同问题不再答),👍 仅给看板计数。
      if ((v?.k === 'group_qa_up' || v?.k === 'group_qa_down') && v.h) {
        const helpful = v.k === 'group_qa_up'
        const hash = v.h
        setImmediate(() => {
          void forwardToBotBackend('/api/internal/group-qa/feedback', { hash, helpful })
            .catch((e) => app.log.error(e, 'group-qa feedback forward failed'))
        })
        return reply.send({ toast: { type: helpful ? 'success' : 'info', content: botText(env.BOT_LANG, helpful ? 'toastHelpful' : 'toastNotHelpful') } })
      }
      // 专家升级单回流:负责人点候选按钮(value.kind=expert_escalation)→ 转发对话后端拍板。
      // 立即乐观回 toast(3s ack 纪律);真正的授权(必须是该单负责人/管理员)与幂等由对话后端校验。
      const esc = v as { kind?: string; escalationId?: string; option?: string } | undefined
      if (esc?.kind === 'expert_escalation' && typeof esc.escalationId === 'string' && openId) {
        const escalationId = esc.escalationId
        const resolution = (typeof esc.option === 'string' && esc.option.trim()) ? esc.option : '已确认'
        const operatorOpenId = openId
        setImmediate(() => {
          void forwardToBotBackend('/api/internal/expert-escalation/resolve', { escalationId, resolution, operatorOpenId })
            .catch((e) => app.log.error(e, 'expert-escalation resolve forward failed'))
        })
        return reply.send({ toast: { type: 'info', content: botText(env.BOT_LANG, 'toastEscalation') } })
      }
    } else if (fresh) {
      // An event we don't handle (e.g. message_read, bot_added). Log the type
      // only — useful when adding new event handlers later.
      app.log.info({ eventType: header?.event_type }, 'feishu event ignored (not im.message.receive_v1)')
    }

    return reply.send({})
  })
}
