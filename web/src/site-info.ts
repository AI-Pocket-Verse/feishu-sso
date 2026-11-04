import type { Provider } from './i18n'

export interface SiteInfo {
  /** 服务端 SITE_NAME；未配置时为 null，由登录页按界面语言显示默认名。 */
  name: string | null
  provider: Provider
}

export const DEFAULT_SITE_INFO: SiteInfo = { name: null, provider: 'feishu' }

/** 从 api 取站点信息；失败或返回异常时用默认值，不阻塞登录。 */
export async function fetchSiteInfo(origin: string, fetchImpl: typeof fetch = fetch): Promise<SiteInfo> {
  try {
    const res = await fetchImpl(new URL('/auth/api/site', origin), { signal: AbortSignal.timeout(5000) })
    if (!res.ok) return DEFAULT_SITE_INFO
    const data = (await res.json()) as { name?: unknown; provider?: unknown }
    return {
      name: typeof data.name === 'string' && data.name.trim() ? data.name : null,
      provider: data.provider === 'lark' ? 'lark' : 'feishu',
    }
  } catch {
    return DEFAULT_SITE_INFO
  }
}
