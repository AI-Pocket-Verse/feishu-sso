/**
 * Background worker that keeps user_access_token fresh.
 *
 * Scans every REFRESH_INTERVAL_MINUTES for users whose tokens expire within
 * REFRESH_LOOKAHEAD_MINUTES, refreshes them, and re-encrypts the new pair.
 * If refresh_token is also near expiry, flag needs_relogin so the next
 * /whoami will deny.
 *
 * Also GCs expired sessions each tick — with sliding sessions, abandoned ones
 * are otherwise never reaped (loadActiveSession only deletes lazily when the
 * cookie is presented again).
 */
import { env } from '../env'
import { prisma, secretBox } from '../db'
import { feishu } from '../feishu'

let timer: ReturnType<typeof setInterval> | null = null
let running = false
const BATCH_SIZE = 100

export function startTokenRefreshWorker(log: { info: (...a: unknown[]) => void; error: (...a: unknown[]) => void }): void {
  const intervalMs = env.REFRESH_INTERVAL_MINUTES * 60_000

  const refreshBatch = async (cutoff: Date): Promise<number> => {
    const due = await prisma.user.findMany({
      where: {
        disabled: false,
        needs_relogin: false,
        user_token_expires_at: { lte: cutoff },
      },
      select: { id: true, refresh_token: true, refresh_token_expires_at: true },
      orderBy: { user_token_expires_at: 'asc' }, // soonest expiry first
      take: BATCH_SIZE,
    })
    if (due.length === 0) return 0

    for (const u of due) {
      if (u.refresh_token_expires_at.getTime() < Date.now() + 60_000) {
        await prisma.user.update({ where: { id: u.id }, data: { needs_relogin: true } }).catch(() => undefined)
        continue
      }
      try {
        const plain = secretBox.decrypt(u.refresh_token)
        const fresh = await feishu.refreshUserToken(plain)
        await prisma.user.update({
          where: { id: u.id },
          data: {
            user_access_token: secretBox.encrypt(fresh.user_access_token),
            user_token_expires_at: fresh.user_access_token_expires_at,
            refresh_token: secretBox.encrypt(fresh.refresh_token),
            refresh_token_expires_at: fresh.refresh_token_expires_at,
          },
        })
      } catch (err) {
        log.error({ err, userId: u.id }, 'token-refresh: failed')
        // One-shot policy: mark for relogin so we don't keep retrying a dead token.
        await prisma.user.update({ where: { id: u.id }, data: { needs_relogin: true } }).catch(() => undefined)
      }
    }
    return due.length
  }

  const tick = async () => {
    if (running) return // overlap guard: refresh_token is single-use; concurrent ticks would invalidate each other's calls
    running = true
    try {
      const cutoff = new Date(Date.now() + env.REFRESH_LOOKAHEAD_MINUTES * 60_000)
      let total = 0
      // Drain in batches until nothing left under the cutoff.
      for (;;) {
        const n = await refreshBatch(cutoff)
        total += n
        if (n < BATCH_SIZE) break
      }
      if (total > 0) log.info({ refreshed: total }, 'token-refresh: completed')

      // Reap expired sessions (uses the @@index([expires_at])). Isolated so a GC
      // failure can't mask a successful refresh pass.
      try {
        const { count: gcd } = await prisma.session.deleteMany({ where: { expires_at: { lt: new Date() } } })
        if (gcd > 0) log.info({ removed: gcd }, 'session-gc: removed expired sessions')
      } catch (err) {
        log.error({ err }, 'session-gc: failed')
      }
    } catch (err) {
      log.error({ err }, 'token-refresh: tick failed')
    } finally {
      running = false
    }
  }

  tick().catch((err) => log.error({ err }, 'token-refresh: initial tick failed'))
  timer = setInterval(() => { tick().catch(() => undefined) }, intervalMs)
}

export function stopTokenRefreshWorker(): void {
  if (timer) { clearInterval(timer); timer = null }
}
