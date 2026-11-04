/**
 * @feishu-sso/auth-provider-feishu
 *
 * Thin wrapper over the official Feishu Node SDK (`@larksuiteoapi/node-sdk`)
 * exposing the four operations the SSO service needs:
 *
 *   1. getAuthorizeUrl(state)        — build the user-facing authorize URL
 *   2. exchangeCode(code)            — code → user_access_token + user_info
 *   3. refreshUserToken(refresh)     — refresh near-expired user_access_token
 *   4. getUserInfo(userAccessToken)  — re-fetch user info (rarely needed)
 *
 * This package contains the ONLY direct dependency on the Feishu SDK in the
 * repo. Replacing the provider (e.g. with Lark global, or another IdP) means
 * rewriting this package and nothing else.
 */
import * as lark from '@larksuiteoapi/node-sdk'

import { AUTHORIZE_HOSTS, sdkDomain, type FeishuDomain } from './domain'

export interface FeishuConfig {
  /** Feishu app_id, e.g. cli_xxxxxxxx */
  appId: string
  /** Feishu app_secret */
  appSecret: string
  /** Absolute redirect URI registered in the Feishu console. */
  redirectUri: string
  /** OAuth scopes (space-separated when serialized). */
  scopes?: string[]
  /**
   * Authorize endpoint host. Defaults to the passport host of `domain`; override
   * only for testing.
   */
  authorizeHost?: string
  /** 飞书中国版（feishu.cn，默认）或国际版 Lark（larksuite.com）。 */
  domain?: FeishuDomain
}

export interface FeishuTokenSet {
  user_access_token: string
  user_access_token_expires_at: Date
  refresh_token: string
  refresh_token_expires_at: Date
  scope: string
  token_type: string
}

export interface FeishuUserInfo {
  open_id: string
  union_id?: string | null
  user_id?: string | null
  name: string
  en_name?: string | null
  email?: string | null
  mobile?: string | null
  avatar_url?: string | null
  avatar_thumb?: string | null
  tenant_key?: string | null
  /** Raw payload as returned by Feishu — store for forward-compat. */
  raw: Record<string, unknown>
}

export interface FeishuExchangeResult {
  tokens: FeishuTokenSet
  user: FeishuUserInfo
}

export interface FeishuProvider {
  getAuthorizeUrl: (state: string) => string
  exchangeCode: (code: string) => Promise<FeishuExchangeResult>
  refreshUserToken: (refreshToken: string) => Promise<FeishuTokenSet>
  getUserInfo: (userAccessToken: string) => Promise<FeishuUserInfo>
}

function plusSeconds(seconds: number): Date {
  return new Date(Date.now() + seconds * 1000)
}

// Feishu returns empty strings for missing scalar fields (not null). Coerce
// these to null at the boundary so DB rows and downstream schemas see a
// consistent "no value" representation.
function s(v: unknown): string | null {
  if (typeof v !== 'string') return null
  const trimmed = v.trim()
  return trimmed === '' ? null : trimmed
}

function pickUserInfo(raw: Record<string, unknown>): FeishuUserInfo {
  // The OIDC /authen/v1/user_info endpoint returns these fields.
  // See https://open.feishu.cn/document/uAjLw4CM/ukTMukTMukTM/authentication-management/login-state-management/get-user-info
  return {
    open_id: String(raw.open_id ?? ''),
    union_id: s(raw.union_id),
    user_id: s(raw.user_id),
    name: String(raw.name ?? ''),
    en_name: s(raw.en_name),
    email: s(raw.email) ?? s(raw.enterprise_email),
    mobile: s(raw.mobile),
    avatar_url: s(raw.avatar_url),
    avatar_thumb: s(raw.avatar_thumb),
    tenant_key: s(raw.tenant_key),
    raw,
  }
}

function unwrap<T>(res: { code?: number; msg?: string; data?: T } | undefined): T {
  if (!res) throw new Error('feishu: empty response')
  if (res.code !== 0 && res.code !== undefined) {
    throw new Error(`feishu: ${res.msg ?? 'unknown error'} (code=${res.code})`)
  }
  if (res.data === undefined) throw new Error('feishu: missing data')
  return res.data
}

export function createFeishuProvider(cfg: FeishuConfig): FeishuProvider {
  const client = new lark.Client({
    appId: cfg.appId,
    appSecret: cfg.appSecret,
    appType: lark.AppType.SelfBuild,
    domain: sdkDomain(cfg.domain),
    disableTokenCache: false,
  })

  const authorizeHost = cfg.authorizeHost ?? AUTHORIZE_HOSTS[cfg.domain ?? 'feishu']
  const scope = (cfg.scopes ?? []).join(' ')

  const getAuthorizeUrl = (state: string): string => {
    const params = new URLSearchParams({
      client_id: cfg.appId,
      redirect_uri: cfg.redirectUri,
      response_type: 'code',
      state,
    })
    if (scope) params.set('scope', scope)
    return `${authorizeHost}?${params.toString()}`
  }

  const exchangeCode = async (code: string): Promise<FeishuExchangeResult> => {
    const tokenRes = await client.authen.v1.oidcAccessToken.create({
      data: { grant_type: 'authorization_code', code },
    })
    const td = unwrap(tokenRes) as {
      access_token: string
      refresh_token: string
      expires_in: number
      refresh_expires_in: number
      scope: string
      token_type: string
    }
    const tokens: FeishuTokenSet = {
      user_access_token: td.access_token,
      user_access_token_expires_at: plusSeconds(td.expires_in),
      refresh_token: td.refresh_token,
      refresh_token_expires_at: plusSeconds(td.refresh_expires_in),
      scope: td.scope ?? '',
      token_type: td.token_type ?? 'Bearer',
    }

    const user = await getUserInfo(tokens.user_access_token)
    return { tokens, user }
  }

  const refreshUserToken = async (refreshToken: string): Promise<FeishuTokenSet> => {
    const res = await client.authen.v1.oidcRefreshAccessToken.create({
      data: { grant_type: 'refresh_token', refresh_token: refreshToken },
    })
    const td = unwrap(res) as {
      access_token: string
      refresh_token: string
      expires_in: number
      refresh_expires_in: number
      scope: string
      token_type: string
    }
    return {
      user_access_token: td.access_token,
      user_access_token_expires_at: plusSeconds(td.expires_in),
      refresh_token: td.refresh_token,
      refresh_token_expires_at: plusSeconds(td.refresh_expires_in),
      scope: td.scope ?? '',
      token_type: td.token_type ?? 'Bearer',
    }
  }

  const getUserInfo = async (userAccessToken: string): Promise<FeishuUserInfo> => {
    const res = await client.authen.v1.userInfo.get(
      {},
      lark.withUserAccessToken(userAccessToken),
    )
    const data = unwrap(res) as Record<string, unknown>
    return pickUserInfo(data)
  }

  return { getAuthorizeUrl, exchangeCode, refreshUserToken, getUserInfo }
}

// Document-domain methods (docx/wiki/media read). Kept in this package so the
// Feishu SDK stays confined to this one package.
export * from './domain'

export * from './docs'

// Event-subscription crypto (decrypt + signature verify) for the bot receiver.
export * from './event-crypto'
