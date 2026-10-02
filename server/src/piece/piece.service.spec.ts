/**
 * PieceService 卡牌/皮肤规则单元测试：
 * 同名即同一张卡（名称未占用建卡 + 皮肤；已占用属性必须一致，仅新增皮肤，不一致 400）；
 * 启动清理（历史预设卡：无皮肤删除、有皮肤转工坊）与对局卡池（仅上架皮肤参战）。
 */
import { describe, expect, it } from 'vitest'
import { BadRequestException } from '@nestjs/common'
import { PieceService } from './piece.service.js'

interface FakeCard {
  cardId: string
  cardName: string
  element: string
  element2: string | null
  source: string
}

interface FakeSkin {
  skinId: string
  cardId: string
  imageUrl: string
  authorId: string
  status: string
}

type IdFilter = string | { in: string[] }

interface CardWhere {
  cardId?: IdFilter
  cardName?: string
  source?: string
  element?: string
}

interface SkinWhere {
  skinId?: string
  cardId?: IdFilter
  status?: string
}

const hitId = (filter: IdFilter | undefined, id: string) =>
  filter === undefined ? true : typeof filter === 'string' ? filter === id : filter.in.includes(id)

/** 最小 Prisma 替身：覆盖 submit 链路 + 启动清理 + 对局卡池查询用到的 card/skin 操作 */
function makeService(seedCards: FakeCard[] = []) {
  const cards = [...seedCards]
  const skins: FakeSkin[] = []
  let seq = 0
  const matchCard = (c: FakeCard, where: CardWhere = {}) =>
    hitId(where.cardId, c.cardId) &&
    (where.cardName === undefined || c.cardName === where.cardName) &&
    (where.source === undefined || c.source === where.source) &&
    (where.element === undefined || c.element === where.element)
  const matchSkin = (s: FakeSkin, where: SkinWhere = {}) =>
    (where.skinId === undefined || s.skinId === where.skinId) &&
    hitId(where.cardId, s.cardId) &&
    (where.status === undefined || s.status === where.status)
  const prisma = {
    card: {
      findUnique: async ({ where }: { where: CardWhere }) =>
        cards.find(c => matchCard(c, where)) ?? null,
      findMany: async ({ where }: { where?: CardWhere } = {}) => cards.filter(c => matchCard(c, where)),
      create: async ({ data }: { data: Omit<FakeCard, 'cardId'> }) => {
        const card = { cardId: `c${++seq}`, ...data }
        cards.push(card)
        return card
      },
      updateMany: async ({ where, data }: { where?: CardWhere; data: Partial<FakeCard> }) => {
        const hit = cards.filter(c => matchCard(c, where))
        for (const c of hit) Object.assign(c, data)
        return { count: hit.length }
      },
      deleteMany: async ({ where }: { where?: CardWhere }) => {
        const hit = cards.filter(c => matchCard(c, where))
        for (const c of hit) cards.splice(cards.indexOf(c), 1)
        return { count: hit.length }
      },
    },
    skin: {
      create: async ({ data }: { data: Omit<FakeSkin, 'skinId'> }) => {
        const skin = { skinId: `s${++seq}`, ...data }
        skins.push(skin)
        return skin
      },
      findMany: async ({ where }: { where?: SkinWhere } = {}) => skins.filter(s => matchSkin(s, where)),
    },
  }
  const sec = { checkPieceImage: async () => ({ verdict: 'pass' as const, label: '' }) }
  return { service: new PieceService(prisma as never, sec as never), cards, skins }
}

const base = { name: '测试卡', element: 'fire', imageUrl: '/uploads/a.png', authorId: 'u1' }

describe('PieceService 提交（卡牌 + 皮肤）', () => {
  it('新名称：建卡牌（workshop 来源）+ 皮肤（待审核）', async () => {
    const { service, cards, skins } = makeService()
    await service.submit(base)
    expect(cards).toHaveLength(1)
    expect(cards[0]).toMatchObject({ cardName: '测试卡', element: 'fire', source: 'workshop' })
    expect(skins).toHaveLength(1)
    expect(skins[0]).toMatchObject({ cardId: cards[0].cardId, status: 'pending', authorId: 'u1' })
  })

  it('同名同属性：不新建卡牌，仅作为新皮肤挂到既有卡牌', async () => {
    const { service, cards, skins } = makeService([
      { cardId: 'c-existing', cardName: '测试卡', element: 'fire', element2: null, source: 'workshop' },
    ])
    await service.submit(base)
    expect(cards).toHaveLength(1)
    expect(skins).toHaveLength(1)
    expect(skins[0].cardId).toBe('c-existing')
  })

  it('同名不同属性：直接拒绝（属性以卡牌为准）', async () => {
    const { service, cards, skins } = makeService([
      { cardId: 'c-existing', cardName: '测试卡', element: 'water', element2: null, source: 'workshop' },
    ])
    await expect(service.submit(base)).rejects.toThrow(BadRequestException)
    await expect(service.submit(base)).rejects.toThrow(/已有卡牌（水）/)
    expect(cards).toHaveLength(1)
    expect(skins).toHaveLength(0)
  })

  it('同名双属性：副属性也必须一致（缺副属性同样拒绝）', async () => {
    const { service } = makeService([
      { cardId: 'c-existing', cardName: '测试卡', element: 'fire', element2: 'cute', source: 'workshop' },
    ])
    await expect(service.submit(base)).rejects.toThrow(/已有卡牌（火\/萌）/)
    await expect(service.submit({ ...base, element: 'fire', element2: 'cute' })).resolves.toBeTruthy()
  })

  it('同名双属性：主/副顺序不同视为同一组合（幻/电 提交到 电/幻 的卡）', async () => {
    const { service, skins } = makeService([
      { cardId: 'c-star', cardName: '粉粉星', element: 'electric', element2: 'illusion', source: 'workshop' },
    ])
    await service.submit({ ...base, name: '粉粉星', element: 'illusion', element2: 'electric' })
    expect(skins).toHaveLength(1)
    expect(skins[0].cardId).toBe('c-star')
  })

  it('提交校验：名称/属性/副属性/图片地址非法一律 400', async () => {
    const { service } = makeService()
    await expect(service.submit({ ...base, name: '   ' })).rejects.toThrow(/1~12/)
    await expect(service.submit({ ...base, name: 'x'.repeat(13) })).rejects.toThrow(/1~12/)
    await expect(service.submit({ ...base, element: 'unknown' })).rejects.toThrow(/非法属性/)
    await expect(service.submit({ ...base, element2: 'unknown' })).rejects.toThrow(/非法副属性/)
    await expect(service.submit({ ...base, element2: 'fire' })).rejects.toThrow(/副属性需与主属性不同/)
    await expect(service.submit({ ...base, imageUrl: 'http://evil/a.png' })).rejects.toThrow(/图片地址非法/)
  })
})

describe('PieceService 启动清理与对局卡池', () => {
  it('历史预设卡清理（幂等）：无皮肤删除，有皮肤转为工坊卡且皮肤保留', async () => {
    const { service, cards, skins } = makeService([
      { cardId: 'pc-a', cardName: '老卡一', element: 'fire', element2: null, source: 'preset' },
      { cardId: 'pc-b', cardName: '老卡二', element: 'water', element2: null, source: 'preset' },
      { cardId: 'w-1', cardName: '工坊卡', element: 'grass', element2: null, source: 'workshop' },
    ])
    skins.push({ skinId: 'sk-b', cardId: 'pc-b', imageUrl: '/uploads/b.png', authorId: 'u1', status: 'approved' })
    await service.onModuleInit()
    expect(cards.map(c => c.cardId)).toEqual(['pc-b', 'w-1'])       // 无皮肤的预设卡已删除
    expect(cards.find(c => c.cardId === 'pc-b')?.source).toBe('workshop')
    expect(skins).toHaveLength(1)                                   // 玩家皮肤保留
    await service.onModuleInit()                                    // 幂等：二次运行无变化
    expect(cards.map(c => c.cardId)).toEqual(['pc-b', 'w-1'])
    expect(skins).toHaveLength(1)
  })

  it('对局卡池：只返回有 ≥1 张上架皮肤的卡（无上架皮肤不参战）', async () => {
    const { service, skins } = makeService([
      { cardId: 'w-1', cardName: '卡一', element: 'fire', element2: null, source: 'workshop' },
      { cardId: 'w-2', cardName: '卡二', element: 'water', element2: null, source: 'workshop' },
      { cardId: 'w-3', cardName: '卡三', element: 'grass', element2: 'cute', source: 'workshop' },
    ])
    skins.push(
      { skinId: 's-1', cardId: 'w-1', imageUrl: '/uploads/1.png', authorId: 'u', status: 'approved' },
      { skinId: 's-2', cardId: 'w-2', imageUrl: '/uploads/2.png', authorId: 'u', status: 'pending' },
      { skinId: 's-3', cardId: 'w-3', imageUrl: '/uploads/3.png', authorId: 'u', status: 'approved' },
      { skinId: 's-4', cardId: 'w-3', imageUrl: '/uploads/4.png', authorId: 'u', status: 'rejected' },
    )
    const pool = await service.listPlayableCards()
    expect(pool.map(c => c.cardId).sort()).toEqual(['w-1', 'w-3'])
    const card3 = pool.find(c => c.cardId === 'w-3')
    expect(card3?.skins.map(s => s.skinId)).toEqual(['s-3'])        // 仅上架皮肤
    expect(card3?.element2).toBe('cute')
  })

  it('对局卡池：全库无上架皮肤时返回空数组（上层据此禁止开局）', async () => {
    const { service, skins } = makeService([
      { cardId: 'w-1', cardName: '卡一', element: 'fire', element2: null, source: 'workshop' },
    ])
    skins.push({ skinId: 's-1', cardId: 'w-1', imageUrl: '/uploads/1.png', authorId: 'u', status: 'pending' })
    await expect(service.listPlayableCards()).resolves.toEqual([])
  })
})