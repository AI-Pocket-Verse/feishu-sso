import cookie from '@fastify/cookie'
import cors from '@fastify/cors'
import rateLimit from '@fastify/rate-limit'
import Fastify from 'fastify'

import apiKit from '@feishu-sso/api-kit'

import { initDb, prisma } from './db'
import { env } from './env'
import { feishuRoutes } from './routes/feishu'
import { feishuDocsRoutes } from './routes/feishu-docs'
import { feishuEventsRoutes } from './routes/feishu-events'
import { sessionRoutes } from './routes/session'
import { whoamiRoutes } from './routes/whoami'
import { startTokenRefreshWorker, stopTokenRefreshWorker } from './workers/token-refresh'

const app = Fastify({ logger: { level: env.NODE_ENV === 'development' ? 'info' : 'warn' } })

await initDb()

const corsOrigins = env.CORS_ORIGINS.split(/\s+/).filter(Boolean)
await app.register(cors, {
  origin: corsOrigins.length > 0 ? corsOrigins : false,
  credentials: true,
})
await app.register(rateLimit, { max: 200, timeWindow: '1 minute' })
await app.register(cookie)
await app.register(apiKit, { service: 'feishu-sso', version: '1.0.0' })

// CSRF guard for state-changing auth mutations (POST /api/logout,
// /api/session/touch, and any future non-GET). A browser cannot attach a
// forged Origin header to a cross-site request, so when an Origin is present
// it must match an allowed origin (the configured CORS origins or, behind a
// reverse proxy, this request's own forwarded origin). Absent Origin (server-
// to-server, health probes, non-browser clients) falls through.
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

startTokenRefreshWorker(app.log)

const shutdown = async (signal: string) => {
  app.log.info({ signal }, 'shutting down')
  stopTokenRefreshWorker()
  await app.close()
  await prisma.$disconnect()
  process.exit(0)
}
process.once('SIGTERM', () => void shutdown('SIGTERM'))
process.once('SIGINT', () => void shutdown('SIGINT'))

app
  .listen({ port: env.PORT, host: env.HOST })
  .then(() => {
    console.log(`[feishu-sso] listening on http://${env.HOST}:${env.PORT}`)
    console.log(`[feishu-sso] feishu app: ${env.FEISHU_APP_ID}, redirect: ${env.FEISHU_REDIRECT_URI}`)
    const eventAuth = env.FEISHU_EVENT_ENCRYPT_KEY || env.FEISHU_EVENT_VERIFICATION_TOKEN ? 'on' : 'off'
    console.log(`[feishu-sso] bot events: verification ${eventAuth}; chat backend: ${env.BOT_BACKEND_URL ?? 'off (BOT_BACKEND_URL not set)'}`)
  })
  .catch((err) => {
    console.error(err)
    process.exit(1)
  })
