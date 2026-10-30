import { describe, it, expect, beforeEach } from 'vitest'
import {
  MAX_PENDING_IMAGES,
  PENDING_TTL_MS,
  addPendingImages,
  getPendingImages,
  takePendingImages,
  clearAllPendingImages,
  pendingKey,
} from './feishu-image-buffer'

describe('feishu-image-buffer', () => {
  beforeEach(() => clearAllPendingImages())

  it('追加合并 + 上限截断(超出张数返回 dropped)', () => {
    const k = pendingKey('oc_1', 'ou_1')
    const r1 = addPendingImages(k, ['/uploads/a.png', '/uploads/b.png'], 'p2p', 1000)
    expect(r1.entry.urls).toHaveLength(2)
    expect(r1.dropped).toBe(0)
    const r2 = addPendingImages(k, ['/uploads/c.png', '/uploads/d.png'], 'p2p', 2000)
    expect(r2.entry.urls).toHaveLength(MAX_PENDING_IMAGES)
    expect(r2.dropped).toBe(1)
  })

  it('TTL 过期后读取/消费都返回 null;追加视为新建', () => {
    const k = pendingKey('oc_1', 'ou_1')
    addPendingImages(k, ['/uploads/a.png'], 'p2p', 1000)
    expect(getPendingImages(k, 1000 + PENDING_TTL_MS)).not.toBeNull()
    expect(getPendingImages(k, 1001 + PENDING_TTL_MS)).toBeNull()
    // 过期后再追加 → 新条目,不带旧图。
    const { entry } = addPendingImages(k, ['/uploads/b.png'], 'group', 2000 + PENDING_TTL_MS)
    expect(entry.urls).toEqual(['/uploads/b.png'])
    expect(entry.scope).toBe('group')
  })

  it('take 消费即移除;不同 chat/用户互不串号', () => {
    const k1 = pendingKey('oc_1', 'ou_1')
    const k2 = pendingKey('oc_1', 'ou_2')
    addPendingImages(k1, ['/uploads/a.png'], 'p2p', 1000)
    addPendingImages(k2, ['/uploads/b.png'], 'p2p', 1000)
    expect(takePendingImages(k1, 2000)?.urls).toEqual(['/uploads/a.png'])
    expect(takePendingImages(k1, 2000)).toBeNull()
    expect(getPendingImages(k2, 2000)?.urls).toEqual(['/uploads/b.png'])
  })
})
