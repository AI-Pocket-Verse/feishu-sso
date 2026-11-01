/** INTERNAL_API_TOKEN 的开发占位值。 */
export const DEV_INTERNAL_TOKEN = 'dev-internal-token-change-in-prod'

const LOOPBACK_HOSTS = new Set(['127.0.0.1', 'localhost', '::1', '[::1]'])

/**
 * 解析 TRUST_PROXY：'true' / 'false' 转布尔，纯数字转跳数，其余原样交给 Fastify
 * （proxy-addr 支持 loopback、逗号分隔的 IP / CIDR 列表）。
 */
export function parseTrustProxy(v: string): boolean | number | string {
  const s = v.trim() || 'loopback'
  if (s.toLowerCase() === 'true') return true
  if (s.toLowerCase() === 'false') return false
  if (/^\d+$/.test(s)) return Number(s)
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
    return { warn: 'INTERNAL_API_TOKEN 为空：内部接口（notify / reply / reaction / upload-image）将拒绝所有请求' }
  }
  if (token !== DEV_INTERNAL_TOKEN) return {}
  if (cfg.NODE_ENV === 'production') {
    return { fatal: 'INTERNAL_API_TOKEN must be set to a strong shared secret in production' }
  }
  // 与 NODE_ENV 解耦：监听非回环地址时，公开写在源码里的占位口令等于没有口令。
  if (!LOOPBACK_HOSTS.has(cfg.HOST)) {
    return { fatal: `INTERNAL_API_TOKEN 仍是开发占位值，而 HOST=${cfg.HOST} 不是回环地址；请改成强随机口令` }
  }
  return { warn: 'INTERNAL_API_TOKEN 仍是开发占位值，仅限本机开发使用' }
}
