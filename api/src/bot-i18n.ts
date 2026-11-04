/**
 * 飞书机器人卡片与按钮提示的文案（中 / 英）。服务端看不到提问人的界面语言，
 * 语言由部署方用 BOT_LANG 指定，默认中文。zh 定义全部 key，en 必须逐条对应（类型检查保证不漏）。
 * `{name}` 是插值占位，未提供的占位原样保留。
 */
const zh = {
  backendOff: '机器人还没有接入对话后端，暂时无法回答。请联系管理员配置 BOT_BACKEND_URL。',
  thinking: '{name} 正在思考…',
  maintenance: '{name} 维护中，请稍后再试。',
  backendUnauthorized: '机器人口令与对话后端不一致（bot_backend_unauthorized），请联系管理员检查 INTERNAL_API_TOKEN。',
  backendHttp: '连接 {name} 失败（bot_backend_http_{status}），请稍后再试。',
  backendUnreachable: '连接 {name} 失败（bot_backend_unreachable），请稍后再试。',
  needLoginDefault: '请先在网页端登录一次，再回来提问。',
  errorDefault: '出错了，请稍后再试。',
  /** 已有部分回答时，错误说明附在末尾。 */
  errorSuffix: '{text}\n\n（{error}）',
  emptyAnswer: '（{name} 暂时没有返回内容，换个说法再问我试试~）',

  imagesReceived: '已收到 {count} 张图片{note}，10 分钟内有效。{tail}',
  imagesDropped: '（最多 {max} 张，已忽略多余的 {dropped} 张）',
  imagesTailFull: '已达上限，可输入文字一起提问，或直接分析。',
  imagesTail: '你可以继续发图片、输入文字一起提问，或直接分析。',
  btnMoreImages: '继续上传图片',
  btnText: '输入文字',
  btnAnalyze: '分析图片',
  imageReceiveFailed: '图片接收失败了，请重发试试（或检查机器人图片权限）。',
  imageUnrecognized: '没有收到可识别的图片内容。',
  imagesMerged: '✅ 已连同 {count} 张图片一起分析。',
  imagesExpired: '图片已过期或已分析过，请重新发送图片。',
  imagesAnalyzing: '✅ 开始分析 {count} 张图片…',

  toastAnalyzeStart: '开始分析图片…',
  toastMoreImages: '好的，请继续发送图片（最多 {max} 张）。',
  toastEnterText: '好的，请输入文字，发送后将连同图片一起分析。',
  toastAckChecked: '已确认，下次不再提醒',
  toastAckUnchecked: '已撤销确认',
  toastHelpful: '谢谢反馈，记下了',
  toastNotHelpful: '已记下，后续少打扰这类问题',
  toastEscalation: '已收到你的决定，正在回流给对话…',
}

export type BotTextKey = keyof typeof zh

const en: Record<BotTextKey, string> = {
  backendOff: 'This bot is not connected to a chat backend yet, so it cannot answer. Please ask an administrator to configure BOT_BACKEND_URL.',
  thinking: '{name} is thinking…',
  maintenance: '{name} is under maintenance. Please try again later.',
  backendUnauthorized: 'The bot token does not match the chat backend (bot_backend_unauthorized). Please ask an administrator to check INTERNAL_API_TOKEN.',
  backendHttp: 'Could not reach {name} (bot_backend_http_{status}). Please try again later.',
  backendUnreachable: 'Could not reach {name} (bot_backend_unreachable). Please try again later.',
  needLoginDefault: 'Please sign in on the web once, then come back and ask again.',
  errorDefault: 'Something went wrong. Please try again later.',
  errorSuffix: '{text}\n\n({error})',
  emptyAnswer: '({name} returned nothing this time. Try rephrasing your question.)',

  imagesReceived: 'Received {count} image(s){note}, valid for 10 minutes. {tail}',
  imagesDropped: ' (up to {max}; {dropped} extra ignored)',
  imagesTailFull: 'Limit reached. Type a question to go with them, or analyze now.',
  imagesTail: 'Send more images, type a question to go with them, or analyze now.',
  btnMoreImages: 'Add images',
  btnText: 'Type text',
  btnAnalyze: 'Analyze images',
  imageReceiveFailed: 'Failed to receive the image. Please resend it (or check the bot’s image permission).',
  imageUnrecognized: 'No recognizable image content was received.',
  imagesMerged: '✅ Analyzing together with {count} image(s).',
  imagesExpired: 'The images have expired or were already analyzed. Please send them again.',
  imagesAnalyzing: '✅ Analyzing {count} image(s)…',

  toastAnalyzeStart: 'Analyzing images…',
  toastMoreImages: 'OK, send more images (up to {max}).',
  toastEnterText: 'OK, type your question; it will be analyzed together with the images.',
  toastAckChecked: 'Confirmed. You won’t be reminded again.',
  toastAckUnchecked: 'Confirmation withdrawn',
  toastHelpful: 'Thanks for the feedback!',
  toastNotHelpful: 'Noted. We’ll bother you less with questions like this.',
  toastEscalation: 'Decision received, passing it back to the conversation…',
}

export type BotLang = 'zh' | 'en'

/** 取机器人文案。lang 不是 en 时一律用中文（含未配置的情况）。 */
export function botText(lang: BotLang | undefined, key: BotTextKey, params?: Record<string, string | number>): string {
  const text = (lang === 'en' ? en : zh)[key]
  if (!params) return text
  return text.replace(/\{(\w+)\}/g, (m, k: string) => (k in params ? String(params[k]) : m))
}

export const botDicts = { zh, en }
