/**
 * @feishu-sso/auth-provider-feishu — document-domain methods.
 *
 * Keeps ALL Feishu doc-reading SDK usage in this one package (same invariant
 * as the auth provider): client apps consume these via the api's doc gateway,
 * never the SDK directly. Doc methods take a user_access_token and act as that
 * user, so Feishu enforces view permission for us (403 → no access).
 *
 * NOTE: the SDK method paths below (docx.v1.documentBlock.list, etc.) match the
 * @larksuiteoapi/node-sdk version pinned in package.json; re-check on upgrade.
 */
import { createHash } from 'node:crypto'
import * as lark from '@larksuiteoapi/node-sdk'

import { sdkDomain, type FeishuDomain } from './domain'

export interface FeishuDocsConfig {
  appId: string
  appSecret: string
  /** 飞书中国版（默认）或国际版 Lark。 */
  domain?: FeishuDomain
}

/** Pure: flatten paginated block responses into one ordered array. */
export function mergeBlockPages(pages: Array<{ items?: unknown[] }>): unknown[] {
  const out: unknown[] = []
  for (const p of pages) if (Array.isArray(p.items)) out.push(...p.items)
  return out
}

export interface FeishuDocsClient {
  getDocxMeta: (token: string, documentId: string) => Promise<{ title: string }>
  listDocxBlocks: (token: string, documentId: string) => Promise<unknown[]>
  resolveWikiNode: (token: string, wikiToken: string) => Promise<{ objType: string; objToken: string }>
  downloadMedia: (token: string, fileToken: string) => Promise<{ bytes: Buffer; mime: string }>
  /** Render a whiteboard (画板) as a PNG image (board/v1 download_as_image). */
  downloadWhiteboardImage: (token: string, whiteboardId: string) => Promise<{ bytes: Buffer; mime: string }>
  /** Raw whiteboard nodes (board/v1 whiteboard-node list) — used to extract a
   *  Mermaid/diagram source when the board was drawn with diagram syntax. */
  getWhiteboardNodes: (token: string, whiteboardId: string) => Promise<Array<Record<string, unknown>>>
  /** Ordered field names of a Bitable table (used as GFM table headers). */
  listBitableFields: (token: string, appToken: string, tableId: string) => Promise<string[]>
  /** All records' field maps of a Bitable table (paginated, hard-capped). */
  listBitableRecords: (
    token: string,
    appToken: string,
    tableId: string,
  ) => Promise<Array<Record<string, unknown>>>
  /** Cell-value matrix of a Sheet range (sheets v2 values read). */
  readSheetRange: (token: string, sheetToken: string, sheetId: string) => Promise<unknown[][]>
  /**
   * Send an interactive card to a user by open_id, AS THE BOT. Unlike the
   * doc-reading methods this does NOT pass a user_access_token — the SDK mints
   * a tenant_access_token from the app credentials, so it requires the
   * `im:message:send_as_bot` (tenant) scope + an enabled bot. Returns the
   * Feishu message_id.
   */
  sendInteractiveCard: (openId: string, card: unknown) => Promise<string>
  /** Send an interactive card to a chat (chat_id; p2p or group) AS THE BOT.
   *  Returns the Feishu message_id. */
  sendInteractiveCardToChat: (chatId: string, card: unknown) => Promise<string>
  /** Update an already-sent interactive card (message_id) AS THE BOT — used for
   *  the streaming "typewriter" effect (patch the card as tokens arrive). */
  updateInteractiveCard: (messageId: string, card: unknown) => Promise<void>
  /** Reply to a RECEIVED message (message_id) with an interactive card AS THE BOT
   *  — references/quotes the original message. Uses the send scope
   *  (`im:message:send_as_bot`); no permission beyond sending is needed. Returns
   *  the new reply message_id. */
  replyCard: (messageId: string, card: unknown) => Promise<string>
  /** Add an emoji reaction to a RECEIVED message (message_id) AS THE BOT — the
   *  bot "likes" a good group message. POST /im/v1/messages/:id/reactions with a
   *  fixed emoji_type (e.g. THUMBSUP). Requires the bot's tenant-identity scope
   *  `im:message.reactions:write_only`(发送、删除消息表情回复)+ an enabled bot.
   *  Not double-liking the same message is the caller's
   *  job (the bot backend dedups by message_id). Returns nothing (fire-and-forget). */
  addReaction: (messageId: string, emojiType: string) => Promise<void>
  /** This bot's own open_id (GET /bot/v3/info, tenant token). Lets the group
   *  handler tell whether a group message actually @-mentioned the bot. */
  getBotOpenId: () => Promise<string>
  /** Download an image/file resource attached to a RECEIVED message (image_key
   *  from an im.message.receive_v1 event), AS THE BOT (tenant token). Requires
   *  the im:resource scope. */
  downloadMessageImage: (messageId: string, fileKey: string) => Promise<{ bytes: Buffer; mime: string }>
  /** Upload an image to Feishu's material store AS THE BOT (tenant token),
   *  returning the image_key usable in interactive-card `img` elements and
   *  image messages. Requires the im:resource scope. */
  uploadImage: (bytes: Buffer) => Promise<string>
}

function unwrap<T>(res: { code?: number; msg?: string; data?: T } | undefined): T {
  if (!res) throw new Error('feishu: empty response')
  if (res.code !== 0 && res.code !== undefined) {
    throw new Error(`feishu: ${res.msg ?? 'unknown error'} (code=${res.code})`)
  }
  if (res.data === undefined) throw new Error('feishu: missing data')
  return res.data
}

/**
 * Surface the REAL Feishu error buried in a thrown SDK/axios error. The SDK
 * throws on non-2xx HTTP with a generic message ("Request failed with status
 * code 400"); the actual `{ code, msg }` lives in `err.response.data`. Without
 * this, callers only see the opaque axios message and can't classify the
 * failure (scope / permission / bad request).
 */
export function describeFeishuError(err: unknown): Error {
  const e = err as {
    response?: { status?: number; data?: { code?: number; msg?: string } }
    message?: string
  }
  const data = e?.response?.data
  if (data && (data.code !== undefined || data.msg)) {
    const status = e.response?.status
    return new Error(`feishu: ${data.msg ?? 'error'} (code=${data.code ?? '?'}${status ? `, http=${status}` : ''})`)
  }
  return err instanceof Error ? err : new Error(String(err))
}

// The node-sdk binary endpoints (media download, whiteboard image) return a
// helper exposing a readable stream + response headers. Drain it to a Buffer.
async function collectBinary(res: unknown, fallbackMime: string): Promise<{ bytes: Buffer; mime: string }> {
  const r = res as { getReadableStream?: () => NodeJS.ReadableStream; headers?: Record<string, string> }
  const stream = r.getReadableStream?.()
  if (!stream) throw new Error('feishu: binary download returned no stream')
  const chunks: Buffer[] = []
  for await (const c of stream) chunks.push(Buffer.from(c))
  return { bytes: Buffer.concat(chunks), mime: r.headers?.['content-type'] ?? fallbackMime }
}

// Feishu resource tokens are alphanumeric; reject anything else before it
// reaches a raw request URL.
const SAFE_TOKEN = /^[A-Za-z0-9]+$/

export function createFeishuDocsClient(cfg: FeishuDocsConfig): FeishuDocsClient {
  const client = new lark.Client({
    appId: cfg.appId,
    appSecret: cfg.appSecret,
    appType: lark.AppType.SelfBuild,
    domain: sdkDomain(cfg.domain),
  })

  const getDocxMeta: FeishuDocsClient['getDocxMeta'] = async (token, documentId) => {
    try {
      const res = await client.docx.v1.document.get(
        { path: { document_id: documentId } },
        lark.withUserAccessToken(token),
      )
      const data = unwrap(res) as { document?: { title?: string } }
      return { title: data.document?.title ?? '' }
    } catch (err) {
      throw describeFeishuError(err)
    }
  }

  const listDocxBlocks: FeishuDocsClient['listDocxBlocks'] = async (token, documentId) => {
    try {
      const pages: Array<{ items?: unknown[] }> = []
      let pageToken: string | undefined
      do {
        const res = await client.docx.v1.documentBlock.list(
          {
            path: { document_id: documentId },
            params: { page_size: 500, document_revision_id: -1, page_token: pageToken },
          },
          lark.withUserAccessToken(token),
        )
        const data = unwrap(res) as { items?: unknown[]; has_more?: boolean; page_token?: string }
        pages.push({ items: data.items })
        pageToken = data.has_more ? data.page_token : undefined
      } while (pageToken)
      return mergeBlockPages(pages)
    } catch (err) {
      throw describeFeishuError(err)
    }
  }

  const resolveWikiNode: FeishuDocsClient['resolveWikiNode'] = async (token, wikiToken) => {
    try {
      const res = await client.wiki.v2.space.getNode(
        { params: { token: wikiToken, obj_type: 'wiki' } },
        lark.withUserAccessToken(token),
      )
      const data = unwrap(res) as { node?: { obj_type?: string; obj_token?: string } }
      return { objType: data.node?.obj_type ?? '', objToken: data.node?.obj_token ?? '' }
    } catch (err) {
      throw describeFeishuError(err)
    }
  }

  const downloadMedia: FeishuDocsClient['downloadMedia'] = async (token, fileToken) => {
    try {
      const res = await client.drive.v1.media.download(
        { path: { file_token: fileToken } },
        lark.withUserAccessToken(token),
      )
      return await collectBinary(res, 'application/octet-stream')
    } catch (err) {
      throw describeFeishuError(err)
    }
  }

  const downloadWhiteboardImage: FeishuDocsClient['downloadWhiteboardImage'] = async (token, whiteboardId) => {
    try {
      const res = await client.board.v1.whiteboard.downloadAsImage(
        { path: { whiteboard_id: whiteboardId } },
        lark.withUserAccessToken(token),
      )
      return await collectBinary(res, 'image/png')
    } catch (err) {
      throw describeFeishuError(err)
    }
  }

  const getWhiteboardNodes: FeishuDocsClient['getWhiteboardNodes'] = async (token, whiteboardId) => {
    try {
      const res = await client.board.v1.whiteboardNode.list(
        { path: { whiteboard_id: whiteboardId } },
        lark.withUserAccessToken(token),
      )
      const data = unwrap(res) as { items?: Array<Record<string, unknown>> }
      return data.items ?? []
    } catch (err) {
      throw describeFeishuError(err)
    }
  }

  const listBitableFields: FeishuDocsClient['listBitableFields'] = async (token, appToken, tableId) => {
    try {
      const res = await client.bitable.v1.appTableField.list(
        { path: { app_token: appToken, table_id: tableId }, params: { page_size: 200 } },
        lark.withUserAccessToken(token),
      )
      const data = unwrap(res) as { items?: Array<{ field_name?: string }> }
      return (data.items ?? []).map((f) => String(f.field_name ?? ''))
    } catch (err) {
      throw describeFeishuError(err)
    }
  }

  const listBitableRecords: FeishuDocsClient['listBitableRecords'] = async (token, appToken, tableId) => {
    try {
      // Use the table's first view so the imported row order matches what the
      // user sees in Feishu (records.list is otherwise creation-ordered).
      let viewId: string | undefined
      try {
        const vres = await client.bitable.v1.appTableView.list(
          { path: { app_token: appToken, table_id: tableId }, params: { page_size: 1 } },
          lark.withUserAccessToken(token),
        )
        viewId = (unwrap(vres) as { items?: Array<{ view_id?: string }> }).items?.[0]?.view_id
      } catch {
        // no view access → default (unordered) record listing
      }
      const out: Array<Record<string, unknown>> = []
      let pageToken: string | undefined
      do {
        const res = await client.bitable.v1.appTableRecord.list(
          { path: { app_token: appToken, table_id: tableId }, params: { page_size: 500, page_token: pageToken, view_id: viewId } },
          lark.withUserAccessToken(token),
        )
        const data = unwrap(res) as {
          items?: Array<{ fields?: Record<string, unknown> }>
          has_more?: boolean
          page_token?: string
        }
        for (const it of data.items ?? []) out.push(it.fields ?? {})
        pageToken = data.has_more ? data.page_token : undefined
      } while (pageToken && out.length < 250) // cap fetch ~one page (route shows ≤200)
      return out
    } catch (err) {
      throw describeFeishuError(err)
    }
  }

  const readSheetRange: FeishuDocsClient['readSheetRange'] = async (token, sheetToken, sheetId) => {
    try {
      // sheets/v2 values read isn't a typed SDK method → use the generic request.
      // Validate tokens (they originate from arbitrary doc content) so a crafted
      // token can't inject extra path/query segments into the request URL.
      if (!SAFE_TOKEN.test(sheetToken) || !SAFE_TOKEN.test(sheetId)) {
        throw new Error('feishu: invalid sheet token')
      }
      const range = `${sheetId}!A1:Z200`
      const res = await client.request(
        { method: 'GET', url: `/open-apis/sheets/v2/spreadsheets/${encodeURIComponent(sheetToken)}/values/${encodeURIComponent(range)}` },
        lark.withUserAccessToken(token),
      )
      const data = unwrap(res as { code?: number; msg?: string; data?: unknown }) as {
        valueRange?: { values?: unknown[][] }
      }
      return data.valueRange?.values ?? []
    } catch (err) {
      throw describeFeishuError(err)
    }
  }

  const sendInteractiveCard: FeishuDocsClient['sendInteractiveCard'] = async (openId, card) => {
    try {
      // No withUserAccessToken → SDK uses tenant_access_token (the bot).
      const res = await client.im.message.create({
        params: { receive_id_type: 'open_id' },
        data: { receive_id: openId, msg_type: 'interactive', content: JSON.stringify(card) },
      })
      const data = unwrap(res as { code?: number; msg?: string; data?: { message_id?: string } })
      const id = data?.message_id
      if (!id) throw new Error('feishu: im.message.create returned no message_id')
      return id
    } catch (err) {
      throw describeFeishuError(err)
    }
  }

  const sendInteractiveCardToChat: FeishuDocsClient['sendInteractiveCardToChat'] = async (chatId, card) => {
    try {
      // No withUserAccessToken → SDK uses tenant_access_token (the bot).
      const res = await client.im.message.create({
        params: { receive_id_type: 'chat_id' },
        data: { receive_id: chatId, msg_type: 'interactive', content: JSON.stringify(card) },
      })
      const data = unwrap(res as { code?: number; msg?: string; data?: { message_id?: string } })
      const id = data?.message_id
      if (!id) throw new Error('feishu: im.message.create returned no message_id')
      return id
    } catch (err) {
      throw describeFeishuError(err)
    }
  }

  const updateInteractiveCard: FeishuDocsClient['updateInteractiveCard'] = async (messageId, card) => {
    try {
      // PATCH /im/v1/messages/:message_id — replace the interactive card content.
      await client.im.message.patch({
        path: { message_id: messageId },
        data: { content: JSON.stringify(card) },
      })
    } catch (err) {
      throw describeFeishuError(err)
    }
  }

  const replyCard: FeishuDocsClient['replyCard'] = async (messageId, card) => {
    try {
      // POST /im/v1/messages/:message_id/reply — reply to (and reference) the
      // original message AS THE BOT. interactive card is a supported reply body.
      // uuid (idempotency) is derived from the parent id so a redelivered event
      // can't double-post the same answer.
      const uuid = createHash('sha256').update(messageId).digest('hex').slice(0, 32)
      const res = await client.im.message.reply({
        path: { message_id: messageId },
        data: { msg_type: 'interactive', content: JSON.stringify(card), uuid },
      })
      const data = unwrap(res as { code?: number; msg?: string; data?: { message_id?: string } })
      const id = data?.message_id
      if (!id) throw new Error('feishu: im.message.reply returned no message_id')
      return id
    } catch (err) {
      throw describeFeishuError(err)
    }
  }

  const downloadMessageImage: FeishuDocsClient['downloadMessageImage'] = async (messageId, fileKey) => {
    try {
      // No withUserAccessToken → tenant token(机器人身份读自己收到的消息资源)。
      const res = await client.im.messageResource.get({
        path: { message_id: messageId, file_key: fileKey },
        params: { type: 'image' },
      })
      return await collectBinary(res, 'image/png')
    } catch (err) {
      throw describeFeishuError(err)
    }
  }

  const uploadImage: FeishuDocsClient['uploadImage'] = async (bytes) => {
    try {
      // tenant token(无 withUserAccessToken)。注意:本 SDK 版本里 im.image.create 直接
      // 返回 { image_key }(不是 {code,msg,data} 信封),所以【不能走 unwrap】—— 否则
      // res.data 恒为 undefined,被误报为「missing data」(上传其实已成功)。两种形状都兼容。
      const res = (await client.im.image.create({
        data: { image_type: 'message', image: bytes },
      })) as { image_key?: string; data?: { image_key?: string } }
      const key = res?.image_key ?? res?.data?.image_key
      if (!key) throw new Error('feishu: im.image.create returned no image_key')
      return key
    } catch (err) {
      throw describeFeishuError(err)
    }
  }

  const addReaction: FeishuDocsClient['addReaction'] = async (messageId, emojiType) => {
    try {
      // POST /im/v1/messages/:message_id/reactions — tenant token(机器人身份点赞)。
      // 用 raw request(同 getBotOpenId / readSheetRange),不依赖 SDK 版本是否暴露
      // messageReaction.create 的类型定义。emoji_type 为飞书固定枚举(如 THUMBSUP)。
      await client.request({
        method: 'POST',
        url: `/open-apis/im/v1/messages/${encodeURIComponent(messageId)}/reactions`,
        data: { reaction_type: { emoji_type: emojiType } },
      })
    } catch (err) {
      throw describeFeishuError(err)
    }
  }

  const getBotOpenId: FeishuDocsClient['getBotOpenId'] = async () => {
    try {
      // No withUserAccessToken → tenant token. /bot/v3/info returns the bot
      // object at the TOP level (sibling of code/msg), not under `data`.
      const res = await client.request({ method: 'GET', url: '/open-apis/bot/v3/info' })
      const openId = (res as { bot?: { open_id?: string } })?.bot?.open_id
      if (!openId) throw new Error('feishu: bot info returned no open_id')
      return openId
    } catch (err) {
      throw describeFeishuError(err)
    }
  }

  return {
    getDocxMeta,
    listDocxBlocks,
    resolveWikiNode,
    downloadMedia,
    downloadWhiteboardImage,
    getWhiteboardNodes,
    listBitableFields,
    listBitableRecords,
    readSheetRange,
    sendInteractiveCard,
    sendInteractiveCardToChat,
    updateInteractiveCard,
    replyCard,
    addReaction,
    getBotOpenId,
    downloadMessageImage,
    uploadImage,
  }
}
