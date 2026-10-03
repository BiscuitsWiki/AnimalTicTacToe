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

/**
 * 抽取优先级（与服务端一致）：① 元素尽量均匀——配额锁在结构层
 * （阶段一每属性 2 张单属性 + 阶段二每元素至少 1 张双属性）；② 优先抽多皮肤卡。
 */
describe('客户端 buildGameDeck 抽取优先级', () => {
  /** 成长池：18 属性 × 各 2 张单属性 + 36 张环状双属性（每属性度 4） */
  function grownPool(): CardWithSkins[] {
    const pool: CardWithSkins[] = []
    ELEMENTS.forEach((el, i) => pool.push(single(`s${i}-1`, el), single(`s${i}-2`, el)))
    for (let i = 0; i < 36; i++) pool.push(dual(`d${i}`, ELEMENTS[i % 18], ELEMENTS[(i + 1) % 18]))
    return pool
  }

  it('与线上 40 张池同构：属性内优先多皮肤，每属性仍恰好 2 张单属性', () => {
    const pool: CardWithSkins[] = [
      single('f1', 'fire', 1), single('f2', 'fire', 1), single('f3', 'fire', 2), single('f4', 'fire', 3),
    ]
    for (const el of ELEMENTS.filter(e => e !== 'fire')) pool.push(single(`${el}-1`, el), single(`${el}-2`, el))
    const deck = buildGameDeck(pool, { rng: lcg(), size: 36 })
    expect(deck).toHaveLength(36)
    expect(new Set(deck.filter(p => p.element === 'fire').map(p => p.cardId))).toEqual(new Set(['f3', 'f4']))
    for (const el of ELEMENTS) {
      expect(new Set(deck.filter(p => p.element === el && !p.element2).map(p => p.cardId)).size, el).toBe(2)
    }
  })

  it('阶段二：双属性超过 18 张时每个元素都有双属性卡涉及；池 > 牌堆时 60 张全部不同名', () => {
    const pool = grownPool()
    const capped = buildGameDeck(pool, { rng: lcg(), size: 54 })
    const duals = capped.filter(p => p.element2)
    expect(duals).toHaveLength(PHASE2_COUNT)
    for (const el of ELEMENTS) {
      expect(duals.some(p => p.element === el || p.element2 === el), `${el} 无任何双属性卡涉及`).toBe(true)
    }

    const deck = buildGameDeck(pool, { rng: lcg() })
    expect(deck).toHaveLength(DECK_SIZE)
    expect(new Set(deck.map(p => p.cardId)).size).toBe(DECK_SIZE)
  })

  it('同分判据按皮肤数加权随机：权重 = 皮肤数（与服务端一致）', () => {
    // fire 的两张单属性卡给 4 款皮肤 → 阶段一取走它们；X(3 皮肤) / Y(1 皮肤) 留到阶段三。
    // size 37 = 36 + 1：阶段三恰 1 格，候选只有 X / Y
    const pool: CardWithSkins[] = []
    ELEMENTS.forEach(el => {
      const n = el === 'fire' ? 4 : 1
      pool.push(single(`${el}-a`, el, n), single(`${el}-b`, el, n))
    })
    pool.push(single('X', 'fire', 3), single('Y', 'fire', 1))
    const picked = (r: number) => new Set(buildGameDeck(pool, { rng: () => r, size: 37 }).map(p => p.cardId))

    // 权重 X:Y = 3:1，总权重 4：落点 0.7 → 2.8 < 3 选 X
    const low = picked(0.7)
    expect(low.has('X')).toBe(true)
    expect(low.has('Y')).toBe(false)

    // 硬性"多皮肤优先"在这里也会选 X；按权重随机则落到 Y
    const high = picked(0.8)
    expect(high.has('Y')).toBe(true)
    expect(high.has('X')).toBe(false)
  })
})