export const DEFAULT_SITE_NAME = '统一登录'

/** 从 api 取站点名（由服务端 SITE_NAME 配置）；失败或返回异常时用默认值，不阻塞登录。 */
export async function fetchSiteName(origin: string, fetchImpl: typeof fetch = fetch): Promise<string> {
  try {
    const res = await fetchImpl(new URL('/auth/api/site', origin), { signal: AbortSignal.timeout(5000) })
    if (!res.ok) return DEFAULT_SITE_NAME
    const data = (await res.json()) as { name?: unknown }
    return typeof data.name === 'string' && data.name.trim() ? data.name : DEFAULT_SITE_NAME
  } catch {
    return DEFAULT_SITE_NAME
  }
}
