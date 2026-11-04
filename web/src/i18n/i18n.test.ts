import { describe, expect, it } from 'vitest'

import { brandName, detectLang, translate } from './index'
import { en, zh } from './messages'

describe('detectLang', () => {
  it('浏览器首选语言是中文（含繁体、地区变体）→ zh，其余 → en；只看首选语言', () => {
    expect(detectLang('', ['zh-CN', 'en'])).toBe('zh')
    expect(detectLang('', ['zh-TW'])).toBe('zh')
    expect(detectLang('', ['en-US', 'zh-CN'])).toBe('en')
    expect(detectLang('', ['ja'])).toBe('en')
    expect(detectLang('', [])).toBe('en')
  })
  it('?lang= 优先于浏览器语言，非法值忽略', () => {
    expect(detectLang('?lang=en&return_to=%2F', ['zh-CN'])).toBe('en')
    expect(detectLang('?lang=ZH', ['en-US'])).toBe('zh')
    expect(detectLang('?lang=fr', ['zh-CN'])).toBe('zh')
  })
})

describe('translate', () => {
  it('中文 + 飞书与改造前的文案逐字一致', () => {
    const brand = brandName('zh', 'feishu')
    expect(translate('zh', 'login.button', { brand })).toBe('使用飞书登录')
    expect(translate('zh', 'login.subtitle', { brand })).toBe('使用飞书账号登录')
    expect(translate('zh', 'login.poweredBy', { brand })).toBe('由飞书认证体系驱动')
    expect(translate('zh', 'login.consent', { brand })).toBe('点击登录即代表同意读取您的飞书基本资料，详细授权范围以飞书弹窗为准。')
  })
  it('Lark 品牌：中文两侧补空格，英文直接插入', () => {
    expect(translate('zh', 'login.button', { brand: brandName('zh', 'lark') })).toBe('使用 Lark 登录')
    expect(translate('zh', 'error.provider_error', { brand: 'Lark' })).toBe('Lark 拒绝了这次授权，请重试。')
    expect(translate('en', 'login.button', { brand: brandName('en', 'feishu') })).toBe('Sign in with Feishu')
  })
  it('英文词典与中文 key 一致且没有残留中文', () => {
    expect(Object.keys(en).sort()).toEqual(Object.keys(zh).sort())
    for (const [k, v] of Object.entries(en)) expect(/[一-鿿]/.test(v), k).toBe(false)
  })
})
