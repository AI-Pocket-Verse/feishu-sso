import {
  createFeishuProvider,
  createFeishuDocsClient,
  type FeishuProvider,
} from '@feishu-sso/auth-provider-feishu'

import { env } from './env'

const requestedScopes = env.FEISHU_SCOPES.split(/\s+/).filter(Boolean)

export const feishu: FeishuProvider = createFeishuProvider({
  appId: env.FEISHU_APP_ID,
  appSecret: env.FEISHU_APP_SECRET,
  redirectUri: env.FEISHU_REDIRECT_URI,
  scopes: requestedScopes,
})

/** Scopes we *asked* Feishu for. This requested set (NOT the granted
 *  `tokens.scope`) is what gets persisted to user.scopes at login — it is the
 *  baseline for the scope-change re-login gate. See routes/feishu.ts (where it's
 *  stored) and src/scopes.ts (why requested, not granted, avoids a login loop). */
export const requestedScopesStr = requestedScopes.join(' ')

/** Document-reading client (docx/wiki/media), used by the feishu-docs gateway
 *  routes. Acts as the calling user via their user_access_token — so Feishu
 *  enforces view permission. Same app credentials as the login provider. */
export const feishuDocs = createFeishuDocsClient({
  appId: env.FEISHU_APP_ID,
  appSecret: env.FEISHU_APP_SECRET,
})
