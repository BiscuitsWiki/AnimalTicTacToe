/**
 * 客户端组牌算法守护（与 server/src/game/core/deck.ts 同源拷贝）：
 * 卡池 60 张四阶段产出、每属性 2 张不同名单属性卡、同名副本皮肤互不相同、牌面皮肤 id 全部来自卡池。
 */
import { describe, expect, it } from 'vitest'
import { buildGameDeck, DECK_SIZE, PHASE1_PER_ELEMENT, PHASE2_COUNT } from '../deck'
import type { CardWithSkins } from '../deck'
import type { Element } from '../elements'
import { ELEMENTS } from '../elements'

function lcg(seed = 20260916): () => number {
  let s = seed
  return () => {
    s = (s * 1664525 + 1013904223) % 4294967296
    return s / 4294967296
  }
}

function single(cardId: string, element: Element, skinCount = 1): CardWithSkins {
  return {
    cardId,
    name: cardId,
    element,
    skins: Array.from({ length: skinCount }, (_, i) => ({ skinId: `${cardId}-s${i + 1}` })),
  }
}

function dual(cardId: string, element: Element, element2: Element, skinCount = 1): CardWithSkins {
  return { ...single(cardId, element, skinCount), element2 }
}

/** 满池夹具：18 属性 × 各 2 张单属性卡 + 15 张双属性卡（每卡 1 款皮肤） */
function fullPool(): CardWithSkins[] {
  const pool: CardWithSkins[] = []
  ELEMENTS.forEach((el, i) => {
    pool.push(single(`s${i}-1`, el), single(`s${i}-2`, el))
  })
  for (let i = 0; i < 15; i++) {
    pool.push(dual(`d${i}`, ELEMENTS[i], ELEMENTS[(i + 3) % ELEMENTS.length]))
  }
  return pool
}

describe('客户端 buildGameDeck', () => {
  it('常量守护：60 张 / 每属性 2 张 / 双属性 18 张上限', () => {
    expect(DECK_SIZE).toBe(60)
    expect(PHASE1_PER_ELEMENT).toBe(2)
    expect(PHASE2_COUNT).toBe(18)
  })

  it('满池抽 60 张：每属性 2 张不同名单属性卡 + 15 张双属性，皮肤 id 全部来自卡池', () => {
    const pool = fullPool()
    const deck = buildGameDeck(pool, { rng: lcg() })
    expect(deck).toHaveLength(60)
    for (const el of ELEMENTS) {
      const ids = new Set(deck.filter(p => p.element === el && !p.element2).map(p => p.cardId))
      expect(ids.size).toBe(2)
    }
    expect(new Set(deck.filter(p => p.element2).map(p => p.cardId)).size).toBe(15)
    const skinIds = new Set(pool.flatMap(c => c.skins.map(s => s.skinId)))
    expect(deck.every(p => skinIds.has(p.id))).toBe(true)
  })

  it('同名副本优先分配不同皮肤（工坊皮肤充足时）', () => {
    const pool: CardWithSkins[] = [
      ...fullPool(),
      ...Array.from({ length: 6 }, (_, i) => ({
        cardId: `w${i}`,
        name: `工坊卡${i}`,
        element: 'water' as const,
        skins: [
          { skinId: `w${i}-s1`, imageUrl: `/uploads/${i}-1.png` },
          { skinId: `w${i}-s2`, imageUrl: `/uploads/${i}-2.png` },
          { skinId: `w${i}-s3`, imageUrl: `/uploads/${i}-3.png` },
        ],
      })),
    ]
    const deck = buildGameDeck(pool, { rng: lcg() })
    expect(deck).toHaveLength(60)
    const byCard = new Map<string, string[]>()
    for (const p of deck) byCard.set(p.cardId!, [...(byCard.get(p.cardId!) ?? []), p.id])
    const repeated = [...byCard.entries()].filter(([, ids]) => ids.length > 1)
    expect(repeated.length).toBeGreaterThan(0)
    for (const [cardId, ids] of repeated) {
      if (ids.length <= 3) expect(new Set(ids).size, `${cardId} 副本皮肤重复`).toBe(ids.length)
    }
  })
})