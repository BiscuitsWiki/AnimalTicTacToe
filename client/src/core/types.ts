/**
 * 领域类型定义。
 * 注意：本文件与 engine/ai/pieces 均为纯 TS 规则引擎，不依赖 React/Taro，
 * 后续可直接拷贝到 server 侧复用（服务端权威裁决）。
 */
import type { Element } from './elements'

export type Side = 'red' | 'blue'

/** 回合发牌基数：第 1 回合发 3 张 */
export const TURN_DEAL_BASE = 3
/** 回合发牌上限 */
export const TURN_DEAL_MAX = 6
/** 单格叠放上限 */
export const STACK_LIMIT = 3
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
 * 回合阶段。回合开始时引擎自动发牌，故无抽牌阶段。
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
  /** 牌堆剩余（抽完时按 snapshot 重洗） */
  deck: Piece[]
  /** 36 张卡的快照，牌堆耗尽重洗用 */
  deckSnapshot: Piece[]
  /** 全局回合序号（红=1，蓝=2，…），决定回合发牌数 */
  turnCount: number
  turnSide: Side
  /** 双方最近一次落子格（下标），null = 尚未落子；公开信息用于棋盘高亮 */
  lastPlaced: Record<Side, number | null>
  pendingWin: PendingWin | null
  result: MatchResult | null
}

export interface MatchResult {
  winner: Side | 'draw'
  /** line = 三连获胜；board_full = 棋盘下满平局 */
  reason: 'line' | 'board_full'
}

/** 一次落子结算产生的事件序列（客户端据此驱动提示与动画） */
export type PlaceEvent =
  | { type: 'placed'; side: Side; cellIdx: number; piece: Piece; stacked: boolean }
  | { type: 'pending_win'; side: Side; line: number[] }
  | { type: 'blocked'; bySide: Side }
  | { type: 'win'; winner: Side; line: number[] }
  | { type: 'draw' }
  /**
   * 回合开始自动发牌：发给 side 的 N 张（对方/观战视角须脱敏为占位）。
   * discarded：side 上回合剩余、本次行动开始时作废的旧手牌数
   */
  | { type: 'dealt'; side: Side; pieces: Piece[]; discarded: number; reshuffled: boolean }

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
