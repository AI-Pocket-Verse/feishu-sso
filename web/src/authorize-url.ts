/**
 * 拼「使用飞书登录」要跳转的地址：/auth/api/feishu/authorize?return_to=…&remember_me=1。
 *
 * 用 origin 解析绝对路径，而不是相对当前 pathname，这样 /auth/login/ 多一个
 * 斜杠也不会把目标拼歪。会话一律走长期（30 天滑动）路径，所以固定 remember_me=1。
 * return_to 原样透传，由 api 端按白名单校验，防止开放重定向。
 */
export function buildAuthorizeUrl(origin: string, returnTo: string): string {
  const u = new URL('/auth/api/feishu/authorize', origin)
  u.searchParams.set('return_to', returnTo)
  u.searchParams.set('remember_me', '1')
  return u.toString()
}

/** 飞书 / Lark 客户端内置浏览器：登录页会自动跳转，做到「一点即登」。 */
export function isLarkWebview(userAgent: string): boolean {
  return /Lark|Feishu/i.test(userAgent)
}
