/** INTERNAL_API_TOKEN 的开发占位值。 */
export const DEV_INTERNAL_TOKEN = 'dev-internal-token-change-in-prod'

const LOOPBACK_HOSTS = new Set(['127.0.0.1', 'localhost', '::1', '[::1]'])

/**
 * 解析 TRUST_PROXY：'true' / 'false' 转布尔，其余原样交给 Fastify
 * （proxy-addr 支持 loopback、逗号分隔的 IP / CIDR 列表）。
 * 不支持跳数：Fastify 5.12 起数字跳数不再生效，req.ip 会静默变成直连对端，直接报错。
 */
export function parseTrustProxy(v: string): boolean | string {
  const s = v.trim() || 'loopback'
  if (s.toLowerCase() === 'true') return true
  if (s.toLowerCase() === 'false') return false
  if (/^\d+$/.test(s)) {
    throw new Error(`TRUST_PROXY=${s}: hop count is not supported, use the proxy IP / CIDR (e.g. loopback, 10.0.0.0/8)`)
  }
  return s
}

/**
 * 内部口令的启动检查。fatal 非空时应拒绝启动，warn 非空时只打印警告。
 * 留空表示关闭内部接口（运行时拒绝全部内部请求），不算错误。
 */
export function checkInternalToken(cfg: {
  NODE_ENV: string
  HOST: string
  INTERNAL_API_TOKEN: string
}): { fatal?: string; warn?: string } {
  const token = cfg.INTERNAL_API_TOKEN
  if (token === '') {
    return { warn: 'INTERNAL_API_TOKEN is empty: internal APIs (notify / reply / reaction / upload-image) will reject all requests' }
  }
  if (token !== DEV_INTERNAL_TOKEN) return {}
  if (cfg.NODE_ENV === 'production') {
    return { fatal: 'INTERNAL_API_TOKEN must be set to a strong shared secret in production' }
  }
  // 与 NODE_ENV 解耦：监听非回环地址时，公开写在源码里的占位口令等于没有口令。
  if (!LOOPBACK_HOSTS.has(cfg.HOST)) {
    return { fatal: `INTERNAL_API_TOKEN is still the development placeholder while HOST=${cfg.HOST} is not a loopback address; set a strong random secret` }
  }
  return { warn: 'INTERNAL_API_TOKEN is still the development placeholder; only use it for local development' }
}
