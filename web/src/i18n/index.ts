import { en, zh, type MessageKey } from './messages'

export type { MessageKey }
export type Lang = 'zh' | 'en'
/** 登录服务对接的飞书版本：中国版（飞书）或国际版（Lark）。 */
export type Provider = 'feishu' | 'lark'

const DICTS: Record<Lang, Record<MessageKey, string>> = { zh, en }

/**
 * 界面语言：URL 带 `?lang=zh|en` 时以它为准（接入方可以把自己的界面语言传过来），
 * 否则跟随浏览器首选语言 —— 以 zh 开头用中文，其余一律英文。
 */
export function detectLang(search: string, languages: readonly string[]): Lang {
  const forced = new URLSearchParams(search).get('lang')?.toLowerCase()
  if (forced === 'zh' || forced === 'en') return forced
  return /^zh\b/i.test(languages[0] ?? '') ? 'zh' : 'en'
}

export function brandName(lang: Lang, provider: Provider): string {
  if (provider === 'lark') return 'Lark'
  return lang === 'zh' ? '飞书' : 'Feishu'
}

/** 取文案并插值；未提供的占位原样保留。中文里的英文品牌名两侧补半角空格。 */
export function translate(lang: Lang, key: MessageKey, params?: Record<string, string>): string {
  const text = DICTS[lang][key]
  const out = params ? text.replace(/\{(\w+)\}/g, (m, k: string) => params[k] ?? m) : text
  return lang === 'zh' ? out.replace(/([一-鿿])(Lark)/g, '$1 $2').replace(/(Lark)([一-鿿])/g, '$1 $2') : out
}
