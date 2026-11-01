import { env } from './env'

const FALLBACK = '/auth/' // SSO landing

// 同源路径：单个 `/` 开头，后面不含控制字符、空白和反斜杠。
// 浏览器解析 URL 时会剥掉 Tab / 换行（`/\t/evil.com` 会变成 `//evil.com`），
// 所以这些字符必须在服务端就拒绝，不能只比较前缀。
const SAFE_PATH = /^\/(?![/\\])[^\u0000- \u007f\\]*$/

/**
 * 校验登录后的回跳地址（return_to），防止开放重定向。通过时返回可放进 Location
 * 的地址，否则返回 `/auth/`。允许三类：
 *   1. 同源路径，如 `/app/list?x=1`；
 *   2. 与本次请求同源的绝对 URL（scheme + host + port 与 requestOrigin 完全一致）；
 *   3. 匹配 ALLOWED_RETURN_TO 白名单的跨域地址。
 * requestOrigin 由调用方按 trustProxy 之后的 protocol / host 拼出，如 `https://app.example.com`。
 */
export function safeReturnTo(returnTo: string | undefined, requestOrigin?: string): string {
  if (!returnTo) return FALLBACK

  if (returnTo.startsWith('/')) {
    if (!SAFE_PATH.test(returnTo)) return FALLBACK
    // 兜底：按浏览器的解析规则确认确实落在本站。返回解析后的路径，非 ASCII 字符
    // 由此转成百分号编码 —— 原样放进 Location 头会让 reply.redirect 抛 ERR_INVALID_CHAR。
    try {
      const u = new URL(returnTo, 'http://x.invalid')
      return u.origin === 'http://x.invalid' ? u.pathname + u.search + u.hash : FALLBACK
    } catch {
      return FALLBACK
    }
  }

  let u: URL
  try {
    u = new URL(returnTo)
  } catch {
    return FALLBACK
  }
  if (u.protocol !== 'http:' && u.protocol !== 'https:') return FALLBACK
  if (u.username || u.password) return FALLBACK
  // 之后只用解析归一化后的 href 判断和返回，避免原串与浏览器解析结果不一致。
  const candidate = u.href
  if (requestOrigin && u.origin === requestOrigin) return candidate
  for (const re of env.ALLOWED_RETURN_TO) {
    if (re.test(candidate)) return candidate
  }
  return FALLBACK
}
