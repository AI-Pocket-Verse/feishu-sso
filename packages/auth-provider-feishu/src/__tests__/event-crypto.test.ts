import { describe, it, expect } from 'vitest'
import { createCipheriv, createHash } from 'node:crypto'
import { decryptFeishuEvent, verifyFeishuSignature } from '../event-crypto'

// Encrypt the same way Feishu does, so the round-trip proves our decryptor.
function encrypt(plain: string, encryptKey: string): string {
  const key = createHash('sha256').update(encryptKey).digest()
  const iv = Buffer.alloc(16, 7)
  const c = createCipheriv('aes-256-cbc', key, iv)
  const enc = Buffer.concat([c.update(Buffer.from(plain, 'utf8')), c.final()])
  return Buffer.concat([iv, enc]).toString('base64')
}

describe('event-crypto', () => {
  it('decrypts an AES-256-CBC payload back to plaintext JSON', () => {
    const data = encrypt('{"hello":"world","n":42}', 'secret-key')
    expect(JSON.parse(decryptFeishuEvent(data, 'secret-key'))).toEqual({ hello: 'world', n: 42 })
  })

  it('verifies a correct signature and rejects a wrong one', () => {
    const ts = '1700000000', nonce = 'abc', body = '{"a":1}', key = 'k'
    const sig = createHash('sha256').update(ts + nonce + key + body).digest('hex')
    expect(verifyFeishuSignature({ timestamp: ts, nonce, encryptKey: key, body, signature: sig })).toBe(true)
    expect(verifyFeishuSignature({ timestamp: ts, nonce, encryptKey: key, body, signature: 'deadbeef' })).toBe(false)
  })
})
