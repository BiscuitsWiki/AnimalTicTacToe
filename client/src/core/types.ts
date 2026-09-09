/**
 * 领域类型定义。
 * 注意：本文件与 engine/ai/pieces 均为纯 TS 规则引擎，不依赖 React/Taro，
 * 后续可直接拷贝到 server 侧复用（服务端权威裁决）。
 */
import type { Element } from './elements'

export type Side = 'red' | 'blue'

/** 起始手牌张数（双方首次行动回合各发 3 张） */
export const TURN_DEAL_BASE = 3
/** 非首个行动回合的抽牌张数 */
export const TURN_DRAW_COUNT = 1
/** 单格叠放上限 */
export const STACK_LIMIT = 8
/** 棋盘格子数（3×3） */
export const BOARD_SIZE = 9
/** 共用牌堆张数（18 属性 × 2 张预设卡） */
export const DECK_SIZE = 36

/** 一张棋子卡 */
export interface Piece {
  id: string
  name: string
  element: Element
}

/** 格子上的叠放层（自底向上，最后一项为最上层） */
export interface StackLayer {
  side: Side
  piece: Piece
}

/** 棋盘单格：叠放制，归属与显示均以最上层为准 */
export interface Cell {
  stack: StackLayer[]
}

/**
 * 回合阶段。回合开始时引擎自动抽牌，故无抽牌阶段。
 * 与架构文档的差异：PENDING_WIN 不作为独立 phase，而是 pendingWin 数据字段——
 * 待胜缓冲期间对手仍要走完正常回合，用正交状态表达更简单。
 */
export type MatchPhase = 'TURN_ACTION' | 'FINISHED'

/** 待胜缓冲：winnerSide 已三连，blocker（对手）需在其回合内叠放打断 */
export interface PendingWin {
  winnerSide: Side
  line: number[]
}

export interface MatchState {
  phase: MatchPhase
  board: Cell[]
  hands: Record<Side, Piece[]>
  /** 牌堆剩余（抽完即止，不重洗） */
  deck: Piece[]
  /** 全局回合序号（红=1，蓝=2，…） */
  turnCount: number
  turnSide: Side
  /** 双方最近一次落子格（下标），null = 尚未落子；公开信息用于棋盘高亮 */
  lastPlaced: Record<Side, number | null>
  /** 最近一手若为跳过则记录其执行方；用于双方连续跳过判平（both_skip），落子会重置为 null */
  lastSkipped: Side | null
  pendingWin: PendingWin | null
  result: MatchResult | null
}

export interface MatchResult {
  winner: Side | 'draw'
  /**
   * line = 三连获胜；board_full = 棋盘全部格子叠满 8 层且无三连平局；both_skip = 双方连续跳过平局；
   * resign = 认输；opponent_disconnect = 对手超时未归
   */
  reason: 'line' | 'board_full' | 'both_skip' | 'resign' | 'opponent_disconnect'
}

/** 一次落子结算产生的事件序列（客户端据此驱动提示与动画） */
export type PlaceEvent =
  | { type: 'placed'; side: Side; cellIdx: number; piece: Piece; stacked: boolean }
  | { type: 'pending_win'; side: Side; line: number[] }
  | { type: 'blocked'; bySide: Side }
  | { type: 'win'; winner: Side; line: number[] }
  | { type: 'draw' }
  /** side 主动认输（result.reason = 'resign'，对方获胜） */
  | { type: 'resigned'; side: Side }
  /**
   * 回合开始自动抽牌：发给 side 的牌（对方/观战视角须脱敏为占位）。
   * 双方首个行动回合发起始 3 张，之后每回合抽 1 张；牌堆为空时不产生该事件。
   */
  | { type: 'dealt'; side: Side; pieces: Piece[] }
  /** side 跳过本回合（不落子，正常换边抽牌）；待胜期守方跳过 = 未阻断 */
  | { type: 'skipped'; side: Side }

/** 规则错误码 */
export type RuleErrorCode =
  | 'NOT_ACTION_PHASE' | 'NOT_YOUR_TURN' | 'NO_PIECE'
  | 'CELL_OWNED' | 'STACK_FULL' | 'NOT_EFFECTIVE' | 'ILLEGAL_TARGET'
  | 'GAME_OVER'

export class RuleError extends Error {
  code: RuleErrorCode
  constructor(code: RuleErrorCode, message?: string) {
    super(message ?? code)
    this.code = code
  }
}
