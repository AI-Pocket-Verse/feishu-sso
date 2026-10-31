import { timingSafeEqual } from 'node:crypto'

import type { FastifyPluginAsync } from 'fastify'

import {
  OAUTH_STATE_COOKIE_NAME,
  clearOAuthStateCookie,
  setOAuthStateCookie,
  setSessionCookie,
} from '../cookies'
import { prisma, secretBox } from '../db'
import { feishu, requestedScopesStr } from '../feishu'
import { safeReturnTo } from '../return-to'
import { createSession } from '../session'
import { consumeState, createState } from '../state-store'

/** Constant-time string compare that never throws on length mismatch. */
function safeEqual(a: string, b: string): boolean {
  const ab = Buffer.from(a)
  const bb = Buffer.from(b)
  if (ab.length !== bb.length) return false
  return timingSafeEqual(ab, bb)
}

export const feishuRoutes: FastifyPluginAsync = async (app) => {
  /**
   * Browser hits this when the user clicks "使用飞书登录".
   * We stash return_to + remember_me under a fresh state token, then 302 to
   * Feishu's authorize URL.
   */
  app.get<{ Querystring: { return_to?: string; remember_me?: string } }>(
    '/api/feishu/authorize',
    async (req, reply) => {
      // 与本次请求同源（经 trustProxy 还原后的 scheme + Host）的绝对 URL 也放行。
      const return_to = safeReturnTo(req.query.return_to, `${req.protocol}://${req.host}`)
      // Default to a long-lived (remember) session: the "30天内免登录" toggle was
      // removed and login is always long-lived now, so only an explicit opt-out
      // ("0"/"false") yields a short session. This keeps "stay logged in" from
      // silently depending on every caller remembering to pass remember_me=1.
      const remember_me = req.query.remember_me !== '0' && req.query.remember_me !== 'false'
      const { state, nonce } = createState({ return_to, remember_me })
      // Bind this flow to the initiating browser: the nonce travels in an
      // HttpOnly cookie and must be presented back on /callback alongside the
      // matching `state`. Without it, anyone holding a valid `state` token
      // could complete login as someone else's identity.
      setOAuthStateCookie(reply, nonce)
      return reply.redirect(feishu.getAuthorizeUrl(state))
    },
  )

  /**
   * Feishu redirects the user back here after consent. We exchange the code
   * for tokens + user_info, upsert the User, create a Session, set the cookie,
   * then redirect to the original return_to.
   */
  app.get<{ Querystring: { code?: string; state?: string; error?: string; error_description?: string } }>(
    '/api/feishu/callback',
    async (req, reply) => {
      // Always drop the one-shot OAuth-state cookie once we reach the callback,
      // regardless of outcome — it has served its purpose for this attempt.
      clearOAuthStateCookie(reply)

      if (req.query.error) {
        // Don't reflect the provider's raw error_description into the redirect
        // URL (open-redirect/XSS surface + info leak). Log it, surface a code.
        app.log.warn(
          { error: req.query.error, description: req.query.error_description },
          'feishu authorize returned an error',
        )
        return reply.redirect('/auth/login?error=provider_error')
      }
      const { code, state } = req.query
      if (!code || !state) {
        return reply.redirect('/auth/login?error=missing_params')
      }
      // CSRF / session-fixation guard. consumeState() is one-shot, so the
      // token is burned here regardless of outcome (a leaked/forged `state`
      // can't be replayed). Login only proceeds when the `state` query param
      // resolves AND the per-flow nonce in this browser's HttpOnly cookie
      // matches the one minted at /authorize — binding the flow to the browser
      // that started it, so an attacker can't make a victim complete login
      // under the attacker's Feishu identity.
      const oauthCookie = req.cookies?.[OAUTH_STATE_COOKIE_NAME]
      const ctx = consumeState(state)
      if (!ctx) {
        return reply.redirect('/auth/login?error=invalid_or_expired_state')
      }
      if (!oauthCookie || !safeEqual(oauthCookie, ctx.nonce)) {
        return reply.redirect('/auth/login?error=invalid_or_expired_state')
      }

      let result
      try {
        result = await feishu.exchangeCode(code)
      } catch (e) {
        // Map any provider/exchange failure to a fixed code; never reflect the
        // raw exception message into the redirect URL.
        app.log.error({ err: e }, 'feishu exchangeCode failed')
        return reply.redirect('/auth/login?error=exchange_failed')
      }

      const { tokens, user: fu } = result
      const now = new Date()

      const user = await prisma.user.upsert({
        where: { open_id: fu.open_id },
        create: {
          open_id: fu.open_id,
          union_id: fu.union_id ?? null,
          user_id_feishu: fu.user_id ?? null,
          name: fu.name,
          en_name: fu.en_name ?? null,
          email: fu.email ?? null,
          mobile: fu.mobile ?? null,
          avatar_url: fu.avatar_url ?? null,
          avatar_thumb: fu.avatar_thumb ?? null,
          tenant_key: fu.tenant_key ?? null,
          raw_user_info: JSON.stringify(fu.raw),
          user_access_token: secretBox.encrypt(tokens.user_access_token),
          user_token_expires_at: tokens.user_access_token_expires_at,
          refresh_token: secretBox.encrypt(tokens.refresh_token),
          refresh_token_expires_at: tokens.refresh_token_expires_at,
          scopes: requestedScopesStr,
          last_login_at: now,
        },
        update: {
          union_id: fu.union_id ?? null,
          user_id_feishu: fu.user_id ?? null,
          name: fu.name,
          en_name: fu.en_name ?? null,
          email: fu.email ?? null,
          mobile: fu.mobile ?? null,
          avatar_url: fu.avatar_url ?? null,
          avatar_thumb: fu.avatar_thumb ?? null,
          tenant_key: fu.tenant_key ?? null,
          raw_user_info: JSON.stringify(fu.raw),
          user_access_token: secretBox.encrypt(tokens.user_access_token),
          user_token_expires_at: tokens.user_access_token_expires_at,
          refresh_token: secretBox.encrypt(tokens.refresh_token),
          refresh_token_expires_at: tokens.refresh_token_expires_at,
          scopes: requestedScopesStr,
          last_login_at: now,
          needs_relogin: false,
          // 不要在这里写 disabled：被禁用的用户重新登录不能自动恢复。
        },
      })

      const session = await createSession({
        userId: user.id,
        rememberMe: ctx.remember_me,
        ip: req.ip,
        userAgent: req.headers['user-agent'],
      })
      setSessionCookie(reply, session.id, ctx.remember_me)

      return reply.redirect(ctx.return_to)
    },
  )
}
