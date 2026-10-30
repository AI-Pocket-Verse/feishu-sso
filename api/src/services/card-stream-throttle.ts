// Pure throttle decision for the Feishu card "typewriter" stream. Feishu rate-
// limits message updates, so we flush the accumulated answer to the card at most
// ~once per INTERVAL_MS, or sooner once MIN_CHARS new characters have arrived.
export const INTERVAL_MS = 700
export const MIN_CHARS = 24

export interface ThrottleState {
  /** Wall-clock (ms) of the last card update. */
  lastFlushAt: number
  /** Answer length at the last card update. */
  lastFlushLen: number
  /** Current accumulated answer length. */
  curLen: number
}

/** True when enough time has passed OR enough new chars accumulated to flush. */
export function shouldFlush(s: ThrottleState, now: number): boolean {
  return now - s.lastFlushAt >= INTERVAL_MS || s.curLen - s.lastFlushLen >= MIN_CHARS
}
