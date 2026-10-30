import { describe, it, expect } from 'vitest'
import { shouldFlush, INTERVAL_MS, MIN_CHARS } from './card-stream-throttle'

describe('card-stream-throttle', () => {
  it('flushes once the interval has elapsed', () => {
    const base = { lastFlushAt: 1000, lastFlushLen: 0, curLen: 3 }
    expect(shouldFlush(base, 1000 + INTERVAL_MS - 1)).toBe(false)
    expect(shouldFlush(base, 1000 + INTERVAL_MS)).toBe(true)
  })

  it('flushes once enough new characters accumulate, even within the interval', () => {
    expect(shouldFlush({ lastFlushAt: 1000, lastFlushLen: 0, curLen: MIN_CHARS - 1 }, 1001)).toBe(false)
    expect(shouldFlush({ lastFlushAt: 1000, lastFlushLen: 0, curLen: MIN_CHARS }, 1001)).toBe(true)
  })
})
