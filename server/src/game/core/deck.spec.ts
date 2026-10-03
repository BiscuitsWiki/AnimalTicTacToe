/**
 * 组牌算法（core/deck.ts）单元测试：60 张四阶段抽取。
 * 随机源注入线性同余（可复现），覆盖阶段一的每属性 2 张 / 不足全取 / 属性内多皮肤优先、
 * 阶段二 18 张不同名 / 元素覆盖配额、阶段三未出场新卡与元素缺口优先、阶段四皮肤分配（含复用）。
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

/** 满池夹具：18 属性 × 各 2 张单属性卡 + 15 张双属性卡 */
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

function distinctNames(deck: Piece[]): number {
  return new Set(deck.map(p => p.cardId)).size
}

describe('buildGameDeck 四阶段组牌', () => {
  it('阶段一 + 阶段二：满池夹具 36 张单属性（每属性 2 张不同名）+ 15 张双属性全部入堆', () => {
    // size = 36 + 15 = 51：阶段三容量为 0，产出即阶段一 + 阶段二
    const deck = buildGameDeck(fullPool(), { rng: lcg(), size: 51 })
    expect(deck).toHaveLength(51)
    for (const el of ELEMENTS) {
      const ids = new Set(deck.filter(p => p.element === el && !p.element2).map(p => p.cardId))
      expect(ids.size).toBe(PHASE1_PER_ELEMENT)
    }
    // 双属性卡池仅 15 张 < 18，全部入堆
    expect(deck.filter(p => p.element2)).toHaveLength(15)
    expect(distinctNames(deck)).toBe(51)
  })

  it('默认张数：满池夹具补足到 60（阶段三只重复已入选的卡，不引入新卡）', () => {
    const deck = buildGameDeck(fullPool(), { rng: lcg() })
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
    const pool = fullPool().map(c => ({ ...c, skins: [...c.skins, { skinId: `${c.cardId}-extra` }] }))
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
    const pool = fullPool()      // 每张卡仅 1 款皮肤
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

/**
 * 抽取优先级（① 元素尽量均匀 ② 优先多皮肤卡）：
 * 元素均匀由配额锁在结构层（阶段一每属性 2 张单属性 + 阶段二每元素至少 1 张双属性），
 * 配额内部的选卡自由度与同分判据让给多皮肤优先。
 */
describe('buildGameDeck 抽取优先级', () => {
  /** 元素直方图极差（双属性主/副属性各计一次） */
  function elementRange(deck: Piece[]): number {
    const cnt = new Map<Element, number>(ELEMENTS.map(el => [el, 0]))
    for (const p of deck) {
      cnt.set(p.element, cnt.get(p.element)! + 1)
      if (p.element2 && p.element2 !== p.element) cnt.set(p.element2, cnt.get(p.element2)! + 1)
    }
    const vals = [...cnt.values()]
    return Math.max(...vals) - Math.min(...vals)
  }

  /** 成长池：18 属性 × 各 2 张单属性 + 36 张环状双属性（每属性度 4，覆盖全部 18 属性） */
  function grownPool(): CardWithSkins[] {
    const pool: CardWithSkins[] = []
    ELEMENTS.forEach((el, i) => pool.push(single(`s${i}-1`, el), single(`s${i}-2`, el)))
    for (let i = 0; i < 36; i++) pool.push(dual(`d${i}`, ELEMENTS[i % 18], ELEMENTS[(i + 1) % 18]))
    return pool
  }

  /** 偏科池：仅 12 个属性有单属性卡（电/冰/毒/虫/龙/武 只存在于双属性卡上）；共 72 张 > 牌堆 60 */
  const NO_SINGLE: Element[] = ['electric', 'ice', 'poison', 'bug', 'dragon', 'martial']
  function skewedPool(): CardWithSkins[] {
    const pool: CardWithSkins[] = []
    for (const el of ELEMENTS.filter(e => !NO_SINGLE.includes(e))) {
      pool.push(single(`${el}-1`, el), single(`${el}-2`, el))
    }
    for (let i = 0; i < 48; i++) pool.push(dual(`d${i}`, ELEMENTS[i % 18], ELEMENTS[(i + 1) % 18]))
    return pool
  }

  it('阶段一：属性内优先皮肤数多的卡，且每属性仍恰好 2 张（选卡不影响元素分布）', () => {
    const pool: CardWithSkins[] = [
      single('f1', 'fire', 1), single('f2', 'fire', 1), single('f3', 'fire', 2), single('f4', 'fire', 3),
    ]
    for (const el of ELEMENTS.filter(e => e !== 'fire')) pool.push(single(`${el}-1`, el), single(`${el}-2`, el))
    // size = 36 = 18 × 2：只走阶段一，无阶段二/三干扰
    const deck = buildGameDeck(pool, { rng: lcg(), size: 36 })
    expect(deck).toHaveLength(36)
    expect(new Set(deck.filter(p => p.element === 'fire').map(p => p.cardId))).toEqual(new Set(['f3', 'f4']))
    for (const el of ELEMENTS) {
      expect(new Set(deck.filter(p => p.element === el && !p.element2).map(p => p.cardId)).size, el).toBe(PHASE1_PER_ELEMENT)
    }
  })

  it('阶段二：双属性超过 18 张时，每个元素都至少有 1 张双属性卡涉及（元素覆盖配额）', () => {
    // size = 36 + 18 = 54：阶段三容量为 0，双属性产出即阶段二结果
    const deck = buildGameDeck(grownPool(), { rng: lcg(), size: 54 })
    const duals = deck.filter(p => p.element2)
    expect(duals).toHaveLength(PHASE2_COUNT)
    expect(new Set(duals.map(p => p.cardId)).size).toBe(PHASE2_COUNT)
    for (const el of ELEMENTS) {
      expect(duals.some(p => p.element === el || p.element2 === el), `${el} 无任何双属性卡涉及`).toBe(true)
    }
  })

  it('阶段三：卡池大于牌堆张数时优先未出场新卡（60 张全部不同名，不产生副本）', () => {
    const pool = grownPool()
    expect(pool).toHaveLength(72)
    const deck = buildGameDeck(pool, { rng: lcg() })
    expect(deck).toHaveLength(DECK_SIZE)
    expect(distinctNames(deck)).toBe(DECK_SIZE)
  })

  it('同分判据按皮肤数加权随机：权重 = 皮肤数，按随机落点决定而非硬性优先', () => {
    // fire 的两张单属性卡给 4 款皮肤 → 阶段一取走它们；X(3 皮肤) / Y(1 皮肤) 留到阶段三。
    // size 37 = 36 + 1：阶段三恰好 1 格，候选只有 X / Y
    const pool: CardWithSkins[] = []
    ELEMENTS.forEach(el => {
      const n = el === 'fire' ? 4 : 1
      pool.push(single(`${el}-a`, el, n), single(`${el}-b`, el, n))
    })
    pool.push(single('X', 'fire', 3), single('Y', 'fire', 1))
    // 候选权重 X:Y = 3:1，总权重 4：落点 0.7 → 2.8 < 3 选 X；落点 0.8 → 3.2 ≥ 3 选 Y
    const picked = (r: number) => new Set(buildGameDeck(pool, { rng: () => r, size: 37 }).map(p => p.cardId))

    const low = picked(0.7)
    expect(low.has('X')).toBe(true)
    expect(low.has('Y')).toBe(false)

    // 硬性"多皮肤优先"在这里也会选 X；按权重随机则会落到 Y
    const high = picked(0.8)
    expect(high.has('Y')).toBe(true)
    expect(high.has('X')).toBe(false)
  })

  it('加权随机使多皮肤卡出场率高于单皮肤卡（同分判据，非硬性排除）', () => {
    // 每隔 4 张加第 2 款皮肤；单属性卡被阶段一全取（恒 100%），故只在双属性卡之间比较
    const pool = grownPool().map((c, i) => (i % 4 === 0 ? { ...c, skins: [...c.skins, { skinId: `${c.cardId}-x` }] } : c))
    const duals = pool.filter(c => c.element2 && c.element2 !== c.element)
    let multiHit = 0, multiN = 0, singleHit = 0, singleN = 0
    for (let seed = 1000; seed < 1060; seed++) {
      const inDeck = new Set(buildGameDeck(pool, { rng: lcg(seed) }).map(p => p.cardId))
      for (const c of duals) {
        if (c.skins.length > 1) { multiN++; if (inDeck.has(c.cardId)) multiHit++ }
        else { singleN++; if (inDeck.has(c.cardId)) singleHit++ }
      }
    }
    expect(multiHit / multiN).toBeGreaterThan(singleHit / singleN)
    for (const el of ELEMENTS) {
      expect(new Set(buildGameDeck(pool, { rng: lcg(1) }).filter(p => p.element === el && !p.element2).map(p => p.cardId)).size, el).toBe(PHASE1_PER_ELEMENT)
    }
  })

  it('阶段三：元素缺口优先——偏科池的元素极差小于纯随机 60 张，且无属性缺席', () => {
    const pool = skewedPool()
    const seeds = [11, 22, 33, 44, 55]
    /** 对照组：同池，无配额、逐张均匀随机（可重复）抽满 60 张 */
    const naiveRange = (seed: number) => {
      const r = lcg(seed)
      const cnt = new Map<Element, number>(ELEMENTS.map(el => [el, 0]))
      for (let i = 0; i < DECK_SIZE; i++) {
        const c = pool[Math.floor(r() * pool.length)]
        cnt.set(c.element, cnt.get(c.element)! + 1)
        if (c.element2 && c.element2 !== c.element) cnt.set(c.element2, cnt.get(c.element2)! + 1)
      }
      const vals = [...cnt.values()]
      return Math.max(...vals) - Math.min(...vals)
    }
    const avg = (xs: number[]) => xs.reduce((a, b) => a + b, 0) / xs.length
    const mine = seeds.map(seed => {
      const deck = buildGameDeck(pool, { rng: lcg(seed) })
      expect(deck).toHaveLength(DECK_SIZE)
      expect(distinctNames(deck)).toBe(DECK_SIZE)          // 池 72 > 60：全部不同名
      // 无单属性卡的 6 个属性只靠双属性卡参与，覆盖配额 + 缺口优先应保证其不缺席
      for (const el of ELEMENTS) {
        expect(deck.some(p => p.element === el || p.element2 === el), `${el} 缺席`).toBe(true)
      }
      return elementRange(deck)
    })
    expect(avg(mine)).toBeLessThan(avg(seeds.map(naiveRange)))
  })
})