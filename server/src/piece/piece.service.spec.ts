/**
 * PieceService 卡牌/皮肤规则单元测试：
 * 同名即同一张卡（名称未占用建卡 + 皮肤；已占用属性必须一致，仅新增皮肤，不一致 400）。
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

/** 最小 Prisma 替身：只覆盖 submit 链路用到的 card/skin 操作 */
function makeService(seedCards: FakeCard[] = []) {
  const cards = [...seedCards]
  const skins: { skinId: string; cardId: string; imageUrl: string; authorId: string; status: string }[] = []
  let seq = 0
  const prisma = {
    card: {
      findUnique: async ({ where }: { where: { cardName: string } }) =>
        cards.find(c => c.cardName === where.cardName) ?? null,
      create: async ({ data }: { data: Omit<FakeCard, 'cardId'> }) => {
        const card = { cardId: `c${++seq}`, ...data }
        cards.push(card)
        return card
      },
    },
    skin: {
      create: async ({ data }: { data: { cardId: string; imageUrl: string; authorId: string; status: string } }) => {
        const skin = { skinId: `s${++seq}`, ...data }
        skins.push(skin)
        return skin
      },
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
      { cardId: 'c-existing', cardName: '测试卡', element: 'fire', element2: 'cute', source: 'preset' },
    ])
    await expect(service.submit(base)).rejects.toThrow(/已有卡牌（火\/萌）/)
    await expect(service.submit({ ...base, element: 'fire', element2: 'cute' })).resolves.toBeTruthy()
  })

  it('预设卡：同名提交作为其新皮肤（属性需与预设一致）', async () => {
    const { service, skins } = makeService([
      { cardId: 'pc-d01', cardName: '炎尾狐', element: 'fire', element2: null, source: 'preset' },
    ])
    await service.submit({ ...base, name: '炎尾狐' })
    expect(skins[0].cardId).toBe('pc-d01')
    await expect(service.submit({ ...base, name: '炎尾狐', element: 'water' })).rejects.toThrow(/已有卡牌（火）/)
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