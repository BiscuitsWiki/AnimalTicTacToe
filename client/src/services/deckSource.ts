/**
 * 对局牌堆数据源：预设 51 张 + 工坊上架卡全部混合（与服务端 buildDeck 语义一致）。
 * 回合发牌制：初始手牌由引擎在回合开始时自动发，这里只提供牌堆。
 */
import type { Piece } from '../core/types'
import { ELEMENTS } from '../core/elements'
import { PRESET_DECK, freshDeck } from '../core/pieces'
import { shuffle } from '../core/engine'
import { fetchApprovedPieces } from '../services/api'
import type { ApiPiece } from '../services/api'

function toPiece(p: ApiPiece): Piece {
  // 服务端 element 一定在白名单内，这里防御性收窄类型
  const element = (ELEMENTS as string[]).includes(p.element)
    ? (p.element as Piece['element'])
    : 'normal'
  const element2 = p.element2 && (ELEMENTS as string[]).includes(p.element2)
    ? (p.element2 as Piece['element'])
    : undefined
  return { id: p.id, name: p.name, element, element2 }
}

export interface DeckSource {
  deck: Piece[]
}

/** 生成对局牌堆：预设 51 张 + 工坊上架卡全部混合；后端不可达时整副预设 */
export async function buildDeckFromServer(): Promise<DeckSource> {
  try {
    const remote = await fetchApprovedPieces()
    const workshop = remote.map(toPiece)
    return { deck: shuffle([...PRESET_DECK, ...workshop]) }
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
