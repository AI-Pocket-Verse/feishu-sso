import type { FastifyPluginAsync } from 'fastify'

import { clearSessionCookie } from '../cookies'
import { env } from '../env'
import { destroySession, touchSession } from '../session'

export const sessionRoutes: FastifyPluginAsync = async (app) => {
  app.post('/api/logout', async (req, reply) => {
    const sid = req.cookies?.[env.SESSION_COOKIE_NAME]
    if (sid) await destroySession(sid)
    clearSessionCookie(reply)
    return reply.code(204).send()
  })

  app.post('/api/session/touch', async (req, reply) => {
    const sid = req.cookies?.[env.SESSION_COOKIE_NAME]
    if (sid) await touchSession(sid)
    return reply.code(204).send()
  })
}
