/**
 * 对局牌堆数据源（与服务端 buildDeck 同源）：
 * 卡池 = 有 ≥1 张上架（approved）皮肤的卡，按 core/deck.ts 四阶段组牌（牌堆张数随卡池自适应，同名卡分配不同皮肤）。
 * 回合发牌制：初始手牌由引擎在回合开始时自动发，这里只提供牌堆。
 */
import type { Piece } from '../core/types'
import { ELEMENTS } from '../core/elements'
import type { Element } from '../core/elements'
import { buildGameDeck } from '../core/deck'
import type { CardWithSkins, DeckSkin } from '../core/deck'
import { fetchApprovedPieces } from '../services/api'
import type { ApiPiece } from '../services/api'

export interface DeckSource {
  deck: Piece[]
}

/** 组牌失败原因：server_down = 后端不可达；pool_empty = 公共池无上架卡 */
export type DeckBuildFailure = 'server_down' | 'pool_empty'

export type DeckBuildResult = ({ ok: true } & DeckSource) | { ok: false; reason: DeckBuildFailure }

/** 由公共池皮肤列表组装卡池（按名称归并：同名即同一张卡；无上架皮肤不参战） */
export function buildPoolFromApproved(approved: ApiPiece[]): CardWithSkins[] {
  const byName = new Map<string, { cardId: string; element: string; element2?: string | null; skins: DeckSkin[] }>()
  for (const p of approved) {
    const entry = byName.get(p.name) ?? { cardId: p.cardId, element: p.element, element2: p.element2, skins: [] }
    if (!entry.skins.some(s => s.skinId === p.id)) {
      entry.skins.push({ skinId: p.id, ...(p.imageUrl ? { imageUrl: p.imageUrl } : {}) })
    }
    byName.set(p.name, entry)
  }

  const pool: CardWithSkins[] = []
  for (const [name, row] of byName) {
    if (row.skins.length === 0) continue
    const element = (ELEMENTS as string[]).includes(row.element) ? row.element as Element : 'normal'
    const element2 = row.element2 && row.element2 !== row.element && (ELEMENTS as string[]).includes(row.element2)
      ? row.element2 as Element
      : undefined
    pool.push({
      cardId: row.cardId,
      name,
      element,
      ...(element2 ? { element2 } : {}),
      skins: row.skins,
    })
  }
  return pool
}

/** 生成对局牌堆：仅有上架皮肤的卡（四阶段，张数随卡池自适应）；后端不可达或公共池为空时返回失败原因 */
export async function buildDeckFromServer(): Promise<DeckBuildResult> {
  let remote: ApiPiece[]
  try {
    remote = await fetchApprovedPieces()
  } catch {
    return { ok: false, reason: 'server_down' }
  }
  const deck = buildGameDeck(buildPoolFromApproved(remote))
  if (deck.length === 0) return { ok: false, reason: 'pool_empty' }
  return { ok: true, deck }
}