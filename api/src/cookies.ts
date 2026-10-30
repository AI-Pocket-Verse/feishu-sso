import type { FastifyReply } from 'fastify'

import { env } from './env'

export function setSessionCookie(reply: FastifyReply, sessionId: string, rememberMe: boolean): void {
  const ttlDays = rememberMe ? env.SESSION_REMEMBER_TTL_DAYS : env.SESSION_TTL_DAYS
  const opts: Parameters<FastifyReply['setCookie']>[2] = {
    path: '/',
    httpOnly: true,
    secure: env.SESSION_COOKIE_SECURE,
    sameSite: env.SESSION_COOKIE_SAMESITE,
    // Always set maxAge so the cookie survives browser restarts up to the
    // server-side session TTL. Otherwise a non-remember-me cookie becomes a
    // session cookie (dies on browser close) which is inconsistent with the
    // server-side expiry stored on Session.expires_at.
    maxAge: ttlDays * 24 * 60 * 60, // seconds
  }
  if (env.SESSION_COOKIE_DOMAIN) opts.domain = env.SESSION_COOKIE_DOMAIN
  reply.setCookie(env.SESSION_COOKIE_NAME, sessionId, opts)
}

export function clearSessionCookie(reply: FastifyReply): void {
  // Must mirror the secure/sameSite/path/domain attributes used in
  // setSessionCookie — some browsers refuse to clear a cookie whose
  // attributes don't match the one originally set.
  const opts: Parameters<FastifyReply['clearCookie']>[1] = {
    path: '/',
    httpOnly: true,
    secure: env.SESSION_COOKIE_SECURE,
    sameSite: env.SESSION_COOKIE_SAMESITE,
  }
  if (env.SESSION_COOKIE_DOMAIN) opts.domain = env.SESSION_COOKIE_DOMAIN
  reply.clearCookie(env.SESSION_COOKIE_NAME, opts)
}

/** Cookie name carrying the OAuth-flow nonce that binds /authorize↔/callback. */
export const OAUTH_STATE_COOKIE_NAME = 'sso_oauth_state'

/**
 * Set the short-lived OAuth-state nonce cookie at /authorize.
 *
 * SameSite=Lax (NOT Strict): the cookie must be sent on the top-level GET
 * navigation back from Feishu's domain to /callback. Lax sends cookies on
 * top-level navigations, so this survives the cross-site redirect; Strict
 * would drop it and break (or loop) the Feishu in-app-browser login flow.
 */
export function setOAuthStateCookie(reply: FastifyReply, nonce: string): void {
  const opts: Parameters<FastifyReply['setCookie']>[2] = {
    path: '/',
    httpOnly: true,
    secure: env.SESSION_COOKIE_SECURE,
    sameSite: 'lax',
    maxAge: 10 * 60, // 10 minutes — covers the round trip to Feishu and back.
  }
  if (env.SESSION_COOKIE_DOMAIN) opts.domain = env.SESSION_COOKIE_DOMAIN
  reply.setCookie(OAUTH_STATE_COOKIE_NAME, nonce, opts)
}

/** Clear the OAuth-state nonce cookie (same attributes used to set it). */
export function clearOAuthStateCookie(reply: FastifyReply): void {
  const opts: Parameters<FastifyReply['clearCookie']>[1] = {
    path: '/',
    httpOnly: true,
    secure: env.SESSION_COOKIE_SECURE,
    sameSite: 'lax',
  }
  if (env.SESSION_COOKIE_DOMAIN) opts.domain = env.SESSION_COOKIE_DOMAIN
  reply.clearCookie(OAUTH_STATE_COOKIE_NAME, opts)
}
