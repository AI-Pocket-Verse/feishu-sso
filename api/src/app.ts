import cookie from '@fastify/cookie'
import cors from '@fastify/cors'
import rateLimit from '@fastify/rate-limit'
import Fastify from 'fastify'

import apiKit from '@feishu-sso/api-kit'

import { env } from './env'
import { feishuRoutes } from './routes/feishu'
import { feishuDocsRoutes } from './routes/feishu-docs'
import { feishuEventsRoutes } from './routes/feishu-events'
import { sessionRoutes } from './routes/session'
import { siteRoutes } from './routes/site'
import { whoamiRoutes } from './routes/whoami'

/** 组装 Fastify 实例（插件、钩子、路由）。监听端口和后台任务由 index.ts 负责。 */
export async function buildApp() {
  // trustProxy 决定 req.ip / req.host / req.protocol 信不信 X-Forwarded-* 头：
  // 默认只信任本机回环的反向代理，限流才能按真实客户端 IP 分桶。
  const app = Fastify({
    logger: { level: env.NODE_ENV === 'development' ? 'info' : 'warn' },
    trustProxy: env.TRUST_PROXY,
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
    const xfHost = (req.headers['x-forwarded-host'] ?? '').toString().split(',')[0]?.trim()
    const host = xfHost || (req.headers['host'] ?? '').toString()
    if (host) {
      const xfProto = (req.headers['x-forwarded-proto'] ?? '').toString().split(',')[0]?.trim()
      const proto = xfProto || req.protocol || 'http'
      allowed.add(`${proto}://${host}`)
    }
    if (!allowed.has(origin)) {
      return reply.code(403).send({ error: 'csrf', message: '跨站请求被拒绝' })
    }
  })

  await app.register(feishuRoutes)
  await app.register(feishuDocsRoutes)
  await app.register(feishuEventsRoutes)
  await app.register(whoamiRoutes)
  await app.register(sessionRoutes)
  await app.register(siteRoutes)

  return app
}
