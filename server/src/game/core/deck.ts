/**
 * 对局牌堆构建（卡牌 + 皮肤模型）：从卡池抽取 60 张，四阶段。
 * 从 client/src/core/deck.ts 同步拷贝（服务端权威裁决，仅 import 需带 .js 扩展名）。
 *
 * 阶段一：单属性卡——18 属性 × 各 2 张名称不同的卡（某属性不足则全取）
 * 阶段二：双属性卡——随机 18 张名称不同的卡（不足则全取）
 * 阶段三：剩余容量——优先抽"还有未用皮肤"的卡（同名副本皮肤互不相同），候选耗尽才全卡池随机
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

/** 一款皮肤（skinId = 皮肤行主键；预设卡内置外观为无图皮肤） */
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

/**
 * 由卡池构建对局牌堆（纯函数，前后端共用）。
 * 无可用皮肤的卡不参战；卡池为空返回空牌堆。
 */
export function buildGameDeck(pool: CardWithSkins[], opts: BuildDeckOptions = {}): Piece[] {
  const rng = opts.rng ?? Math.random
  const size = opts.size ?? DECK_SIZE
  const cards = pool.filter(c => c.skins.length > 0)
  if (cards.length === 0 || size <= 0) return []

  /** 已入选副本数：cardId -> 张数 */
  const picked = new Map<string, number>()
  const countOf = (cardId: string) => picked.get(cardId) ?? 0
  let total = 0
  const take = (c: CardWithSkins) => {
    if (total >= size) return
    picked.set(c.cardId, countOf(c.cardId) + 1)
    total++
  }

  // 阶段一：单属性卡（每属性 2 张名称不同的卡；不足则该属性全取）
  for (const el of ELEMENTS) {
    const singles = shuffled(cards.filter(c => !isDual(c) && c.element === el), rng)
    for (const c of singles.slice(0, PHASE1_PER_ELEMENT)) take(c)
  }
  // 阶段二：双属性卡（随机 18 张名称不同的卡；不足则全取）
  for (const c of shuffled(cards.filter(isDual), rng).slice(0, PHASE2_COUNT)) take(c)

  // 阶段三：补足剩余容量（可重复抽取；优先皮肤未用尽的卡，保证同名副本皮肤不同）
  while (total < size) {
    const spare = cards.filter(c => countOf(c.cardId) < c.skins.length)
    const from = spare.length > 0 ? spare : cards
    take(from[Math.floor(rng() * from.length)])
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