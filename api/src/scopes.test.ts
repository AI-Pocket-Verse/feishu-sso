import { describe, it, expect } from 'vitest'

import { missingScopes } from './scopes'

describe('missingScopes', () => {
  it('empty when granted is a superset of required', () => {
    expect(missingScopes('a b', 'a b c')).toEqual([])
  })

  it('empty when equal, ignoring order / extra whitespace', () => {
    expect(missingScopes('a  b\tc', 'c b a')).toEqual([])
  })

  it('lists scopes required but not granted', () => {
    expect(missingScopes('a b c', 'a')).toEqual(['b', 'c'])
  })

  it('treats empty / null granted as "nothing granted"', () => {
    expect(missingScopes('a b', '')).toEqual(['a', 'b'])
    expect(missingScopes('a', null)).toEqual(['a'])
  })

  it('empty / null required → nothing missing (never forces re-login)', () => {
    expect(missingScopes('', 'a b')).toEqual([])
    expect(missingScopes(null, null)).toEqual([])
  })
})
