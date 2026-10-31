import { buildApp } from './app'
import { initDb, prisma } from './db'
import { env } from './env'
import { startTokenRefreshWorker, stopTokenRefreshWorker } from './workers/token-refresh'

await initDb()

const app = await buildApp()

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
