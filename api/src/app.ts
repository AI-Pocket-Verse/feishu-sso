import type { IncomingMessage } from 'node:http'
import { resolve } from 'node:path'

import cookie from '@fastify/cookie'
import cors from '@fastify/cors'
import rateLimit from '@fastify/rate-limit'
import fastifyStatic from '@fastify/static'
import Fastify from 'fastify'

import apiKit from '@feishu-sso/api-kit'

import { env } from './env'
import { feishuRoutes } from './routes/feishu'
import { feishuDocsRoutes } from './routes/feishu-docs'
import { feishuEventsRoutes } from './routes/feishu-events'
import { sessionRoutes } from './routes/session'
import { siteRoutes } from './routes/site'
import { whoamiRoutes } from './routes/whoami'

// 只给本机业务服务调用的内部接口。nginx 部署时由 nginx 对公网返回 404；
// 单端口模式下没有 nginx 这一层，由 rewriteUrl 不改写它们、最终落到 404。
const INTERNAL_PUBLIC_PATH = /^\/auth\/api\/feishu\/(notify|reply|reaction|upload-image)\/?(\?|$)/

/** 单端口模式：/auth/api/* → /api/*，与 nginx 片段的 proxy_pass 一致；内部接口保持原样（→ 404）。 */
export function rewriteSinglePortUrl(url: string): string {
  if (!url.startsWith('/auth/api/') || INTERNAL_PUBLIC_PATH.test(url)) return url
  return url.slice('/auth'.length)
}

/** 组装 Fastify 实例（插件、钩子、路由）。监听端口和后台任务由 index.ts 负责。 */
export async function buildApp() {
  // trustProxy 决定 req.ip / req.host / req.protocol 信不信 X-Forwarded-* 头：
  // 默认只信任本机回环的反向代理，限流才能按真实客户端 IP 分桶。
  const app = Fastify({
    logger: { level: env.NODE_ENV === 'development' ? 'info' : 'warn' },
    trustProxy: env.TRUST_PROXY,
    rewriteUrl: env.WEB_DIST_DIR ? (req: IncomingMessage) => rewriteSinglePortUrl(req.url ?? '/') : undefined,
  })

  const corsOrigins = env.CORS_ORIGINS.split(/\s+/).filter(Boolean)
  await app.register(cors, {
    origin: corsOrigins.length > 0 ? corsOrigins : false,
    credentials: true,
  })
  // 按 req.ip 分桶（已信任代理时是真实客户端 IP）；各客户端互不影响。
  await app.register(rateLimit, { max: 200, timeWindow: '1 minute' })
  await app.register(cookie)
  await app.register(apiKit, { service: 'feishu-sso', version: '1.0.0' })

  // CSRF guard for state-changing auth mutations (POST /api/logout,
  // /api/session/touch, and any future non-GET). A browser cannot attach a
  // forged Origin header to a cross-site request, so when an Origin is present
  // it must match an allowed origin (the configured CORS origins or this
  // request's own origin). Absent Origin (server-to-server, health probes,
  // non-browser clients) falls through.
  // GET/HEAD/OPTIONS are exempt (CORS preflight + the OAuth GET redirect from
  // Feishu must pass).
  app.addHook('onRequest', async (req, reply) => {
    if (req.method === 'GET' || req.method === 'HEAD' || req.method === 'OPTIONS') return
    const origin = (req.headers['origin'] ?? '').toString()
    if (!origin) return
    const allowed = new Set<string>(corsOrigins)
    // 本服务自己的 origin 按 trustProxy 还原（req.protocol / req.host）：只有受信任的反向代理
    // 带来的 X-Forwarded-* 才算数，直连客户端自带的转发头不能把任意 Origin 变成「同源」。
    if (req.host) allowed.add(`${req.protocol}://${req.host}`)
    if (!allowed.has(origin)) {
      return reply.code(403).send({ error: 'csrf', message: 'Cross-site request rejected' })
    }
  })

  await app.register(feishuRoutes)
  await app.register(feishuDocsRoutes)
  await app.register(feishuEventsRoutes)
  await app.register(whoamiRoutes)
  await app.register(sessionRoutes)
  await app.register(siteRoutes)

  // 单端口模式：托管登录页，/auth/login 等前端路径回退 index.html；其余未知路径 404。
  if (env.WEB_DIST_DIR) {
    await app.register(fastifyStatic, { root: resolve(env.WEB_DIST_DIR), prefix: '/auth/' })
    app.get('/auth', (_req, reply) => reply.redirect('/auth/'))
    app.setNotFoundHandler((req, reply) => {
      if (req.method === 'GET' && req.url.startsWith('/auth/') && !req.url.startsWith('/auth/api/')) {
        return reply.sendFile('index.html')
      }
      return reply.code(404).send({ error: 'not_found', message: 'Route not found' })
    })
  }

  return app
}
