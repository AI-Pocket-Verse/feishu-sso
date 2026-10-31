import type { FastifyPluginAsync } from 'fastify'

import { env } from '../env'

/** 登录页展示用的站点信息（公开，不含任何机密）。站点名由 SITE_NAME 配置。 */
export const siteRoutes: FastifyPluginAsync = async (app) => {
  app.get('/api/site', async () => ({ name: env.SITE_NAME }))
}
