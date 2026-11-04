// 登录页文案。zh 定义全部 key，en 必须逐条对应（类型检查保证不漏）。
// `{name}` 是插值占位；`{brand}` 是「飞书」或「Lark」，由服务端 FEISHU_DOMAIN 决定。
export const zh = {
  'site.defaultName': '统一登录',
  'login.docTitle': '登录',
  'login.docTitleWithSite': '登录 · {name}',
  'login.subtitle': '使用{brand}账号登录',
  'login.failed': '登录失败',
  'login.loopTitle': '自动登录未生效',
  'login.loopBody':
    '登录状态似乎没有被保存（可能是浏览器/{brand}内置浏览器拦截了 Cookie）。请点击下方按钮重试，或改用系统浏览器打开。',
  'login.redirecting': '跳转中…',
  'login.button': '使用{brand}登录',
  'login.consent': '点击登录即代表同意读取您的{brand}基本资料，详细授权范围以{brand}弹窗为准。',
  'login.poweredBy': '由{brand}认证体系驱动',

  // 登录失败时 api 回跳带的错误码 → 给人看的说明
  'error.provider_error': '{brand}拒绝了这次授权，请重试。',
  'error.missing_params': '{brand}回调缺少必要参数，请重新登录。',
  'error.invalid_or_expired_state': '登录链接已过期或不是在本浏览器发起的，请重新登录。',
  'error.exchange_failed': '向{brand}换取登录凭证失败，请检查应用 App ID / Secret 与重定向 URL 配置。',
}

export type MessageKey = keyof typeof zh

export const en: Record<MessageKey, string> = {
  'site.defaultName': 'Single Sign-On',
  'login.docTitle': 'Sign in',
  'login.docTitleWithSite': 'Sign in · {name}',
  'login.subtitle': 'Sign in with your {brand} account',
  'login.failed': 'Sign-in failed',
  'login.loopTitle': 'Automatic sign-in did not work',
  'login.loopBody':
    'Your sign-in does not seem to be saved (the browser or the {brand} in-app browser may be blocking cookies). Click the button below to try again, or open this page in your system browser.',
  'login.redirecting': 'Redirecting…',
  'login.button': 'Sign in with {brand}',
  'login.consent':
    'By signing in, you agree to share your basic {brand} profile. The exact permissions are shown in the {brand} authorization prompt.',
  'login.poweredBy': 'Powered by {brand} authentication',

  'error.provider_error': '{brand} declined the authorization. Please try again.',
  'error.missing_params': 'The {brand} callback is missing required parameters. Please sign in again.',
  'error.invalid_or_expired_state':
    'The sign-in link has expired or was started in a different browser. Please sign in again.',
  'error.exchange_failed':
    'Could not get sign-in credentials from {brand}. Check the app’s App ID / Secret and redirect URL settings.',
}
