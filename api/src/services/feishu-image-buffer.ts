// 飞书「待分析图片」缓冲:用户发纯图片消息时不立刻让 LLM 分析,先把(已落盘
// 对话后端的)/uploads 地址按 chat+用户 暂存于此,等用户通过提示卡片选择
// 「继续上传图片 / 输入文字 / 分析图片」。内存态、单实例、带 TTL —— 重启丢失
// 可接受(用户点按钮会收到「已过期请重发」toast)。
export type PendingScope = 'p2p' | 'group'

export interface PendingImagesEntry {
  /** 对话后端落盘后的 /uploads/<file> 视图(已归属该用户,可直接随 /chat 引用)。 */
  urls: string[]
  scope: PendingScope
  /** 提示卡片的 message_id —— 追加图片时原地更新计数,消费时改写为收尾文案。 */
  cardMessageId: string | null
  updatedAt: number
}

/** 与对话后端聊天接口的 images 上限(3)对齐 —— 超出的静默丢弃并在卡片注明。 */
export const MAX_PENDING_IMAGES = 3
/** 图片提示卡片按钮的 value.k，card.action.trigger 回调据此识别。 */
export const IMAGE_PROMPT_KEY = 'img_prompt'
export const PENDING_TTL_MS = 10 * 60_000

const pending = new Map<string, PendingImagesEntry>()

export const pendingKey = (chatId: string, openId: string): string => `${chatId}:${openId}`

function sweep(now: number): void {
  for (const [k, e] of pending) if (now - e.updatedAt > PENDING_TTL_MS) pending.delete(k)
}

/** 读取(不消费);过期条目顺手清掉并返回 null。 */
export function getPendingImages(key: string, now: number): PendingImagesEntry | null {
  sweep(now)
  return pending.get(key) ?? null
}

/** 追加图片(已存在且未过期则合并,否则新建);返回最新条目 + 因超上限被丢弃的张数。 */
export function addPendingImages(
  key: string,
  urls: string[],
  scope: PendingScope,
  now: number,
): { entry: PendingImagesEntry; dropped: number } {
  sweep(now)
  const existing = pending.get(key)
  const entry: PendingImagesEntry = existing ?? { urls: [], scope, cardMessageId: null, updatedAt: now }
  const room = MAX_PENDING_IMAGES - entry.urls.length
  entry.urls.push(...urls.slice(0, Math.max(0, room)))
  entry.scope = scope
  entry.updatedAt = now
  pending.set(key, entry)
  return { entry, dropped: Math.max(0, urls.length - Math.max(0, room)) }
}

/** 消费(取出并移除);过期/不存在返回 null。 */
export function takePendingImages(key: string, now: number): PendingImagesEntry | null {
  const entry = getPendingImages(key, now)
  if (entry) pending.delete(key)
  return entry
}

/** 仅供测试:清空缓冲。 */
export function clearAllPendingImages(): void {
  pending.clear()
}
