/**
 * 回合状态机与落子结算（服务端权威裁决入口）。
 * 与 client/src/core/engine.ts 保持同步拷贝。
 *
 * 核心规则（见 ../docs 或架构文档 3.3）：
 * - 抽牌制：双方首个行动回合各发起始手牌 3 张，此后每次轮到行动时从牌堆抽 1 张；
 *   手牌跨回合保留（落 1 抽 1）；牌堆抽完即止，不重洗回牌堆
 * - 行动二选一：落在空格，或克制叠放在对方格上；每次行动只占据一格
 * - 叠放前置条件：① 目标格属对方 ② 叠放未满 8 层 ③ 行动棋子克制对方最上层
 * - 三连不立即获胜：进入待胜缓冲（pendingWin），对手一整回合内未能叠放打断 → 三连方获胜
 * - 换边后若行动方发牌后仍无任何合法落子：有待胜则待胜方获胜，否则僵局判平局（no_moves）
 * - 棋盘九格全部非空且无三连 → 平局
 */
import { canCapture } from './elements.js'
import {
  BOARD_SIZE, RuleError, STACK_LIMIT, TURN_DEAL_BASE, TURN_DRAW_COUNT,
} from './types.js'
import type {
  Cell, MatchState, Piece, PlaceEvent, Side,
} from './types.js'

/** 8 条三连线（格子下标 0~8，行优先） */
export const LINES: readonly number[][] = [
  [0, 1, 2], [3, 4, 5], [6, 7, 8],       // 三行
  [0, 3, 6], [1, 4, 7], [2, 5, 8],       // 三列
  [0, 4, 8], [2, 4, 6],                  // 两对角
]

export function opponent(side: Side): Side {
  return side === 'red' ? 'blue' : 'red'
}

export function sideNameZh(side: Side): string {
  return side === 'red' ? '红方' : '蓝方'
}

/** 深拷贝对局状态（引擎为可变设计，页面/ AI 模拟前先克隆） */
export function cloneState(state: MatchState): MatchState {
  return JSON.parse(JSON.stringify(state)) as MatchState
}

function emptyBoard(): Cell[] {
  return Array.from({ length: BOARD_SIZE }, () => ({ stack: [] }))
}

/** 第 turnCount 回合的开始抽牌数：双方首个行动回合（1、2）发 3 张，之后每回合抽 1 张 */
export function dealCountFor(turnCount: number): number {
  return turnCount <= 2 ? TURN_DEAL_BASE : TURN_DRAW_COUNT
}

export interface CreateMatchOptions {
  deck: Piece[]
}

/** 创建对局：红方先行（第 1 回合，发起始手牌 3 张） */
export function createMatch({ deck }: CreateMatchOptions): MatchState {
  const state: MatchState = {
    phase: 'TURN_ACTION',
    board: emptyBoard(),
    hands: { red: [], blue: [] },
    deck: [...deck],
    turnCount: 1,
    turnSide: 'red',
    lastPlaced: { red: null, blue: null },
    pendingWin: null,
    result: null,
  }
  dealTo(state, 'red')
  return state
}

/**
 * 回合抽牌（累加式）：side 行动回合开始，从牌堆抽 n 张加入手牌
 * （n 由 turnCount 决定：首回合 3 张，其后 1 张）。牌堆为空则跳过（抽完即止，不重洗）。
 * @returns 实际抽到的牌
 */
function dealTo(state: MatchState, side: Side): { pieces: Piece[] } {
  const n = dealCountFor(state.turnCount)
  const pieces: Piece[] = []
  while (pieces.length < n && state.deck.length > 0) {
    pieces.push(state.deck.shift()!)
  }
  state.hands[side].push(...pieces)
  return { pieces }
}

/** 格子当前归属（最上层棋子的阵营），空格返回 null */
export function topSide(cell: Cell): Side | null {
  return cell.stack.length > 0 ? cell.stack[cell.stack.length - 1].side : null
}

/** side 当前的所有三连线 */
export function linesOf(board: Cell[], side: Side): number[][] {
  return LINES.filter(line => line.every(i => topSide(board[i]) === side))
}

/** 指定阵营的某枚棋子对当前棋盘的所有合法落点 */
export function legalCells(state: MatchState, side: Side, piece: Piece): number[] {
  const out: number[] = []
  for (let idx = 0; idx < BOARD_SIZE; idx++) {
    if (isLegalTarget(state.board, side, piece, idx)) out.push(idx)
  }
  return out
}

/** 盘面落点判定（不含回合/阶段校验）：piece 落在 cellIdx 是否符合规则 */
function isLegalTarget(board: Cell[], side: Side, piece: Piece, cellIdx: number): boolean {
  const cell = board[cellIdx]
  if (!cell) return false
  if (cell.stack.length === 0) return true                       // a. 空格
  const top = cell.stack[cell.stack.length - 1]
  return (
    top.side !== side &&                                         // ① 对方格
    cell.stack.length < STACK_LIMIT &&                           // ② 未满 8 层
    canCapture(piece.element, top.piece.element)                 // ③ 克制最上层
  )
}

/** 落子合法性完整判定（不修改状态） */
export function canPlace(
  state: MatchState, side: Side, handIdx: number, cellIdx: number,
): boolean {
  if (state.phase !== 'TURN_ACTION' || state.turnSide !== side) return false
  const hand = state.hands[side]
  if (handIdx < 0 || handIdx >= hand.length) return false
  return isLegalTarget(state.board, side, hand[handIdx], cellIdx)
}

/** 指定阵营是否存在任意合法落子（假设轮到其行动，用于僵局判定） */
export function hasAnyLegalPlacement(state: MatchState, side: Side): boolean {
  for (const piece of state.hands[side]) {
    for (let c = 0; c < BOARD_SIZE; c++) {
      if (isLegalTarget(state.board, side, piece, c)) return true
    }
  }
  return false
}

/**
 * 落子结算（核心入口，直接修改 state）：
 * 1. 校验并落子（空格落子 / 克制叠放二选一）
 * 2. 若对手存在待胜：本次行动后其三连仍在 → 其获胜；被打断 → 清除待胜
 * 3. 我方成三连 → 置待胜缓冲
 * 4. 棋盘九格全部非空且无三连 → 平局
 * 5. 换边进入对手回合（自动抽牌）；对手抽牌后仍无任何合法落子 →
 *    有待胜则待胜方获胜，否则僵局平局（no_moves：手牌用尽或无处可叠）
 */
export function place(
  state: MatchState, side: Side, handIdx: number, cellIdx: number,
): PlaceEvent[] {
  if (state.phase === 'FINISHED') throw new RuleError('GAME_OVER')
  if (state.phase !== 'TURN_ACTION') throw new RuleError('NOT_ACTION_PHASE')
  if (state.turnSide !== side) throw new RuleError('NOT_YOUR_TURN')
  const hand = state.hands[side]
  if (handIdx < 0 || handIdx >= hand.length) throw new RuleError('NO_PIECE')
  const piece = hand[handIdx]
  const cell = state.board[cellIdx]
  if (!cell) throw new RuleError('ILLEGAL_TARGET')

  const events: PlaceEvent[] = []
  const stacked = cell.stack.length > 0

  if (!stacked) {
    cell.stack.push({ side, piece })                           // a. 空格落子
  } else {
    const top = cell.stack[cell.stack.length - 1]
    if (top.side === side) throw new RuleError('CELL_OWNED')
    if (cell.stack.length >= STACK_LIMIT) throw new RuleError('STACK_FULL')
    if (!canCapture(piece.element, top.piece.element)) throw new RuleError('NOT_EFFECTIVE')
    cell.stack.push({ side, piece })                           // b. 克制叠放占领
  }
  hand.splice(handIdx, 1)
  // 记录该方最近落子格（公开信息，棋盘高亮用）；手牌跨回合保留，下次行动回合开始再抽 1 张
  state.lastPlaced[side] = cellIdx
  events.push({ type: 'placed', side, cellIdx, piece, stacked })

  const opp = opponent(side)

  // 2. 对手待胜判定：阻断 or 失败
  if (state.pendingWin && state.pendingWin.winnerSide === opp) {
    if (linesOf(state.board, opp).length === 0) {
      events.push({ type: 'blocked', bySide: side })
      state.pendingWin = null
    } else {
      state.phase = 'FINISHED'
      state.result = { winner: opp, reason: 'line' }
      events.push({ type: 'win', winner: opp, line: state.pendingWin.line })
      return events
    }
  }

  // 3. 我方三连 → 判定链路是否可被阻断
  const myLines = linesOf(state.board, side)
  if (myLines.length > 0) {
    // 阻断的唯一手段是叠放占领链路上的格子（要求层数 < 8）；
    // 链路全部格子已叠满 → 对手永远无法阻断，立即判胜
    const unblockable = myLines.find(line =>
      line.every(i => state.board[i].stack.length >= STACK_LIMIT))
    if (unblockable) {
      state.phase = 'FINISHED'
      state.result = { winner: side, reason: 'line' }
      events.push({ type: 'win', winner: side, line: unblockable })
      return events
    }
    state.pendingWin = { winnerSide: side, line: myLines[0] }
    events.push({ type: 'pending_win', side, line: myLines[0] })
  }

  // 4. 平局：九格全部非空且双方均无三连
  const boardFull = state.board.every(c => c.stack.length > 0)
  if (boardFull && myLines.length === 0 && linesOf(state.board, opp).length === 0) {
    state.phase = 'FINISHED'
    state.result = { winner: 'draw', reason: 'board_full' }
    events.push({ type: 'draw' })
    return events
  }

  // 5. 换边：进入对手回合并自动抽牌
  state.turnSide = opp
  state.turnCount++
  state.phase = 'TURN_ACTION'
  const dealt = dealTo(state, opp)
  if (dealt.pieces.length > 0) {
    events.push({ type: 'dealt', side: opp, pieces: dealt.pieces })
  }

  // 对手抽牌后仍无合法落子：待胜方直接获胜；否则僵局平局（no_moves）
  if (!hasAnyLegalPlacement(state, opp)) {
    state.phase = 'FINISHED'
    if (state.pendingWin && state.pendingWin.winnerSide === side) {
      state.result = { winner: side, reason: 'line' }
      events.push({ type: 'win', winner: side, line: state.pendingWin.line })
    } else {
      state.result = { winner: 'draw', reason: 'no_moves' }
      events.push({ type: 'draw' })
    }
  }
  return events
}

/**
 * 认输结算：side 主动认输，直接判负、对方获胜。
 * 对局已结束时抛 GAME_OVER。
 */
export function resign(state: MatchState, side: Side): PlaceEvent[] {
  if (state.phase === 'FINISHED') throw new RuleError('GAME_OVER')
  const winner = opponent(side)
  state.phase = 'FINISHED'
  state.result = { winner, reason: 'resign' }
  return [{ type: 'resigned', side }]
}

/** Fisher-Yates 洗牌（原地） */
export function shuffle<T>(arr: T[]): T[] {
  for (let i = arr.length - 1; i > 0; i--) {
    const j = Math.floor(Math.random() * (i + 1))
    ;[arr[i], arr[j]] = [arr[j], arr[i]]
  }
  return arr
}
