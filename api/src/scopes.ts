/**
 * Pure scope-set helpers (no env / IO imports — unit-testable in isolation).
 *
 * "Scope changed → force re-login" is detected by comparing the scopes the app
 * REQUIRES now (env.FEISHU_SCOPES) against a per-user snapshot of the scopes the
 * app REQUESTED when that user last logged in (stored in user.scopes). Comparing
 * against the *requested* snapshot — not the *granted* set — is deliberate: if we
 * compared against granted, a scope Feishu never actually grants (e.g. not enabled
 * in the Feishu admin console) would stay perpetually "missing" and bounce every
 * user through an endless re-login loop. With the requested snapshot, a fresh
 * login updates the snapshot to the current required set, so the gate clears.
 */

function toSet(scopes: string | null | undefined): Set<string> {
  return new Set((scopes ?? '').split(/\s+/).filter(Boolean))
}

/** Scopes present in `required` but absent from `granted`. Order/whitespace/dupes ignored. */
export function missingScopes(required: string | null | undefined, granted: string | null | undefined): string[] {
  const have = toSet(granted)
  return [...toSet(required)].filter((s) => !have.has(s))
}
