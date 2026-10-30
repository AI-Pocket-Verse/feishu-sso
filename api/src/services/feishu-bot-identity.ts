// The bot's own open_id, needed to tell whether a group message actually
// @-mentioned the bot (vs @-ing another member). Fetched once from Feishu and
// cached for an hour — it never changes for a given app.
import { feishuDocs } from '../feishu'

let cached: { openId: string; at: number } | null = null
const TTL_MS = 60 * 60_000

/** This bot's open_id (cached). Injectable loader + clock keep it unit-testable. */
export async function getCachedBotOpenId(
  load: () => Promise<string> = () => feishuDocs.getBotOpenId(),
  now: () => number = () => Date.now(),
): Promise<string> {
  const t = now()
  if (cached && t - cached.at < TTL_MS) return cached.openId
  const openId = await load()
  cached = { openId, at: t }
  return openId
}

/** Test-only: drop the cache so a fresh load happens next call. */
export function __resetBotIdentityCache(): void {
  cached = null
}

/** True if `mentions` contains a mention resolving to this bot's open_id. */
export function isBotMentioned(
  mentions: Array<{ id?: { open_id?: string } }> | undefined,
  botOpenId: string,
): boolean {
  if (!botOpenId || !mentions) return false
  return mentions.some((m) => m.id?.open_id === botOpenId)
}
