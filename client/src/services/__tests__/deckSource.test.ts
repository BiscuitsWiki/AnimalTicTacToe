/**
 * 对局牌堆数据源单元测试：
 * - 卡池只来自审核通过（approved）的皮肤，不再注入任何内置预设卡
 * - 失败原因区分：后端不可达 server_down / 公共池为空 pool_empty
 */
import { beforeEach, describe, expect, it, vi } from 'vitest'

const mocks = vi.hoisted(() => ({ fetchApprovedPieces: vi.fn() }))

vi.mock('../api', () => ({ fetchApprovedPieces: mocks.fetchApprovedPieces }))

import { buildDeckFromServer, buildPoolFromApproved } from '../deckSource'
import type { ApiPiece } from '../api'

const approved: ApiPiece[] = [
  { id: 'sk-1', cardId: 'c-1', name: '火狐', element: 'fire', imageUrl: '/uploads/a.png' },
  { id: 'sk-2', cardId: 'c-1', name: '火狐', element: 'fire', imageUrl: '/uploads/b.png' },
  { id: 'sk-3', cardId: 'c-2', name: '水灵', element: 'water', element2: null, imageUrl: '/uploads/c.png' },
]

beforeEach(() => {
  mocks.fetchApprovedPieces.mockReset()
})

describe('buildPoolFromApproved 卡池组装', () => {
  it('只由已上架皮肤组装：同名归并为一张卡、多款皮肤，无内置预设卡', () => {
    const pool = buildPoolFromApproved(approved)
    expect(pool).toHaveLength(2)
    const fox = pool.find(c => c.name === '火狐')
    expect(fox?.skins.map(s => s.skinId).sort()).toEqual(['sk-1', 'sk-2'])
    expect(pool.every(c => c.skins.length > 0)).toBe(true)
  })

  it('非法属性回退普通属性（脏数据不参战为非法属性）', () => {
    const pool = buildPoolFromApproved([
      { id: 'sk-x', cardId: 'c-x', name: '怪卡', element: 'unknown', imageUrl: '/uploads/x.png' },
    ])
    expect(pool[0].element).toBe('normal')
  })
})

describe('buildDeckFromServer 对局牌堆', () => {
  it('已上架皮肤非空：组出 60 张牌堆，牌面皮肤 id 全部来自公共池', async () => {
    mocks.fetchApprovedPieces.mockResolvedValue(approved)
    const res = await buildDeckFromServer()
    expect(res.ok).toBe(true)
    if (res.ok) {
      expect(res.deck).toHaveLength(60)
      const allowed = new Set(approved.map(p => p.id))
      expect(res.deck.every(p => allowed.has(p.id))).toBe(true)
      expect(res.deck.some(p => p.name === '火狐')).toBe(true)
    }
  })

  it('公共池为空：返回 pool_empty（上层提示等待工坊作品上架）', async () => {
    mocks.fetchApprovedPieces.mockResolvedValue([])
    expect(await buildDeckFromServer()).toEqual({ ok: false, reason: 'pool_empty' })
  })

  it('后端不可达：返回 server_down（不再回退内置预设牌堆）', async () => {
    mocks.fetchApprovedPieces.mockRejectedValue(new Error('network down'))
    expect(await buildDeckFromServer()).toEqual({ ok: false, reason: 'server_down' })
  })
})