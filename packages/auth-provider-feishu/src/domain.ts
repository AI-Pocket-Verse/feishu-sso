import * as lark from '@larksuiteoapi/node-sdk'

/** 飞书中国版（feishu.cn）或国际版 Lark（larksuite.com）。 */
export type FeishuDomain = 'feishu' | 'lark'

// 授权页与 SDK 的开放接口域名按版本成对出现：Lark 与飞书的接口路径一致，只换域名。
export const AUTHORIZE_HOSTS: Record<FeishuDomain, string> = {
  feishu: 'https://passport.feishu.cn/suite/passport/oauth/authorize',
  lark: 'https://passport.larksuite.com/suite/passport/oauth/authorize',
}

/** FeishuDomain → SDK 的 Domain 枚举（登录与文档两个 client 共用）。 */
export function sdkDomain(domain: FeishuDomain | undefined): lark.Domain {
  return domain === 'lark' ? lark.Domain.Lark : lark.Domain.Feishu
}
