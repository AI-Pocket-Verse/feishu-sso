import { beforeAll, describe, expect, it } from 'vitest'

// env.ts (transitively imported by state-store) validates required vars at
// module load and process.exit(1)s if any are missing. Provide the minimal set
// before importing so `pnpm test` works without a real .env file.
process.env.FEISHU_APP_ID ??= 'test-app-id'
process.env.FEISHU_APP_SECRET ??= 'test-app-secret'
process.env.FEISHU_REDIRECT_URI ??= 'http://localhost:4020/api/feishu/callback'
process.env.AUTH_DATA_KEY ??= Buffer.alloc(32).toString('base64')
process.env.DATABASE_URL ??= 'file:./test.db'
process.env.NODE_ENV ??= 'test'

type StateStore = typeof import('./state-store')
let createState: StateStore['createState']
let consumeState: StateStore['consumeState']

beforeAll(async () => {
  const mod = await import('./state-store')
  createState = mod.createState
  consumeState = mod.consumeState
})

describe('OAuth state store (CSRF / session-fixation binding)', () => {
  it('mints a distinct per-flow nonce alongside the state', () => {
    const a = createState({ return_to: '/', remember_me: false })
    const b = createState({ return_to: '/', remember_me: false })
    expect(a.nonce).toBeTruthy()
    expect(a.state).toBeTruthy()
    // The nonce is independent from the state token...
    expect(a.nonce).not.toBe(a.state)
    // ...and unique per flow, so it can't be guessed from another login.
    expect(a.nonce).not.toBe(b.nonce)
    expect(a.state).not.toBe(b.state)
  })

  it('round-trips return_to / remember_me / nonce through consume', () => {
    const created = createState({ return_to: '/app/home', remember_me: true })
    const consumed = consumeState(created.state)
    expect(consumed).not.toBeNull()
    expect(consumed?.return_to).toBe('/app/home')
    expect(consumed?.remember_me).toBe(true)
    expect(consumed?.nonce).toBe(created.nonce)
  })

  it('is one-shot: a second consume of the same state fails', () => {
    const created = createState({ return_to: '/', remember_me: false })
    expect(consumeState(created.state)).not.toBeNull()
    // Replaying the same state (e.g. an attacker reusing a leaked token) is rejected.
    expect(consumeState(created.state)).toBeNull()
  })

  it('rejects an unknown / forged state token', () => {
    expect(consumeState('definitely-not-a-real-state')).toBeNull()
  })
})
