/**
 * Feishu event-subscription crypto: payload decryption + request signature
 * verification. Pure functions (Node crypto only) so they're unit-testable
 * without the SDK. Used by the api's /api/feishu/events receiver.
 *
 * Encryption (when the app sets an Encrypt Key): the `encrypt` field is
 * base64(IV(16B) || AES-256-CBC(key=sha256(encryptKey), data)). Signature
 * (X-Lark-Signature): sha256(timestamp + nonce + encryptKey + rawBody) hex.
 */
import { createDecipheriv, createHash, timingSafeEqual } from 'node:crypto'

/** Decrypt a Feishu event `encrypt` string into its plaintext JSON. */
export function decryptFeishuEvent(encrypted: string, encryptKey: string): string {
  const key = createHash('sha256').update(encryptKey).digest()
  const buf = Buffer.from(encrypted, 'base64')
  const iv = buf.subarray(0, 16)
  const data = buf.subarray(16)
  const decipher = createDecipheriv('aes-256-cbc', key, iv)
  return Buffer.concat([decipher.update(data), decipher.final()]).toString('utf8')
}

/** Verify a Feishu event request signature (constant-time). */
export function verifyFeishuSignature(p: {
  timestamp: string
  nonce: string
  encryptKey: string
  body: string
  signature: string
}): boolean {
  const expected = createHash('sha256')
    .update(p.timestamp + p.nonce + p.encryptKey + p.body)
    .digest('hex')
  const a = Buffer.from(expected)
  const b = Buffer.from(p.signature)
  return a.length === b.length && timingSafeEqual(a, b)
}
