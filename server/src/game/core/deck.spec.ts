/**
 * 组牌算法（core/deck.ts）单元测试：60 张四阶段抽取。
 * 随机源注入线性同余（可复现），覆盖阶段一的每属性 2 张 / 不足全取、
 * 阶段二 18 张不同名 / 不足全取、阶段三补足与皮肤未用尽优先、阶段四皮肤分配（含复用）。
 */
import { describe, expect, it } from 'vitest'
import { buildGameDeck, DECK_SIZE, PHASE1_PER_ELEMENT, PHASE2_COUNT } from './deck.js'
import type { CardWithSkins } from './deck.js'
import type { Element } from './elements.js'
import { ELEMENTS } from './elements.js'
import type { Piece } from './types.js'

/** 确定性随机源（线性同余） */
function lcg(seed = 20260916): () => number {
  let s = seed
  return () => {
    s = (s * 1664525 + 1013904223) % 4294967296
    return s / 4294967296
  }
}

/** 单属性卡（skins 数可指定） */
function single(cardId: string, element: Element, skinCount = 1, name = cardId): CardWithSkins {
  return {
    cardId,
    name,
    element,
    skins: Array.from({ length: skinCount }, (_, i) => ({ skinId: `${cardId}-s${i + 1}` })),
  }
}

/** 双属性卡 */
function dual(cardId: string, element: Element, element2: Element, skinCount = 1): CardWithSkins {
  return { ...single(cardId, element, skinCount), element2 }
}

/** 预设等价池：18 属性 × 各 2 张单属性卡 + 15 张双属性卡 */
function presetLikePool(): CardWithSkins[] {
  const pool: CardWithSkins[] = []
  ELEMENTS.forEach((el, i) => {
    pool.push(single(`s${i}-1`, el), single(`s${i}-2`, el))
  })
  for (let i = 0; i < 15; i++) {
    pool.push(dual(`d${i}`, ELEMENTS[i], ELEMENTS[(i + 3) % ELEMENTS.length]))
  }
  return pool
}

function distinctNames(deck: Piece[]): number {
  return new Set(deck.map(p => p.cardId)).size
}

describe('buildGameDeck 四阶段组牌', () => {
  it('阶段一 + 阶段二：预设等价池 36 张单属性（每属性 2 张不同名）+ 15 张双属性全部入堆', () => {
    // size = 36 + 15 = 51：阶段三容量为 0，产出即阶段一 + 阶段二
    const deck = buildGameDeck(presetLikePool(), { rng: lcg(), size: 51 })
    expect(deck).toHaveLength(51)
    for (const el of ELEMENTS) {
      const ids = new Set(deck.filter(p => p.element === el && !p.element2).map(p => p.cardId))
      expect(ids.size).toBe(PHASE1_PER_ELEMENT)
    }
    // 双属性卡池仅 15 张 < 18，全部入堆
    expect(deck.filter(p => p.element2)).toHaveLength(15)
    expect(distinctNames(deck)).toBe(51)
  })

  it('默认张数：预设等价池补足到 60（阶段三只重复已入选的卡，不引入新卡）', () => {
    const deck = buildGameDeck(presetLikePool(), { rng: lcg() })
    expect(deck).toHaveLength(DECK_SIZE)
    expect(distinctNames(deck)).toBe(51)
  })

  it('阶段一：某属性不足 2 张时该属性全取，其余属性仍各 2 张', () => {
    const pool = ELEMENTS
      .filter(el => el !== 'fire')
      .flatMap((el, i) => [single(`s${i}-1`, el), single(`s${i}-2`, el)])
    pool.push(single('fire-only', 'fire'))          // fire 只有 1 张单属性卡
    // size = 17 × 2 + 1 = 35：阶段三容量为 0
    const deck = buildGameDeck(pool, { rng: lcg(), size: 35 })
    expect(deck).toHaveLength(35)
    const distinctSingles = (el: Element) => new Set(deck.filter(p => p.element === el && !p.element2).map(p => p.cardId)).size
    expect(distinctSingles('fire')).toBe(1)
    for (const el of ELEMENTS.filter(e => e !== 'fire')) {
      expect(distinctSingles(el)).toBe(2)
    }
  })

  it('阶段二：双属性超过 18 张只取 18 张不同名的卡；不足则全取', () => {
    const singles: CardWithSkins[] = ELEMENTS.flatMap((el, i) => [single(`s${i}-1`, el), single(`s${i}-2`, el)])
    const many: CardWithSkins[] = [...singles]
    for (let i = 0; i < 25; i++) many.push(dual(`d${i}`, ELEMENTS[i % 18], ELEMENTS[(i + 5) % 18]))
    // size = 36 + 18 = 54：阶段三容量为 0，双属性产出即阶段二结果
    const deckA = buildGameDeck(many, { rng: lcg(), size: 54 })
    expect(deckA).toHaveLength(54)
    const dualsA = deckA.filter(p => p.element2)
    expect(dualsA).toHaveLength(PHASE2_COUNT)
    expect(new Set(dualsA.map(p => p.cardId)).size).toBe(PHASE2_COUNT)
    expect(deckA.filter(p => !p.element2)).toHaveLength(36)

    const few: CardWithSkins[] = [...singles]
    for (let i = 0; i < 10; i++) few.push(dual(`e${i}`, ELEMENTS[i], ELEMENTS[(i + 2) % 18]))
    // size = 36 + 10 = 46：阶段三容量为 0
    const deckB = buildGameDeck(few, { rng: lcg(), size: 46 })
    expect(deckB.filter(p => p.element2)).toHaveLength(10)
  })

  it('阶段三：优先抽"还有未用皮肤"的卡 —— 同名副本皮肤互不相同', () => {
    // 池中全部卡皮肤数 ≥ 2，补足的重复副本必然能拿到不同皮肤
    const pool = presetLikePool().map(c => ({ ...c, skins: [...c.skins, { skinId: `${c.cardId}-extra` }] }))
    const deck = buildGameDeck(pool, { rng: lcg() })
    expect(deck).toHaveLength(DECK_SIZE)
    const byCard = new Map<string, string[]>()
    for (const p of deck) {
      byCard.set(p.cardId!, [...(byCard.get(p.cardId!) ?? []), p.id])
    }
    const repeated = [...byCard.entries()].filter(([, ids]) => ids.length > 1)
    expect(repeated.length).toBeGreaterThan(0)          // 阶段三确实产生了重复副本
    for (const [cardId, ids] of repeated) {
      expect(new Set(ids).size, `${cardId} 的副本应使用不同皮肤`).toBe(ids.length)
    }
  })

  it('阶段三：所有卡皮肤都用尽时退化为随机重复（同名同皮）', () => {
    const pool = presetLikePool()      // 每张卡仅 1 款皮肤
    const deck = buildGameDeck(pool, { rng: lcg() })
    expect(deck).toHaveLength(DECK_SIZE)
    const byCard = new Map<string, string[]>()
    for (const p of deck) byCard.set(p.cardId!, [...(byCard.get(p.cardId!) ?? []), p.id])
    const over = [...byCard.entries()].filter(([, ids]) => ids.length > 1)
    expect(over.length).toBeGreaterThan(0)
    for (const [, ids] of over) expect(new Set(ids).size).toBe(1)   // 只有 1 款皮肤 → 必然同皮
  })

  it('阶段四：副本数超过皮肤数时随机复用，牌堆张数仍精确等于 size', () => {
    const deck = buildGameDeck([single('one', 'normal')], { rng: lcg(), size: 4 })
    expect(deck).toHaveLength(4)
    expect(deck.every(p => p.id === 'one-s1')).toBe(true)
  })

  it('牌面映射：皮肤 id / 卡牌 id / 主副属性 / 图片按卡与皮肤正确装配', () => {
    const card: CardWithSkins = {
      cardId: 'c1',
      name: '测试卡',
      element: 'fire',
      element2: 'cute',
      skins: [{ skinId: 'sk-a', imageUrl: '/uploads/a.png' }, { skinId: 'sk-b' }],
    }
    const deck = buildGameDeck([{ ...card, skins: [card.skins[0]] }], { rng: lcg(), size: 1 })
    expect(deck).toHaveLength(1)
    expect(deck[0]).toEqual({
      id: 'sk-a',
      cardId: 'c1',
      name: '测试卡',
      element: 'fire',
      element2: 'cute',
      imageUrl: '/uploads/a.png',
    })
  })

  it('边界：空卡池 / 无皮肤卡 / size<=0 返回空牌堆', () => {
    expect(buildGameDeck([], { rng: lcg() })).toEqual([])
    expect(buildGameDeck([{ cardId: 'c1', name: '无皮肤', element: 'fire', skins: [] }], { rng: lcg() })).toEqual([])
    expect(buildGameDeck([single('one', 'fire')], { rng: lcg(), size: 0 })).toEqual([])
  })

  it('常量守护：牌堆 60 张 / 阶段一每属性 2 张 / 阶段二 18 张', () => {
    expect(DECK_SIZE).toBe(60)
    expect(PHASE1_PER_ELEMENT).toBe(2)
    expect(PHASE2_COUNT).toBe(18)
  })
})