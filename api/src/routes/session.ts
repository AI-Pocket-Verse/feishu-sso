import type { FastifyPluginAsync } from 'fastify'

import { clearSessionCookie, setSessionCookie } from '../cookies'
import { env } from '../env'
import { destroySession, loadActiveSession, touchSession } from '../session'

export const sessionRoutes: FastifyPluginAsync = async (app) => {
  app.post('/api/logout', async (req, reply) => {
    const sid = req.cookies?.[env.SESSION_COOKIE_NAME]
    if (sid) await destroySession(sid)
    clearSessionCookie(reply)
    return reply.code(204).send()
  })

  app.post('/api/session/touch', async (req, reply) => {
    const sid = req.cookies?.[env.SESSION_COOKIE_NAME]
    // 只给仍然有效的会话续期：已过期、被禁用或需要重新登录的会话不能靠 touch 复活。
    const loaded = sid ? await loadActiveSession(sid) : null
    if (sid && loaded) {
      await touchSession(sid)
      setSessionCookie(reply, sid, loaded.session.remember_me)
    }
    return reply.code(204).send()
  })
}
