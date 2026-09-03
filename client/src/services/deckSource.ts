/**
 * 对局牌堆数据源：优先公共池 API，失败/为空时回退本地预设卡。
 * 回合发牌制：初始手牌由引擎在回合开始时自动发，这里只提供牌堆。
 */
import type { Piece } from '../core/types'
import { ELEMENTS } from '../core/elements'
import { PRESET_DECK, freshDeck } from '../core/pieces'
import { fetchApprovedPieces } from '../services/api'
import type { ApiPiece } from '../services/api'

function toPiece(p: ApiPiece): Piece {
  // 服务端 element 一定在白名单内，这里防御性收窄类型
  const element = (ELEMENTS as string[]).includes(p.element)
    ? (p.element as Piece['element'])
    : 'normal'
  return { id: p.id, name: p.name, element }
}

export interface DeckSource {
  deck: Piece[]
}

/** 从公共池生成对局牌堆（36 张互不相同）；池子不足 36 时用预设卡补齐 */
export async function buildDeckFromServer(): Promise<DeckSource> {
  try {
    const remote = await fetchApprovedPieces()
    const pool = remote.map(toPiece)
    if (pool.length >= 36) {
      const shuffled = [...pool].sort(() => Math.random() - 0.5).slice(0, 36)
      return { deck: shuffled }
    }
  } catch {
    // 后端未启动 / 网络失败 → 回退本地
  }
  return { deck: freshDeck() }
}

/** 本地预设（离线兜底） */
export function buildLocalDeck(): DeckSource {
  return { deck: freshDeck() }
}

export { PRESET_DECK }
