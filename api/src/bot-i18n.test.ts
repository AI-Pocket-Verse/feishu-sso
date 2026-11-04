import { describe, expect, it } from 'vitest'

import { botDicts, botText } from './bot-i18n'

describe('botText', () => {
  it('按语言取文案并插值；未配置或未知语言用中文', () => {
    expect(botText('zh', 'thinking', { name: 'AI' })).toBe('AI 正在思考…')
    expect(botText('en', 'thinking', { name: 'AI' })).toBe('AI is thinking…')
    expect(botText(undefined, 'toastHelpful')).toBe(botDicts.zh.toastHelpful)
  })
  it('未提供的占位原样保留；插入的值不会被再次替换', () => {
    expect(botText('zh', 'backendHttp', { name: 'AI' })).toContain('{status}')
    expect(botText('zh', 'errorSuffix', { text: '回答 {error}', error: 'x' })).toBe('回答 {error}\n\n（x）')
  })
  it('英文词典与中文 key 一致且没有残留中文', () => {
    expect(Object.keys(botDicts.en).sort()).toEqual(Object.keys(botDicts.zh).sort())
    for (const [k, v] of Object.entries(botDicts.en)) expect(/[一-鿿]/.test(v), k).toBe(false)
  })
})
