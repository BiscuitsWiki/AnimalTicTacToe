/**
 * 棋盘"最近一手"标记判定（纯函数，供对战页渲染与单元测试共用）。
 */
import type { Side } from '../../core/types'

/** 单格"最近一手"标记判定结果 */
export interface LastMarks {
  /** 该格是红方最近一手落点 */
  isLastRed: boolean
  /** 该格是蓝方最近一手落点 */
  isLastBlue: boolean
  /** 双方最近一手同格（一手盖住对方最近一手）：渲染层据此错开角标（红左上/蓝左下）并显示双色环光晕 */
  lastBoth: boolean
}

/**
 * 判定第 idx 格的"最近一手"标记。
 * 双方 lastPlaced 各自独立记录：盖住对方最近一手时两值落在同一格（lastBoth=true），
 * 之后任意一方落向他处即自然分离。
 */
export function lastMarks(lastPlaced: Record<Side, number | null>, idx: number): LastMarks {
  const isLastRed = lastPlaced.red === idx
  const isLastBlue = lastPlaced.blue === idx
  return { isLastRed, isLastBlue, lastBoth: isLastRed && isLastBlue }
}
