/**
 * Per-user Feishu user_access_token accessor with on-demand refresh.
 *
 * The background token-refresh worker keeps tokens fresh with a lookahead, so
 * this usually just decrypts the stored token. When a token is within the
 * buffer (or already expired) it refreshes synchronously and persists the new
 * pair — mirroring workers/token-refresh.ts. Throws FeishuTokenError when the
 * refresh_token itself is dead so the caller can ask the user to re-login.
 */
import { prisma, secretBox } from './db'
import { feishu } from './feishu'

const REFRESH_BUFFER_MS = 60_000

/** Pure: should a token expiring at `expiresAt` be refreshed relative to `now`? */
export function needsRefresh(expiresAt: Date, now: Date = new Date()): boolean {
  return expiresAt.getTime() <= now.getTime() + REFRESH_BUFFER_MS
}

export class FeishuTokenError extends Error {
  constructor(public reason: 'need_relogin') {
    super(reason)
  }
}

// Single-flight per user. A doc import fires several gateway calls in parallel,
// each needing the token; without this they could concurrently call
// feishu.refreshUserToken with the same single-use refresh_token, making all
// but one fail and flag needs_relogin — logging the user out mid-import.
const inflight = new Map<string, Promise<string>>()

/**
 * Return a usable plaintext user_access_token for `userId`, refreshing on
 * demand if near expiry. Throws FeishuTokenError('need_relogin') when the
 * user is disabled / flagged, or the refresh_token is dead. Concurrent calls
 * for the same user share one in-flight result.
 */
export function getFreshUserAccessToken(userId: string): Promise<string> {
  const existing = inflight.get(userId)
  if (existing) return existing
  const p = loadFreshUserAccessToken(userId).finally(() => inflight.delete(userId))
  inflight.set(userId, p)
  return p
}

async function loadFreshUserAccessToken(userId: string): Promise<string> {
  const u = await prisma.user.findUnique({ where: { id: userId } })
  if (!u || u.disabled || u.needs_relogin) throw new FeishuTokenError('need_relogin')
  if (!needsRefresh(u.user_token_expires_at)) return secretBox.decrypt(u.user_access_token)

  if (u.refresh_token_expires_at.getTime() < Date.now() + REFRESH_BUFFER_MS) {
    await prisma.user.update({ where: { id: u.id }, data: { needs_relogin: true } }).catch(() => undefined)
    throw new FeishuTokenError('need_relogin')
  }
  try {
    const fresh = await feishu.refreshUserToken(secretBox.decrypt(u.refresh_token))
    await prisma.user.update({
      where: { id: u.id },
      data: {
        user_access_token: secretBox.encrypt(fresh.user_access_token),
        user_token_expires_at: fresh.user_access_token_expires_at,
        refresh_token: secretBox.encrypt(fresh.refresh_token),
        refresh_token_expires_at: fresh.refresh_token_expires_at,
        // NB: do NOT touch user.scopes here. It snapshots the scopes the app
        // *requested* at the user's last login (set in routes/feishu.ts) and is
        // the baseline for the scope-change re-login gate; a token refresh does
        // not change what we asked for.
      },
    })
    return fresh.user_access_token
  } catch {
    await prisma.user.update({ where: { id: u.id }, data: { needs_relogin: true } }).catch(() => undefined)
    throw new FeishuTokenError('need_relogin')
  }
}
