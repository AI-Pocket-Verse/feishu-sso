/**
 * Unit tests for the Feishu provider wrapper.
 *
 * We don't hit feishu.cn — the SDK is mocked. The point of these tests is to
 * lock in the contract this package exposes to the api (URL shape, token
 * field mapping, error propagation).
 */
import { describe, expect, it, vi, beforeEach } from 'vitest'

const { tokenCreate, refreshCreate, userInfoGet, withUserAccessTokenMock } = vi.hoisted(() => ({
  tokenCreate: vi.fn(),
  refreshCreate: vi.fn(),
  userInfoGet: vi.fn(),
  withUserAccessTokenMock: vi.fn((t: string) => ({ __headerToken: t })),
}))

vi.mock('@larksuiteoapi/node-sdk', () => ({
  Client: vi.fn().mockImplementation(function () {
    return {
      authen: {
        v1: {
          oidcAccessToken: { create: tokenCreate },
          oidcRefreshAccessToken: { create: refreshCreate },
          userInfo: { get: userInfoGet },
        },
      },
    }
  }),
  AppType: { SelfBuild: 'self_build', ISV: 'isv' },
  Domain: { Feishu: 'https://open.feishu.cn', Lark: 'https://open.larksuite.com' },
  withUserAccessToken: withUserAccessTokenMock,
}))

import { createFeishuProvider } from '../index.js'

const baseCfg = {
  appId: 'cli_test',
  appSecret: 'secret',
  redirectUri: 'https://example.com/auth/api/feishu/callback',
  scopes: ['contact:user.email:readonly'],
}

describe('getAuthorizeUrl', () => {
  beforeEach(() => { tokenCreate.mockReset(); refreshCreate.mockReset(); userInfoGet.mockReset() })

  it('builds passport URL with required params + state + scope', () => {
    const p = createFeishuProvider(baseCfg)
    const url = new URL(p.getAuthorizeUrl('state-xyz'))
    expect(url.origin + url.pathname).toBe('https://passport.feishu.cn/suite/passport/oauth/authorize')
    expect(url.searchParams.get('client_id')).toBe('cli_test')
    expect(url.searchParams.get('redirect_uri')).toBe(baseCfg.redirectUri)
    expect(url.searchParams.get('response_type')).toBe('code')
    expect(url.searchParams.get('state')).toBe('state-xyz')
    expect(url.searchParams.get('scope')).toBe('contact:user.email:readonly')
  })

  it('domain=lark 时授权页走 larksuite.com，SDK 用 Lark 域名', async () => {
    const { Client } = await import('@larksuiteoapi/node-sdk')
    const p = createFeishuProvider({ ...baseCfg, domain: 'lark' })
    const url = new URL(p.getAuthorizeUrl('s'))
    expect(url.origin + url.pathname).toBe('https://passport.larksuite.com/suite/passport/oauth/authorize')
    expect(vi.mocked(Client).mock.calls.at(-1)?.[0]).toMatchObject({ domain: 'https://open.larksuite.com' })
  })

  it('omits scope when none configured', () => {
    const p = createFeishuProvider({ ...baseCfg, scopes: [] })
    const url = new URL(p.getAuthorizeUrl('s'))
    expect(url.searchParams.has('scope')).toBe(false)
  })
})

describe('exchangeCode', () => {
  beforeEach(() => { tokenCreate.mockReset(); userInfoGet.mockReset() })

  it('maps SDK response into FeishuTokenSet + FeishuUserInfo', async () => {
    tokenCreate.mockResolvedValueOnce({
      code: 0,
      data: {
        access_token: 'uat',
        refresh_token: 'rt',
        expires_in: 7200,
        refresh_expires_in: 2_592_000,
        scope: 'contact:user.email:readonly',
        token_type: 'Bearer',
      },
    })
    userInfoGet.mockResolvedValueOnce({
      code: 0,
      data: {
        open_id: 'ou_xxx',
        union_id: 'on_yyy',
        name: '张三',
        en_name: 'San Zhang',
        email: 'user@example.com',
        avatar_url: 'https://...',
        tenant_key: 'tk_example',
      },
    })

    const before = Date.now()
    const p = createFeishuProvider(baseCfg)
    const result = await p.exchangeCode('the-code')

    expect(tokenCreate).toHaveBeenCalledWith({
      data: { grant_type: 'authorization_code', code: 'the-code' },
    })
    expect(withUserAccessTokenMock).toHaveBeenCalledWith('uat')

    expect(result.tokens.user_access_token).toBe('uat')
    expect(result.tokens.refresh_token).toBe('rt')
    expect(result.tokens.scope).toBe('contact:user.email:readonly')

    // Expiry windows look right (allow 1s slack)
    expect(result.tokens.user_access_token_expires_at.getTime()).toBeGreaterThanOrEqual(before + 7200_000 - 1000)
    expect(result.tokens.refresh_token_expires_at.getTime()).toBeGreaterThanOrEqual(before + 2_592_000_000 - 1000)

    expect(result.user.open_id).toBe('ou_xxx')
    expect(result.user.union_id).toBe('on_yyy')
    expect(result.user.name).toBe('张三')
    expect(result.user.email).toBe('user@example.com')
    expect(result.user.raw).toMatchObject({ tenant_key: 'tk_example' })
  })

  it('throws on non-zero Feishu code', async () => {
    tokenCreate.mockResolvedValueOnce({ code: 99991668, msg: 'authorization code expired' })
    const p = createFeishuProvider(baseCfg)
    await expect(p.exchangeCode('bad')).rejects.toThrow(/authorization code expired/)
  })
})

describe('refreshUserToken', () => {
  beforeEach(() => { refreshCreate.mockReset() })

  it('returns a fresh FeishuTokenSet', async () => {
    refreshCreate.mockResolvedValueOnce({
      code: 0,
      data: {
        access_token: 'uat2',
        refresh_token: 'rt2',
        expires_in: 7200,
        refresh_expires_in: 2_592_000,
        scope: '',
        token_type: 'Bearer',
      },
    })
    const p = createFeishuProvider(baseCfg)
    const out = await p.refreshUserToken('old-rt')
    expect(refreshCreate).toHaveBeenCalledWith({
      data: { grant_type: 'refresh_token', refresh_token: 'old-rt' },
    })
    expect(out.user_access_token).toBe('uat2')
    expect(out.refresh_token).toBe('rt2')
  })
})
