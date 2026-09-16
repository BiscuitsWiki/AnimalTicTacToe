/**
 * 对局牌堆数据源（与服务端 buildDeck 同源）：
 * 卡池 = 预设 51 张卡 + 有上架皮肤的工坊卡，按 core/deck.ts 四阶段抽 60 张（同名卡分配不同皮肤）。
 * 回合发牌制：初始手牌由引擎在回合开始时自动发，这里只提供牌堆。
 */
import type { Piece } from '../core/types'
import { ELEMENTS } from '../core/elements'
import type { Element } from '../core/elements'
import { PRESET_CARDS, freshDeck } from '../core/pieces'
import { buildGameDeck } from '../core/deck'
import type { CardWithSkins, DeckSkin } from '../core/deck'
import { fetchApprovedPieces } from '../services/api'
import type { ApiPiece } from '../services/api'

export interface DeckSource {
  deck: Piece[]
}

/** 由公共池皮肤列表组装卡池（按名称归并：同名即同一张卡） */
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
  // 预设卡：代码为权威（内置无图外观恒可用，库中同名卡的上架皮肤并入）
  for (const preset of PRESET_CARDS) {
    const row = byName.get(preset.name)
    byName.delete(preset.name)
    pool.push({
      ...preset,
      cardId: row?.cardId ?? preset.cardId,
      skins: [
        ...preset.skins,
        ...(row?.skins ?? []).filter(s => !preset.skins.some(x => x.skinId === s.skinId)),
      ],
    })
  }
  // 工坊卡：有上架皮肤才参战
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

/** 生成对局牌堆：预设 + 工坊上架皮肤（60 张四阶段）；后端不可达时整副预设兜底 */
export async function buildDeckFromServer(): Promise<DeckSource> {
  try {
    const remote = await fetchApprovedPieces()
    return { deck: buildGameDeck(buildPoolFromApproved(remote)) }
  } catch {
    // 后端未启动 / 网络失败 → 回退本地
  }
  return { deck: freshDeck() }
}

/** 本地预设（离线兜底） */
export function buildLocalDeck(): DeckSource {
  return { deck: freshDeck() }
}