/**
 * Simulate a Feishu `im.message.receive_v1` event against the local
 * /api/feishu/events receiver — the daily dev loop without a public tunnel
 * (the console's single event URL can stay pointed at production).
 *
 * Only INBOUND is simulated; OUTBOUND IS REAL: chat_id is a real oc_…, so the
 * thinking card and the streamed answer genuinely appear in that Feishu chat.
 *
 * Matches the server's auth posture from the same env file automatically:
 *   - FEISHU_EVENT_ENCRYPT_KEY set    → body = {encrypt: base64(IV || AES-256-CBC(sha256(key), payload))}
 *   - FEISHU_EVENT_VERIFICATION_TOKEN → carried in header.token
 *   - neither                         → plaintext payload
 *
 * Usage (from api/):
 *   node --env-file=.env.dev scripts/sim-feishu-event.mjs "你好"                      # p2p 私聊
 *   node --env-file=.env.dev scripts/sim-feishu-event.mjs --group "你能做什么"        # 群里 @机器人
 *   node --env-file=.env.dev scripts/sim-feishu-event.mjs --passive "报销流程怎么走?"   # 群里【非@】→ 群聊智能答疑
 *
 * Flags:
 *   --group            group @bot message (fetches the bot's real open_id for the mention)
 *   --passive          group NON-@ message → exercises 群聊智能答疑 (group-qa). To make the
 *                      quote-REPLY actually land (group-qa 引用回复 needs a REAL message_id,
 *                      a fabricated om_… is rejected with 99992354), this first posts a real
 *                      seed message into the chat via im.message.create and drives the event
 *                      with that real id. Pass --message-id to quote an existing message instead.
 *   --message-id <om_…> (passive only) quote this REAL message instead of seeding a new one
 *   --open-id <ou_…>   sender open_id (default: env FEISHU_SIM_OPEN_ID)
 *   --chat-id <oc_…>   target chat    (default: env FEISHU_SIM_CHAT_ID)
 *   --url <http…>      receiver       (default: http://localhost:4020/api/feishu/events)
 */
import { createCipheriv, createHash, randomBytes } from 'node:crypto'

const argv = process.argv.slice(2)
const flags = {}
const positional = []
for (let i = 0; i < argv.length; i++) {
  if (argv[i] === '--group') flags.group = true
  else if (argv[i] === '--passive') flags.passive = true
  else if (argv[i].startsWith('--')) flags[argv[i].slice(2)] = argv[++i]
  else positional.push(argv[i])
}

const text = positional.join(' ') || '你好,这是一条模拟消息,请用一句话自我介绍'
const openId = flags['open-id'] || process.env.FEISHU_SIM_OPEN_ID
const chatId = flags['chat-id'] || process.env.FEISHU_SIM_CHAT_ID
const url = flags.url || 'http://localhost:4020/api/feishu/events'
if (!openId || !chatId) {
  console.error('missing sender/chat id — pass --open-id/--chat-id or set FEISHU_SIM_OPEN_ID/FEISHU_SIM_CHAT_ID in .env.dev (did you pass --env-file?)')
  process.exit(1)
}

// Shared tenant token — used by both the @-mention bot-open_id lookup and the
// --passive seed-message post.
async function getTenantToken() {
  const t = await fetch('https://open.feishu.cn/open-apis/auth/v3/tenant_access_token/internal', {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ app_id: process.env.FEISHU_APP_ID, app_secret: process.env.FEISHU_APP_SECRET }),
  }).then((r) => r.json())
  if (!t.tenant_access_token) throw new Error(`tenant_access_token failed: ${JSON.stringify(t)}`)
  return t.tenant_access_token
}

// Group @-mode mentions must carry the bot's REAL open_id — the receiver checks
// mentions against GET /bot/v3/info, so a made-up id would be silently ignored.
async function fetchBotOpenId(token) {
  const b = await fetch('https://open.feishu.cn/open-apis/bot/v3/info', {
    headers: { authorization: `Bearer ${token}` },
  }).then((r) => r.json())
  if (!b?.bot?.open_id) throw new Error(`bot/v3/info failed: ${JSON.stringify(b)}`)
  return b.bot.open_id
}

// --passive: post a real text message into the chat so group-qa's quote-reply
// has a valid open_message_id to reply to. Returns the real om_… id.
async function seedGroupMessage(token, text) {
  const r = await fetch('https://open.feishu.cn/open-apis/im/v1/messages?receive_id_type=chat_id', {
    method: 'POST',
    headers: { authorization: `Bearer ${token}`, 'content-type': 'application/json' },
    body: JSON.stringify({ receive_id: chatId, msg_type: 'text', content: JSON.stringify({ text }) }),
  }).then((r) => r.json())
  if (!r?.data?.message_id) throw new Error(`im.message.create failed: ${JSON.stringify(r)}`)
  return r.data.message_id
}

const now = Date.now()
let message
if (flags.passive) {
  // 非@群消息:无 mentions。先拿到真 message_id(seed 或外部传入),让引用回复能落地。
  const token = await getTenantToken()
  const messageId = flags['message-id'] || (await seedGroupMessage(token, text))
  if (!flags['message-id']) console.log(`seeded chat message → ${messageId}（机器人代发,供引用回复;quote 气泡会引到它）`)
  message = {
    message_id: messageId,
    chat_id: chatId,
    chat_type: 'group',
    message_type: 'text',
    content: JSON.stringify({ text }), // 不带 @：触发 group-qa 旁听分支
  }
} else if (flags.group) {
  const token = await getTenantToken()
  message = {
    message_id: `om_sim_${now}`,
    chat_id: chatId,
    chat_type: 'group',
    message_type: 'text',
    content: JSON.stringify({ text: `@_user_1 ${text}` }),
    mentions: [{ key: '@_user_1', id: { open_id: await fetchBotOpenId(token) }, name: 'Jeman' }],
  }
} else {
  message = {
    message_id: `om_sim_${now}`,
    chat_id: chatId,
    chat_type: 'p2p',
    message_type: 'text',
    content: JSON.stringify({ text }),
  }
}

const payload = {
  schema: '2.0',
  header: {
    event_id: `sim-${now}`,
    event_type: 'im.message.receive_v1',
    token: process.env.FEISHU_EVENT_VERIFICATION_TOKEN ?? '',
    create_time: String(now),
    tenant_key: 'sim',
    app_id: process.env.FEISHU_APP_ID,
  },
  event: { sender: { sender_id: { open_id: openId }, sender_type: 'user' }, message },
}

// Inverse of @feishu-sso/auth-provider-feishu decryptFeishuEvent:
// base64(IV(16B) || AES-256-CBC(key = sha256(encryptKey), payload)).
function encryptFeishuEvent(plain, encryptKey) {
  const key = createHash('sha256').update(encryptKey).digest()
  const iv = randomBytes(16)
  const cipher = createCipheriv('aes-256-cbc', key, iv)
  return Buffer.concat([iv, cipher.update(plain, 'utf8'), cipher.final()]).toString('base64')
}

const encryptKey = process.env.FEISHU_EVENT_ENCRYPT_KEY
const body = encryptKey ? { encrypt: encryptFeishuEvent(JSON.stringify(payload), encryptKey) } : payload

const res = await fetch(url, {
  method: 'POST',
  headers: { 'content-type': 'application/json' },
  body: JSON.stringify(body),
})
const mode = flags.passive ? 'group 非@(group-qa)' : flags.group ? 'group @bot' : 'p2p'
console.log(`${mode} sim event → ${url}`)
console.log(`mode=${encryptKey ? 'encrypted' : 'plaintext'} token=${process.env.FEISHU_EVENT_VERIFICATION_TOKEN ? 'yes' : 'no'} event_id=sim-${now}`)
console.log(`HTTP ${res.status} ${await res.text()}`)
if (res.status !== 200) process.exit(1)
console.log(flags.passive
  ? 'dispatched — the bot backend decides whether to answer; a 引用回复 card appears in that Feishu chat if it does.'
  : 'dispatched — watch the api log for "dispatch decision"; the real card/answer appears in that Feishu chat.')
