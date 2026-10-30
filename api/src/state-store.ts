/**
 * Short-lived OAuth state store.
 *
 * Each /authorize call creates an entry; /callback consumes it (one-shot).
 * Entries auto-expire after STATE_TTL_SECONDS. In-memory Map is fine for a
 * single-process SSO; swap for Redis if you ever run multiple instances.
 */
import { randomBytes } from 'node:crypto'

import { env } from './env'

export interface OAuthState {
  state: string
  /**
   * Random per-flow secret echoed into an HttpOnly cookie at /authorize and
   * required to match on /callback. Binds the OAuth flow to the initiating
   * browser so an attacker can't feed a victim a `state` token they minted
   * (login CSRF / session fixation).
   */
  nonce: string
  return_to: string
  remember_me: boolean
  created_at: number
}

const store = new Map<string, OAuthState>()

function gc(): void {
  const cutoff = Date.now() - env.STATE_TTL_SECONDS * 1000
  for (const [k, v] of store) {
    if (v.created_at < cutoff) store.delete(k)
  }
}

export function createState(input: { return_to: string; remember_me: boolean }): OAuthState {
  gc()
  const state = randomBytes(24).toString('base64url')
  const nonce = randomBytes(24).toString('base64url')
  const entry: OAuthState = {
    state,
    nonce,
    return_to: input.return_to,
    remember_me: input.remember_me,
    created_at: Date.now(),
  }
  store.set(state, entry)
  return entry
}

export function consumeState(state: string): OAuthState | null {
  gc()
  const entry = store.get(state)
  if (!entry) return null
  store.delete(state)
  if (Date.now() - entry.created_at > env.STATE_TTL_SECONDS * 1000) return null
  return entry
}
