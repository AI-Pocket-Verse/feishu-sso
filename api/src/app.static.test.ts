import { mkdirSync, rmSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'

import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest'

// 单端口模式（WEB_DIST_DIR）：api 托管登录页并接受 /auth/api/* 前缀。
// vi.hoisted 先于顶部 import 执行，所以在里面动态 import 内置模块。
const { distDir } = await vi.hoisted(async () => {
  const { mkdtempSync } = await import('node:fs')
  const { tmpdir } = await import('node:os')
  const { join } = await import('node:path')
  return { distDir: mkdtempSync(join(tmpdir(), 'feishu-sso-dist-')) }
})

vi.mock('./env', () => ({
  env: {
    NODE_ENV: 'test',
    TRUST_PROXY: 'loopback',
    CORS_ORIGINS: '',
    SITE_NAME: undefined,
    FEISHU_DOMAIN: 'feishu',
    SESSION_COOKIE_NAME: 'sso_session',
    SESSION_COOKIE_SECURE: false,
    SESSION_COOKIE_SAMESITE: 'lax',
    SESSION_COOKIE_DOMAIN: '',
    SESSION_TTL_DAYS: 30,
    SESSION_REMEMBER_TTL_DAYS: 30,
    INTERNAL_API_TOKEN: 'x'.repeat(32),
    FEISHU_EVENT_ENCRYPT_KEY: '',
    FEISHU_EVENT_VERIFICATION_TOKEN: '',
    ALLOWED_RETURN_TO: [],
    WEB_DIST_DIR: distDir,
  },
}))
vi.mock('./db', () => ({ prisma: {}, secretBox: {}, initDb: async () => {} }))
vi.mock('./session', () => ({ loadActiveSession: vi.fn(), touchSession: vi.fn(), createSession: vi.fn(), destroySession: vi.fn() }))
vi.mock('./feishu', () => ({ feishu: {}, feishuDocs: {}, requestedScopesStr: '' }))
vi.mock('./feishu-token', () => ({ getFreshUserAccessToken: vi.fn(), FeishuTokenError: class extends Error {} }))
vi.mock('./services/feishu-chat-bridge', () => ({ runFeishuChatBridge: vi.fn(), analyzePendingImages: vi.fn() }))

import { buildApp, rewriteSinglePortUrl } from './app'

let app: Awaited<ReturnType<typeof buildApp>>

beforeAll(async () => {
  writeFileSync(join(distDir, 'index.html'), '<!doctype html><title>login</title>')
  mkdirSync(join(distDir, 'assets'))
  writeFileSync(join(distDir, 'assets', 'app.js'), 'console.log(1)')
  app = await buildApp()
})
afterAll(async () => {
  await app.close()
  rmSync(distDir, { recursive: true, force: true })
})

describe('rewriteSinglePortUrl', () => {
  it('/auth/api/* 去掉 /auth 前缀；内部接口与其他路径保持原样', () => {
    expect(rewriteSinglePortUrl('/auth/api/whoami')).toBe('/api/whoami')
    expect(rewriteSinglePortUrl('/auth/api/feishu/callback?code=1')).toBe('/api/feishu/callback?code=1')
    expect(rewriteSinglePortUrl('/auth/api/feishu/notify')).toBe('/auth/api/feishu/notify')
    expect(rewriteSinglePortUrl('/auth/api/feishu/upload-image?x=1')).toBe('/auth/api/feishu/upload-image?x=1')
    expect(rewriteSinglePortUrl('/auth/api/feishu/notifyx')).toBe('/api/feishu/notifyx')
    expect(rewriteSinglePortUrl('/auth/login')).toBe('/auth/login')
  })
})

describe('single-port mode', () => {
  it('serves the login page, its assets and SPA fallback', async () => {
    expect((await app.inject({ url: '/auth/' })).body).toContain('<title>login</title>')
    expect((await app.inject({ url: '/auth/login?return_to=%2F' })).body).toContain('<title>login</title>')
    expect((await app.inject({ url: '/auth/assets/app.js' })).body).toBe('console.log(1)')
    const bare = await app.inject({ url: '/auth' })
    expect(bare.statusCode).toBe(302)
    expect(bare.headers.location).toBe('/auth/')
  })

  it('routes /auth/api/* to the api', async () => {
    const r = await app.inject({ url: '/auth/api/site' })
    expect(r.json()).toEqual({ name: null, provider: 'feishu' })
  })

  it('keeps internal endpoints off the public /auth/api prefix', async () => {
    const r = await app.inject({
      method: 'POST',
      url: '/auth/api/feishu/notify',
      headers: { 'x-internal-token': 'x'.repeat(32), 'content-type': 'application/json' },
      payload: { openId: 'ou_1', card: { elements: [] } },
    })
    expect(r.statusCode).toBe(404)
  })

  it('unknown api paths are 404 JSON, not the login page', async () => {
    const r = await app.inject({ url: '/auth/api/nope' })
    expect(r.statusCode).toBe(404)
    expect(r.json()).toMatchObject({ error: 'not_found' })
  })
})
