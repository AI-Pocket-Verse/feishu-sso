/**
 * Feishu document gateway — the only way client apps read Feishu docs.
 * Authenticated by the caller's own session cookie; we load + refresh THEIR
 * token and call Feishu as them, so the user's token never leaves this service.
 * These are specific endpoints, NOT an open proxy.
 *
 * Also hosts the INTERNAL app→app endpoints (notify / reply / reaction /
 * upload-image), guarded by INTERNAL_API_TOKEN and sent as the bot.
 */
import type { FastifyPluginAsync, FastifyReply, FastifyRequest } from 'fastify'
import { timingSafeEqual } from 'node:crypto'

import { env } from '../env'
import { loadActiveSession } from '../session'
import { feishuDocs } from '../feishu'
import { getFreshUserAccessToken, FeishuTokenError } from '../feishu-token'

async function requireUserId(req: FastifyRequest, reply: FastifyReply): Promise<string | null> {
  const sid = req.cookies?.[env.SESSION_COOKIE_NAME]
  if (!sid) {
    reply.code(401).send({ error: 'unauthenticated' })
    return null
  }
  const loaded = await loadActiveSession(sid)
  if (!loaded || !loaded.user) {
    reply.code(401).send({ error: 'unauthenticated' })
    return null
  }
  return loaded.user.id
}

// Map any Feishu-side failure to a stable shape client apps can branch on:
//   need_relogin        → token dead, user must re-login
//   feishu_need_reauth  → token lacks the doc scope (incremental consent)
//   feishu_permission   → user can't view this doc
//   feishu_upstream     → anything else
function sendFeishuError(reply: FastifyReply, err: unknown): void {
  if (err instanceof FeishuTokenError) {
    if (err.reason === 'upstream_unavailable') {
      reply.code(503).send({ error: 'feishu_unavailable', message: '暂时连不上飞书，请稍后重试' })
      return
    }
    reply.code(401).send({ error: 'need_relogin' })
    return
  }
  const msg = err instanceof Error ? err.message : String(err)
  // Always log the real upstream error (now carries Feishu's code/msg via
  // describeFeishuError) so failures are diagnosable from the logs.
  reply.log.warn({ err, msg }, 'feishu gateway upstream error')
  // App hasn't ENABLED the permission (admin must enable + release the version).
  // Re-login can't fix this — distinct from a user-reauth case. Feishu code
  // 99991672 + "应用尚未开通". Pass the real message through so the UI can show
  // exactly which scopes are missing + Feishu's enable link.
  if (/尚未开通|not.{0,4}been enabled|hasn'?t been enabled/i.test(msg)) {
    reply.code(403).send({ error: 'feishu_scope_disabled', message: msg })
    return
  }
  if (/scope|未授权|unauthor/i.test(msg)) {
    reply.code(403).send({ error: 'feishu_need_reauth', message: msg })
    return
  }
  if (/permission|forbidden|99991|access denied|无权限|no permission/i.test(msg)) {
    reply.code(403).send({ error: 'feishu_permission', message: msg })
    return
  }
  reply.code(502).send({ error: 'feishu_upstream', message: msg })
}

// Constant-time compare of the internal shared token (avoid leaking length /
// match progress via response timing).
function internalTokenOk(got: unknown): boolean {
  if (typeof got !== 'string') return false
  // 口令留空 = 关闭内部接口；空串经 timingSafeEqual 会相等，必须先排除。
  if (got === '' || env.INTERNAL_API_TOKEN === '') return false
  const a = Buffer.from(got)
  const b = Buffer.from(env.INTERNAL_API_TOKEN)
  return a.length === b.length && timingSafeEqual(a, b)
}

// The card is forwarded verbatim to im.message.create AS THE BOT — validate its
// shape so the endpoint can't be coerced into sending arbitrary payloads:
// a plain object, only known top-level keys, an elements array, bounded size.
// Accept BOTH card schemas: 1.0 (config/header/elements — 图片提示卡等) and 2.0
// (schema/config/header/body.elements — 文档体检勾选器清单)。
const V1_KEYS = new Set(['config', 'header', 'elements'])
const V2_KEYS = new Set(['schema', 'config', 'header', 'body'])
function validCard(card: unknown): boolean {
  if (!card || typeof card !== 'object' || Array.isArray(card)) return false
  const c = card as Record<string, unknown>
  const keys = Object.keys(c)
  if (keys.length === 0) return false
  const isV2 = c.schema === '2.0' || 'body' in c
  if (isV2) {
    if (c.schema !== '2.0') return false // body-shaped 卡必须显式声明 schema:"2.0",拒未知 schema
    if (keys.some((k) => !V2_KEYS.has(k))) return false
    const body = c.body as { elements?: unknown } | undefined
    if (!body || typeof body !== 'object' || Array.isArray(body) || !Array.isArray(body.elements)) return false
  } else {
    if (keys.some((k) => !V1_KEYS.has(k))) return false
    if (!Array.isArray(c.elements)) return false
  }
  return JSON.stringify(c).length <= 20_000
}

// 飞书资源 token 只含字母数字、下划线和连字符。路径参数必须先过这道校验：
// SDK 不会转义，`..%2F` 之类的值会让请求落到任意飞书开放接口。
const SAFE_PARAM = /^[A-Za-z0-9_-]+$/

export const feishuDocsRoutes: FastifyPluginAsync = async (app) => {
  app.addHook('preHandler', async (req, reply) => {
    const values = [
      ...Object.values((req.params ?? {}) as Record<string, string>),
      (req.query as { token?: unknown } | undefined)?.token,
    ]
    for (const v of values) {
      if (v !== undefined && (typeof v !== 'string' || !SAFE_PARAM.test(v))) {
        return reply.code(400).send({ error: 'invalid_input', message: '资源 token 格式不正确' })
      }
    }
  })

  // POST /api/feishu/upload-image — INTERNAL app→app endpoint(x-internal-token):
  // 业务服务把本地图片字节传来,机器人身份(tenant token)上传到飞书素材库,
  // 返回 image_key 供卡片 img 元素 / 图片消息引用。octet-stream,≤5MB。
  app.addContentTypeParser('application/octet-stream', { parseAs: 'buffer', bodyLimit: 5 * 1024 * 1024 + 1024 }, (_req, body, done) => {
    done(null, body)
  })
  app.post('/api/feishu/upload-image', { bodyLimit: 5 * 1024 * 1024 + 1024 }, async (req, reply) => {
    if (!internalTokenOk(req.headers['x-internal-token'])) {
      return reply.code(401).send({ error: 'unauthorized' })
    }
    if (!Buffer.isBuffer(req.body) || req.body.length === 0) {
      return reply.code(400).send({ error: 'invalid_input', message: 'octet-stream image bytes required' })
    }
    try {
      const imageKey = await feishuDocs.uploadImage(req.body)
      return { imageKey }
    } catch (e) {
      return sendFeishuError(reply, e)
    }
  })

  app.get<{ Params: { documentId: string } }>('/api/feishu/docx/:documentId', async (req, reply) => {
    const userId = await requireUserId(req, reply)
    if (!userId) return
    try {
      const token = await getFreshUserAccessToken(userId)
      return await feishuDocs.getDocxMeta(token, req.params.documentId)
    } catch (e) {
      return sendFeishuError(reply, e)
    }
  })

  app.get<{ Params: { documentId: string } }>(
    '/api/feishu/docx/:documentId/blocks',
    async (req, reply) => {
      const userId = await requireUserId(req, reply)
      if (!userId) return
      try {
        const token = await getFreshUserAccessToken(userId)
        return { blocks: await feishuDocs.listDocxBlocks(token, req.params.documentId) }
      } catch (e) {
        return sendFeishuError(reply, e)
      }
    },
  )

  app.get<{ Querystring: { token?: string } }>('/api/feishu/wiki/node', async (req, reply) => {
    const userId = await requireUserId(req, reply)
    if (!userId) return
    const wikiToken = req.query.token
    if (!wikiToken) return reply.code(400).send({ error: 'invalid_input', message: 'token required' })
    try {
      const token = await getFreshUserAccessToken(userId)
      return await feishuDocs.resolveWikiNode(token, wikiToken)
    } catch (e) {
      return sendFeishuError(reply, e)
    }
  })

  app.get<{ Params: { fileToken: string } }>('/api/feishu/media/:fileToken', async (req, reply) => {
    const userId = await requireUserId(req, reply)
    if (!userId) return
    try {
      const token = await getFreshUserAccessToken(userId)
      const { bytes, mime } = await feishuDocs.downloadMedia(token, req.params.fileToken)
      reply.header('content-type', mime)
      return reply.send(bytes)
    } catch (e) {
      return sendFeishuError(reply, e)
    }
  })

  app.get<{ Params: { whiteboardId: string } }>('/api/feishu/board/:whiteboardId/image', async (req, reply) => {
    const userId = await requireUserId(req, reply)
    if (!userId) return
    try {
      const token = await getFreshUserAccessToken(userId)
      const { bytes, mime } = await feishuDocs.downloadWhiteboardImage(token, req.params.whiteboardId)
      reply.header('content-type', mime)
      return reply.send(bytes)
    } catch (e) {
      return sendFeishuError(reply, e)
    }
  })

  app.get<{ Params: { whiteboardId: string } }>('/api/feishu/board/:whiteboardId/nodes', async (req, reply) => {
    const userId = await requireUserId(req, reply)
    if (!userId) return
    try {
      const token = await getFreshUserAccessToken(userId)
      return { nodes: await feishuDocs.getWhiteboardNodes(token, req.params.whiteboardId) }
    } catch (e) {
      return sendFeishuError(reply, e)
    }
  })

  app.get<{ Params: { appToken: string; tableId: string } }>(
    '/api/feishu/bitable/:appToken/:tableId/fields',
    async (req, reply) => {
      const userId = await requireUserId(req, reply)
      if (!userId) return
      try {
        const token = await getFreshUserAccessToken(userId)
        return { fields: await feishuDocs.listBitableFields(token, req.params.appToken, req.params.tableId) }
      } catch (e) {
        return sendFeishuError(reply, e)
      }
    },
  )

  app.get<{ Params: { appToken: string; tableId: string } }>(
    '/api/feishu/bitable/:appToken/:tableId/records',
    async (req, reply) => {
      const userId = await requireUserId(req, reply)
      if (!userId) return
      try {
        const token = await getFreshUserAccessToken(userId)
        return { records: await feishuDocs.listBitableRecords(token, req.params.appToken, req.params.tableId) }
      } catch (e) {
        return sendFeishuError(reply, e)
      }
    },
  )

  app.get<{ Params: { sheetToken: string; sheetId: string } }>(
    '/api/feishu/sheet/:sheetToken/:sheetId/values',
    async (req, reply) => {
      const userId = await requireUserId(req, reply)
      if (!userId) return
      try {
        const token = await getFreshUserAccessToken(userId)
        return { values: await feishuDocs.readSheetRange(token, req.params.sheetToken, req.params.sheetId) }
      } catch (e) {
        return sendFeishuError(reply, e)
      }
    },
  )

  // POST /api/feishu/notify — INTERNAL app→app endpoint (NOT user-session
  // authed). Client apps call this to push a bot interactive card
  // to a user by open_id (ou_*) OR to a chat by chat_id (oc_*,机器人须在群里;
  // 群通知如「角色 Skill 已更新」走这条)。Guarded by the shared
  // INTERNAL_API_TOKEN; the bot sends with tenant_access_token
  // (im:message:send_as_bot), so no per-user token is involved here.
  app.post<{ Body: { openId?: string; chatId?: string; card?: unknown } }>('/api/feishu/notify', async (req, reply) => {
    if (!internalTokenOk(req.headers['x-internal-token'])) {
      return reply.code(401).send({ error: 'unauthorized' })
    }
    const { openId, chatId } = req.body ?? {}
    const card = req.body?.card
    const validOpen = typeof openId === 'string' && openId.startsWith('ou_')
    const validChat = typeof chatId === 'string' && chatId.startsWith('oc_')
    if (Number(validOpen) + Number(validChat) !== 1) {
      return reply.code(400).send({ error: 'invalid_input', message: 'exactly one of openId(ou_*) / chatId(oc_*) required' })
    }
    if (!validCard(card)) {
      return reply.code(400).send({ error: 'invalid_input', message: 'invalid card payload' })
    }
    try {
      const messageId = validChat
        ? await feishuDocs.sendInteractiveCardToChat(chatId as string, card)
        : await feishuDocs.sendInteractiveCard(openId as string, card)
      return { messageId }
    } catch (e) {
      return sendFeishuError(reply, e)
    }
  })

  // POST /api/feishu/reply — INTERNAL app→app: reply to a RECEIVED message
  // (message_id; references/quotes it) with a bot interactive card. Used by the
  // group-QA reactive answerer (the bot backend decides → asks us to reply). Same
  // INTERNAL_API_TOKEN guard + validCard as /notify; reply uses the existing
  // im:message:send_as_bot scope (no extra permission).
  app.post<{ Body: { messageId?: string; card?: unknown } }>('/api/feishu/reply', async (req, reply) => {
    if (!internalTokenOk(req.headers['x-internal-token'])) {
      return reply.code(401).send({ error: 'unauthorized' })
    }
    const messageId = req.body?.messageId
    const card = req.body?.card
    if (typeof messageId !== 'string' || !messageId.startsWith('om_')) {
      return reply.code(400).send({ error: 'invalid_input', message: 'messageId(om_*) required' })
    }
    if (!validCard(card)) {
      return reply.code(400).send({ error: 'invalid_input', message: 'invalid card payload' })
    }
    try {
      const replyMessageId = await feishuDocs.replyCard(messageId, card)
      return { messageId: replyMessageId }
    } catch (e) {
      return sendFeishuError(reply, e)
    }
  })

  // POST /api/feishu/reaction — INTERNAL app→app: add an emoji reaction ("like")
  // to a RECEIVED message (message_id) AS THE BOT. Used by group-QA to 👍 a good
  // group message. Same INTERNAL_API_TOKEN guard. Unlike reply/notify (which use
  // the send scope), reactions need the bot's tenant-identity scope
  // `im:message.reactions:write_only`(发送、删除消息表情回复)— enable it and
  // PUBLISH A NEW APP VERSION or this 403s.
  app.post<{ Body: { messageId?: string; emojiType?: string } }>('/api/feishu/reaction', async (req, reply) => {
    if (!internalTokenOk(req.headers['x-internal-token'])) {
      return reply.code(401).send({ error: 'unauthorized' })
    }
    const messageId = req.body?.messageId
    const emojiType = req.body?.emojiType
    if (typeof messageId !== 'string' || !messageId.startsWith('om_')) {
      return reply.code(400).send({ error: 'invalid_input', message: 'messageId(om_*) required' })
    }
    // emoji_type is a fixed Feishu enum (THUMBSUP/HEART/…). Restrict to the
    // uppercase-letter shape so the internal endpoint can't be coerced into
    // sending arbitrary payloads; Feishu validates the concrete enum.
    if (typeof emojiType !== 'string' || !/^[A-Z_]{1,32}$/.test(emojiType)) {
      return reply.code(400).send({ error: 'invalid_input', message: 'emojiType (A-Z_) required' })
    }
    try {
      await feishuDocs.addReaction(messageId, emojiType)
      return { ok: true }
    } catch (e) {
      return sendFeishuError(reply, e)
    }
  })
}
