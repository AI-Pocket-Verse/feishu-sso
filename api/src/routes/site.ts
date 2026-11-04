import type { FastifyPluginAsync } from 'fastify'

import { env } from '../env'

/**
 * 登录页展示用的站点信息（公开，不含任何机密）。
 * name：SITE_NAME，未配置时为 null，由登录页按界面语言显示默认名；
 * provider：feishu / lark，决定登录按钮上显示「飞书」还是「Lark」。
 */
export const siteRoutes: FastifyPluginAsync = async (app) => {
  app.get('/api/site', async () => ({ name: env.SITE_NAME ?? null, provider: env.FEISHU_DOMAIN }))
}
