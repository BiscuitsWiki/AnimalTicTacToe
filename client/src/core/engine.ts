/**
 * 回合状态机与落子结算（服务端权威入口的本地版）。
 *
 * 核心规则（见 ../docs 或架构文档 3.3）：
 * - 抽牌制：开局即向双方各发起始手牌 3 张（后手第 1 回合即可见手牌），
 *   此后每次轮到行动时从牌堆抽 1 张；手牌跨回合保留（落 1 抽 1）；牌堆抽完即止，不重洗回牌堆
 * - 手牌上限 3：抽牌后超出上限的最新抽到的牌直接撕毁（不进手牌、不回牌堆），
 *   防跳过/拖时间囤牌
 * - 行动二选一：落在空格，或克制叠放在对方格上；每次行动只占据一格；
 *   也可跳过本回合（不落子，正常换边抽牌）
 * - 叠放前置条件：① 目标格属对方 ② 叠放未满 8 层 ③ 行动棋子克制对方最上层
 * - 三连不立即获胜：进入待胜缓冲（pendingWin），对手一整回合内未能叠放打断（跳过 = 未阻断）→ 三连方获胜
 * - 平局判定（二选一即平）：① 棋盘九格全部叠满 8 层且无三连 ② 双方连续跳过（both_skip）；
 *   任意一方落子则重置连续跳过计数，游戏继续
 */
import { canCapture } from './elements'
import {
  BOARD_SIZE, HAND_LIMIT, RuleError, STACK_LIMIT, TURN_DEAL_BASE, TURN_DRAW_COUNT,
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

/**
 * 第 turnCount 回合的开始补牌数：起始手牌已在开局双发，双方各自首个行动回合（1、2）
 * 不再补牌，之后每回合抽 1 张。
 */
export function dealCountFor(turnCount: number): number {
  return turnCount <= 2 ? 0 : TURN_DRAW_COUNT
}

export interface CreateMatchOptions {
  deck: Piece[]
}

/** 创建对局：红方先行（第 1 回合）；开局即向双方各发起始手牌 3 张（后手无需等到首次行动才见牌） */
export function createMatch({ deck }: CreateMatchOptions): MatchState {
  const state: MatchState = {
    phase: 'TURN_ACTION',
    board: emptyBoard(),
    hands: { red: [], blue: [] },
    deck: [...deck],
    turnCount: 1,
    turnSide: 'red',
    lastPlaced: { red: null, blue: null },
    lastSkipped: null,
    pendingWin: null,
    result: null,
  }
  dealTo(state, 'red', TURN_DEAL_BASE)
  dealTo(state, 'blue', TURN_DEAL_BASE)
  return state
}

/**
 * 回合抽牌（累加式）：side 行动回合开始，从牌堆抽 n 张加入手牌
 * （n 缺省由 turnCount 决定：前两回合 0 张（起始手牌已开局双发），其后 1 张；
 * createMatch 显式传 TURN_DEAL_BASE 发起始手牌）。牌堆为空则跳过（抽完即止，不重洗）。
 * 手牌上限（HAND_LIMIT=3）：抽牌后超出上限的（即最新抽到的）牌直接撕毁——
 * 不进手牌、不回牌堆（防跳过/拖时间囤牌）。
 * @returns pieces = 实际留在手牌的新牌；shredded = 因超上限被撕毁的牌
 */
function dealTo(state: MatchState, side: Side, n = dealCountFor(state.turnCount)): { pieces: Piece[]; shredded: Piece[] } {
  const pieces: Piece[] = []
  while (pieces.length < n && state.deck.length > 0) {
    pieces.push(state.deck.shift()!)
  }
  state.hands[side].push(...pieces)
  let shredded: Piece[] = []
  // 仅在实际抽到牌时裁上限：没抽牌（牌堆空）不动手牌（撕的只能是"最新抽到的"）
  if (pieces.length > 0 && state.hands[side].length > HAND_LIMIT) {
    shredded = state.hands[side].splice(HAND_LIMIT)   // 撕掉最末尾 = 最新抽到的（必为新牌尾部）
  }
  // dealt 事件只报实际留在手牌的新牌（被撕的不重复计入）
  const kept = shredded.length > 0 ? pieces.slice(0, pieces.length - shredded.length) : pieces
  return { pieces: kept, shredded }
}

/** 换边抽牌事件化：kept 入 dealt、超额入 shredded（均为空则不产生事件） */
function dealEvents(state: MatchState, side: Side): PlaceEvent[] {
  const dealt = dealTo(state, side)
  const events: PlaceEvent[] = []
  if (dealt.pieces.length > 0) {
    events.push({ type: 'dealt', side, pieces: dealt.pieces })
  }
  if (dealt.shredded.length > 0) {
    events.push({ type: 'shredded', side, pieces: dealt.shredded })
  }
  return events
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
    canCapture(piece, top.piece)                                 // ③ 克制最上层（双属性择优）
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
 * 4. 棋盘九格全部叠满 8 层且无三连 → 平局（board_full）
 * 5. 换边进入对手回合（自动抽牌）；落子重置连续跳过计数。
 *    对手若无合法落子，可主动跳过（见 skip），不再自动判平
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
    if (!canCapture(piece, top.piece)) throw new RuleError('NOT_EFFECTIVE')
    cell.stack.push({ side, piece })                           // b. 克制叠放占领
  }
  hand.splice(handIdx, 1)
  // 记录该方最近落子格（公开信息，棋盘高亮用）；手牌跨回合保留，下次行动回合开始再抽 1 张；
  // 落子重置连续跳过计数（任意一方继续下棋则游戏继续）
  state.lastPlaced[side] = cellIdx
  state.lastSkipped = null
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

  // 4. 平局：九格全部叠满 8 层且双方均无三连
  const boardFull = state.board.every(c => c.stack.length >= STACK_LIMIT)
  if (boardFull && myLines.length === 0 && linesOf(state.board, opp).length === 0) {
    state.phase = 'FINISHED'
    state.result = { winner: 'draw', reason: 'board_full' }
    events.push({ type: 'draw' })
    return events
  }

  // 5. 换边：进入对手回合并自动抽牌（对手无合法落子时可主动跳过；手牌满则新牌被撕）
  state.turnSide = opp
  state.turnCount++
  state.phase = 'TURN_ACTION'
  events.push(...dealEvents(state, opp))
  return events
}

/**
 * 跳过回合：本轮不落子，正常换边并由对手抽牌。
 * - 待胜缓冲期守方跳过 = 放弃阻断 → 三连方直接获胜
 * - 双方连续跳过（上一手也是跳过）→ 平局（both_skip）
 * - 对局已结束时抛 GAME_OVER；非本回合抛 NOT_YOUR_TURN
 */
export function skip(state: MatchState, side: Side): PlaceEvent[] {
  if (state.phase === 'FINISHED') throw new RuleError('GAME_OVER')
  if (state.phase !== 'TURN_ACTION' || state.turnSide !== side) throw new RuleError('NOT_YOUR_TURN')

  const events: PlaceEvent[] = [{ type: 'skipped', side }]
  const opp = opponent(side)

  // 1. 待胜期守方跳过 = 未阻断 → 三连方获胜
  if (state.pendingWin && state.pendingWin.winnerSide === opp) {
    state.phase = 'FINISHED'
    state.result = { winner: opp, reason: 'line' }
    events.push({ type: 'win', winner: opp, line: state.pendingWin.line })
    return events
  }

  // 2. 双方连续跳过 → 平局
  if (state.lastSkipped === opp) {
    state.phase = 'FINISHED'
    state.result = { winner: 'draw', reason: 'both_skip' }
    events.push({ type: 'draw' })
    return events
  }

  // 3. 正常跳过：记录跳过方，换边并给对手抽牌（手牌满则新牌被撕——跳过无法囤牌）
  state.lastSkipped = side
  state.turnSide = opp
  state.turnCount++
  state.phase = 'TURN_ACTION'
  events.push(...dealEvents(state, opp))
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
