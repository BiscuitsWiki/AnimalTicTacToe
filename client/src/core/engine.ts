/**
 * 回合状态机与落子结算（服务端权威入口的本地版）。
 *
 * 核心规则（见 ../docs 或架构文档 3.3）：
 * - 回合发牌：每个回合开始时从牌堆自动发 N 张给行动方（N = 3 + 回合数 - 1，上限 6）
 * - 行动二选一：落在空格，或克制叠放在对方格上；每次行动只占据一格
 * - 叠放前置条件：① 目标格属对方 ② 叠放未满 3 层 ③ 行动棋子克制对方最上层
 * - 三连不立即获胜：进入待胜缓冲（pendingWin），对手一整回合内未能叠放打断 → 三连方获胜
 * - 手牌仅当回合有效：落子后剩余手牌保留（供玩家复盘本回合选择），
 *   轮到自己再次行动时才作废并重新发牌；牌堆抽完按 36 张快照重洗；棋盘下满且无三连 → 平局
 */
import { canCapture } from './elements'
import {
  BOARD_SIZE, RuleError, STACK_LIMIT, TURN_DEAL_BASE, TURN_DEAL_MAX,
} from './types'
import type {
  Cell, MatchState, Piece, PlaceEvent, Side,
} from './types'

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

/** 第 turnCount 回合的开始发牌数：3 起步，每回合 +1，封顶 6 */
export function dealCountFor(turnCount: number): number {
  return Math.min(TURN_DEAL_BASE + turnCount - 1, TURN_DEAL_MAX)
}

export interface CreateMatchOptions {
  deck: Piece[]
}

/** 创建对局：红方先行（第 1 回合，自动发 3 张） */
export function createMatch({ deck }: CreateMatchOptions): MatchState {
  const state: MatchState = {
    phase: 'TURN_ACTION',
    board: emptyBoard(),
    hands: { red: [], blue: [] },
    deck: [...deck],
    deckSnapshot: [...deck],
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
 * 回合发牌（替换式）：side 再次行动的回合开始，旧手牌作废、
 * 重置为牌堆新发的 n 张（n 由 turnCount 决定）。
 * 牌堆为空时按快照重洗补足；牌堆与快照均空（退化配置，仅测试出现）则跳过发牌。
 * @returns 发出的牌、作废的旧牌数与是否触发重洗
 */
function dealTo(
  state: MatchState, side: Side,
): { pieces: Piece[]; discarded: number; reshuffled: boolean } {
  // 无循环牌库（空堆+空快照，仅测试构造出现）：不清理不补发，手牌保持原样
  if (state.deck.length === 0 && state.deckSnapshot.length === 0) {
    return { pieces: [], discarded: 0, reshuffled: false }
  }
  let reshuffled = false
  const n = dealCountFor(state.turnCount)
  const discarded = state.hands[side].length
  const pieces: Piece[] = []
  while (pieces.length < n) {
    if (state.deck.length === 0) {
      if (state.deckSnapshot.length === 0) break
      state.deck = shuffle([...state.deckSnapshot])   // 同一套卡循环
      reshuffled = true
    }
    pieces.push(state.deck.shift()!)
  }
  state.hands[side] = pieces
  return { pieces, discarded, reshuffled }
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
    cell.stack.length < STACK_LIMIT &&                           // ② 未满 3 层
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

/** 指定阵营是否存在任意合法落子（假设轮到其行动，用于卡死判定） */
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
 * 4. 棋盘下满且无三连 → 平局
 * 5. 换边进入对手回合（自动发牌）；若对手（待胜阻断方）发牌后仍无任何合法落子 → 待胜方直接获胜
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
  // 记录该方最近落子格（公开信息，棋盘高亮用）；剩余手牌保留至其下次行动回合开始
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
    // 阻断的唯一手段是叠放占领链路上的格子（要求层数 < 3）；
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

  // 5. 换边：进入对手回合并自动发牌
  state.turnSide = opp
  state.turnCount++
  state.phase = 'TURN_ACTION'
  const dealt = dealTo(state, opp)
  if (dealt.pieces.length > 0 || dealt.discarded > 0) {
    events.push({
      type: 'dealt', side: opp, pieces: dealt.pieces,
      discarded: dealt.discarded, reshuffled: dealt.reshuffled,
    })
  }

  // 对手为阻断方且发牌后仍无合法落子 → 待胜方获胜
  if (
    state.pendingWin &&
    state.pendingWin.winnerSide === side &&
    !hasAnyLegalPlacement(state, opp)
  ) {
    state.phase = 'FINISHED'
    state.result = { winner: side, reason: 'line' }
    events.push({ type: 'win', winner: side, line: state.pendingWin.line })
  }
  return events
}

/** Fisher-Yates 洗牌（原地） */
export function shuffle<T>(arr: T[]): T[] {
  for (let i = arr.length - 1; i > 0; i--) {
    const j = Math.floor(Math.random() * (i + 1))
    ;[arr[i], arr[j]] = [arr[j], arr[i]]
  }
  return arr
}
