import { describe, it, expect } from 'vitest'

import { mergeBlockPages, describeFeishuError } from '../docs'

describe('describeFeishuError', () => {
  it('extracts the real Feishu code/msg from a thrown axios-style error', () => {
    const axiosErr = { message: 'Request failed with status code 400', response: { status: 400, data: { code: 99991663, msg: 'invalid params' } } }
    const out = describeFeishuError(axiosErr)
    expect(out.message).toContain('invalid params')
    expect(out.message).toContain('99991663')
  })

  it('falls back to the original error when no Feishu body is present', () => {
    const err = new Error('socket hang up')
    expect(describeFeishuError(err).message).toBe('socket hang up')
  })
})

describe('mergeBlockPages', () => {
  it('concatenates items across pages in order', () => {
    const pages = [
      { items: [{ block_id: 'a' }, { block_id: 'b' }] },
      { items: [{ block_id: 'c' }] },
    ]
    expect(mergeBlockPages(pages).map((b) => (b as { block_id: string }).block_id)).toEqual([
      'a',
      'b',
      'c',
    ])
  })

  it('tolerates a page with no items', () => {
    expect(mergeBlockPages([{ items: undefined }, { items: [{ block_id: 'x' }] }])).toHaveLength(1)
  })

  it('returns an empty array for no pages', () => {
    expect(mergeBlockPages([])).toEqual([])
  })
})
