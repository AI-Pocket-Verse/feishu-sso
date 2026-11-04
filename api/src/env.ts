import { z } from 'zod'

import { DEV_INTERNAL_TOKEN, checkInternalToken, parseTrustProxy } from './env-checks'

export { DEV_INTERNAL_TOKEN }

// 可选项留空（`X=`）当作未设置，否则 .env 里写了空值的可选 URL 会让校验失败。
const emptyAsUndefined = (v: unknown) => (v === '' ? undefined : v)

const RegexList = z
  .string()
  .default('')
  .transform((s) =>
    s
      .split(/\s+/)
      .map((piece) => piece.trim())
      .filter(Boolean)
      .map((pattern) => new RegExp(pattern)),
  )

const Env = z.object({
  NODE_ENV: z.enum(['development', 'production', 'test']).default('development'),
  PORT: z.coerce.number().default(4020),
  // 默认只监听本机，由同机的反向代理对外提供服务。
  HOST: z.string().default('127.0.0.1'),
  // 信任哪些反向代理的 X-Forwarded-* 头（传给 Fastify trustProxy）：loopback、
  // 逗号分隔的 IP / CIDR，或 true / false（不支持跳数）。默认只信任本机回环的代理。
  TRUST_PROXY: z
    .string()
    .default('loopback')
    .transform((v, ctx) => {
      try {
        return parseTrustProxy(v)
      } catch (e) {
        ctx.addIssue({ code: 'custom', message: (e as Error).message })
        return z.NEVER
      }
    }),
  // 登录页展示的站点名；留空时登录页按界面语言显示默认名（统一登录 / Single Sign-On）
  SITE_NAME: z.preprocess(emptyAsUndefined, z.string().optional()),
  // 飞书机器人卡片里的助手称呼
  ASSISTANT_NAME: z.preprocess(emptyAsUndefined, z.string().default('AI')),
  // 机器人卡片与按钮提示的语言。服务端看不到提问人的界面语言，所以由部署方指定
  BOT_LANG: z.preprocess(emptyAsUndefined, z.enum(['zh', 'en']).default('zh')),

  // Feishu。FEISHU_DOMAIN 选择飞书中国版（feishu）或国际版 Lark（lark）
  FEISHU_DOMAIN: z.preprocess(emptyAsUndefined, z.enum(['feishu', 'lark']).default('feishu')),
  FEISHU_APP_ID: z.string().min(1, 'FEISHU_APP_ID required'),
  FEISHU_APP_SECRET: z.string().min(1, 'FEISHU_APP_SECRET required'),
  FEISHU_REDIRECT_URI: z.string().url(),
  FEISHU_SCOPES: z.string().default(''),

  // Session & cookie
  SESSION_COOKIE_NAME: z.string().default('sso_session'),
  SESSION_COOKIE_DOMAIN: z.string().optional().default(''),
  // Parsed below — default derived from NODE_ENV after the schema runs.
  SESSION_COOKIE_SECURE: z.string().optional(),
  SESSION_COOKIE_SAMESITE: z.enum(['lax', 'strict', 'none']).default('lax'),
  SESSION_TTL_DAYS: z.coerce.number().default(30),
  SESSION_REMEMBER_TTL_DAYS: z.coerce.number().default(30),
  SESSION_SLIDING: z
    .string()
    .default('true')
    .transform((v) => v.toLowerCase() === 'true'),

  // Security
  AUTH_DATA_KEY: z.string().min(1, 'AUTH_DATA_KEY required (base64 32 bytes)'),
  // Patterns that match URL-encoded forms of return_to. Same-origin absolute
  // paths (`^/[^/]`) are always accepted in safeReturnTo() regardless of this
  // list — this is just for cross-origin destinations.
  ALLOWED_RETURN_TO: RegexList,
  STATE_TTL_SECONDS: z.coerce.number().default(300),
  // Space-separated allowed CORS origins. Empty = same-origin only (reverse-proxy mode).
  CORS_ORIGINS: z.string().default(''),

  // Token refresh worker
  REFRESH_LOOKAHEAD_MINUTES: z.coerce.number().default(10),
  REFRESH_INTERVAL_MINUTES: z.coerce.number().default(30),

  // 服务间调用的共享口令：业务服务调 /api/feishu/notify 等内部接口时带上它，
  // 本服务调对话后端（BOT_BACKEND_URL）时也带上它。两边必须配置成同一个值。
  INTERNAL_API_TOKEN: z.string().default(DEV_INTERNAL_TOKEN),

  // Feishu event subscription (bot inbound, /api/feishu/events). Empty encrypt
  // key = plaintext mode; set both to the values from the Feishu console when
  // encryption is enabled.
  FEISHU_EVENT_ENCRYPT_KEY: z.string().default(''),
  FEISHU_EVENT_VERIFICATION_TOKEN: z.string().default(''),
  // 机器人的对话后端（如 team-knowledge）内网地址。不设置时机器人只回复「未接入」，
  // 登录、通知、读文档等其余能力不受影响。协议见 docs/bot-backend.md。
  // 末尾的 / 会去掉，避免拼出 //api/...
  BOT_BACKEND_URL: z.preprocess(
    emptyAsUndefined,
    z
      .string()
      .url()
      .optional()
      .transform((u) => u?.replace(/\/+$/, '')),
  ),

  // 单端口模式（Docker）：设置后 api 同时托管登录页（web/dist）并接受 /auth/api/* 前缀，
  // 前面的反向代理只需把 /auth/ 整体转发过来。不设置时由 nginx 托管登录页（见 deploy/）。
  WEB_DIST_DIR: z.preprocess(emptyAsUndefined, z.string().optional()),

  // SQLite 路径，相对路径以 prisma/ 目录为基准（由 Prisma 读取，这里只校验已设置）
  DATABASE_URL: z.string().min(1, 'DATABASE_URL required'),
})

const parsed = Env.safeParse(process.env)
if (!parsed.success) {
  console.error('[feishu-sso] invalid env:')
  for (const issue of parsed.error.issues) {
    console.error(`  - ${issue.path.join('.')}: ${issue.message}`)
  }
  process.exit(1)
}

const raw = parsed.data
const tokenCheck = checkInternalToken(raw)
if (tokenCheck.fatal) {
  console.error(`[feishu-sso] ${tokenCheck.fatal}`)
  process.exit(1)
}
if (tokenCheck.warn) console.warn(`[feishu-sso] warning: ${tokenCheck.warn}`)
const secureRaw = raw.SESSION_COOKIE_SECURE
const secure =
  secureRaw === undefined || secureRaw === ''
    ? raw.NODE_ENV !== 'development' // safe-by-default in prod/test
    : secureRaw.toLowerCase() === 'true'

export const env = { ...raw, SESSION_COOKIE_SECURE: secure }
export type Env = typeof env
