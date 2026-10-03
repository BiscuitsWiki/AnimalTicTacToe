/**
 * 对局牌堆构建（卡牌 + 皮肤模型）：从卡池抽取 60 张，四阶段。
 * 从 client/src/core/deck.ts 同步拷贝（服务端权威裁决，仅 import 需带 .js 扩展名）。
 *
 * 抽取优先级（2026-10-03 定稿）：
 *   ① 元素尽量均匀——用配额锁在结构层：阶段一每属性 2 张单属性（36 格）+ 阶段二每属性至少 1 张双属性（18 格）
 *   ② 优先抽多皮肤卡——阶段一在属性内取皮肤数多的；阶段二/三的同分判据按皮肤数加权随机（不是硬性排除）
 *
 * 阶段一：单属性卡——18 属性 × 各 2 张名称不同的卡，属性内优先皮肤数多的（选哪 2 张不影响元素分布）
 * 阶段二：双属性卡——按随机属性顺序每属性取 1 张命中该属性的卡（元素覆盖配额）；
 *                      候选以「另一端点当前张数最少」优先（元素优先），同分按皮肤数加权随机
 * 阶段三：剩余容量——未出场新卡优先，其中元素缺口优先，同分按皮肤数加权随机；候选耗尽才退回全池随机
 * 阶段四：皮肤分配——按卡取 k 款互不相同的皮肤（皮肤不足则随机复用），最后整体洗牌
 */
import { ELEMENTS } from './elements.js'
import type { Element } from './elements.js'
import type { Piece } from './types.js'

/** 牌堆总张数 */
export const DECK_SIZE = 60
/** 阶段一：每个单属性抽 2 张（名称不同） */
export const PHASE1_PER_ELEMENT = 2
/** 阶段二：双属性随机抽 18 张（名称不同） */
export const PHASE2_COUNT = 18

/** 一款皮肤（skinId = 皮肤行主键；imageUrl 可选） */
export interface DeckSkin {
  skinId: string
  imageUrl?: string
}

/** 卡牌（同名即同一张：名称与属性唯一）+ 可用皮肤 */
export interface CardWithSkins {
  cardId: string
  name: string
  element: Element
  element2?: Element
  skins: DeckSkin[]
}

export interface BuildDeckOptions {
  /** 牌堆张数（默认 DECK_SIZE） */
  size?: number
  /** 随机源（单测注入用，默认 Math.random） */
  rng?: () => number
}

/** Fisher-Yates 洗牌（不改动入参） */
function shuffled<T>(arr: T[], rng: () => number): T[] {
  const out = [...arr]
  for (let i = out.length - 1; i > 0; i--) {
    const j = Math.floor(rng() * (i + 1))
    ;[out[i], out[j]] = [out[j], out[i]]
  }
  return out
}

/** 双属性卡（副属性存在且与主属性不同） */
function isDual(c: CardWithSkins): boolean {
  return !!c.element2 && c.element2 !== c.element
}

/** 皮肤数降序稳定排序（调用前先洗牌 → 同档随机），用于「属性内优先多皮肤」 */
function bySkinCountDesc(cards: CardWithSkins[]): CardWithSkins[] {
  return [...cards].sort((a, b) => b.skins.length - a.skins.length)
}

/** 按皮肤数加权随机取一张（权重 = 皮肤数，皮肤越多越可能入选；权重恒 ≥ 1，必有返回） */
function pickBySkinWeight(cards: CardWithSkins[], rng: () => number): CardWithSkins {
  let total = 0
  for (const c of cards) total += c.skins.length
  let r = rng() * total
  for (const c of cards) {
    r -= c.skins.length
    if (r < 0) return c
  }
  return cards[cards.length - 1]
}

/**
 * 由卡池构建对局牌堆（纯函数，前后端共用）。
 * 无可用皮肤的卡不参战；卡池为空返回空牌堆。
 */
export function buildGameDeck(pool: CardWithSkins[], opts: BuildDeckOptions = {}): Piece[] {
  const rng = opts.rng ?? Math.random
  const size = opts.size ?? DECK_SIZE
  const cards = pool.filter(c => c.skins.length > 0)
  if (cards.length === 0 || size <= 0) return []

  const byCardId = new Map(cards.map(c => [c.cardId, c]))
  /** 已入选副本数：cardId -> 张数 */
  const picked = new Map<string, number>()
  const countOf = (cardId: string) => picked.get(cardId) ?? 0
  let total = 0
  const take = (c: CardWithSkins) => {
    if (total >= size) return
    picked.set(c.cardId, countOf(c.cardId) + 1)
    total++
  }
  /** 各元素当前张数（双属性主/副属性各计一次） */
  const countElements = (): Map<Element, number> => {
    const m = new Map<Element, number>(ELEMENTS.map(el => [el, 0]))
    for (const [cardId, n] of picked) {
      const c = byCardId.get(cardId)!
      m.set(c.element, m.get(c.element)! + n)
      if (isDual(c)) m.set(c.element2!, m.get(c.element2!)! + n)
    }
    return m
  }

  // 阶段一：单属性卡（每属性 2 张名称不同的卡；不足则该属性全取）——属性内优先多皮肤
  for (const el of ELEMENTS) {
    const singles = shuffled(cards.filter(c => !isDual(c) && c.element === el), rng)
    for (const c of bySkinCountDesc(singles).slice(0, PHASE1_PER_ELEMENT)) take(c)
  }

  // 阶段二：双属性卡——每元素覆盖 1 张（元素优先：另一端点当前张数最少；同分多皮肤优先）
  const duals = shuffled(cards.filter(isDual), rng)
  const takenInPhase2 = new Set<string>()
  for (const el of shuffled(ELEMENTS, rng)) {
    if (total >= size) break
    const cands = duals.filter(c => !takenInPhase2.has(c.cardId) && (c.element === el || c.element2 === el))
    if (cands.length === 0) continue
    const counts = countElements()
    let fewest = Infinity
    let tier: CardWithSkins[] = []
    for (const c of cands) {
      const other = c.element === el ? c.element2! : c.element
      const n = counts.get(other)!
      if (n < fewest) { fewest = n; tier = [c] }
      else if (n === fewest) tier.push(c)
    }
    const card = pickBySkinWeight(tier, rng)
    takenInPhase2.add(card.cardId)
    take(card)
  }

  // 阶段三：补足剩余容量——未出场新卡优先 → 元素缺口优先 → 同分按皮肤数加权随机；耗尽才退回全池随机
  while (total < size) {
    const spare = cards.filter(c => countOf(c.cardId) < c.skins.length)
    const fresh = cards.filter(c => countOf(c.cardId) === 0)
    let from = fresh.length > 0 ? fresh : spare.length > 0 ? spare : cards
    const counts = countElements()
    let fewest = Infinity
    for (const el of ELEMENTS) fewest = Math.min(fewest, counts.get(el)!)
    const gaps = ELEMENTS.filter(el => counts.get(el) === fewest)
    const focus = from.filter(c => gaps.includes(c.element) || (isDual(c) && gaps.includes(c.element2!)))
    if (focus.length > 0) from = focus
    take(pickBySkinWeight(from, rng))
  }

  // 阶段四：皮肤分配（同卡 k 个副本取 k 款互不相同的皮肤；皮肤不足则随机复用）
  const deck: Piece[] = []
  for (const card of cards) {
    const k = countOf(card.cardId)
    if (k === 0) continue
    const skins = shuffled(card.skins, rng)
    for (let i = 0; i < k; i++) {
      const skin = skins[i] ?? skins[Math.floor(rng() * skins.length)]
      deck.push({
        id: skin.skinId,
        cardId: card.cardId,
        name: card.name,
        element: card.element,
        ...(card.element2 ? { element2: card.element2 } : {}),
        ...(skin.imageUrl ? { imageUrl: skin.imageUrl } : {}),
      })
    }
  }
  return shuffled(deck, rng)
}
