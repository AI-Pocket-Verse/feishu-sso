import { env } from './env'

/**
 * Validate a return_to URL against ALLOWED_RETURN_TO regex list to prevent
 * open-redirect attacks. Returns the validated URL, or a fallback.
 */
export function safeReturnTo(returnTo: string | undefined): string {
  const fallback = '/auth/' // SSO landing
  if (!returnTo) return fallback
  // Reject protocol-relative URLs (//evil.com), backslash tricks (/\evil.com),
  // and other browser-interprets-as-cross-origin patterns.
  if (returnTo.startsWith('//') || returnTo.startsWith('/\\')) return fallback

  let candidate: string
  try {
    if (returnTo.startsWith('/')) {
      candidate = returnTo
    } else {
      const u = new URL(returnTo)
      candidate = u.toString()
    }
  } catch {
    return fallback
  }
  // Same-origin absolute paths (single leading slash) are always safe.
  if (candidate.startsWith('/') && !candidate.startsWith('//')) return candidate

  for (const re of env.ALLOWED_RETURN_TO) {
    if (re.test(candidate)) return candidate
  }
  return fallback
}
