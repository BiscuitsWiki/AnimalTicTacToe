/**
 * 人机对战 AI（蓝方）。
 * 策略：模拟打分的贪心——枚举所有合法 (手牌, 格子) 组合，在克隆状态上试算 place()，
 * 按结算事件与盘面态势打分取最优。
 * 棋盘仅 9 格、手牌规模有限（回合发牌制），最坏百余次模拟，性能无压力。
 */
import {
  canPlace, cloneState, LINES, opponent, place, topSide,
} from './engine'
import { STACK_LIMIT } from './types'
import type { MatchState, PlaceEvent, Side } from './types'

const AI_SIDE: Side = 'blue'

/** 落子决策：枚举合法组合，模拟打分取最优 */
export function aiChoosePlacement(state: MatchState): { handIdx: number; cellIdx: number } {
  let best = { handIdx: -1, cellIdx: -1 }
  let bestScore = -Infinity

  for (let h = 0; h < state.hands[AI_SIDE].length; h++) {
    for (let c = 0; c < 9; c++) {
      if (!canPlace(state, AI_SIDE, h, c)) continue
      const score = scoreAction(state, h, c) + Math.random() // 微扰避免机械感
      if (score > bestScore) {
        bestScore = score
        best = { handIdx: h, cellIdx: c }
      }
    }
  }
  // 引擎保证：对局未结束时行动方必有合法落子（棋盘未满则空格可落）
  return best
}

function scoreAction(state: MatchState, handIdx: number, cellIdx: number): number {
  const sim = cloneState(state)
  let events: PlaceEvent[]
  try {
    events = place(sim, AI_SIDE, handIdx, cellIdx)
  } catch {
    return -Infinity
  }

  let score = 0
  for (const e of events) {
    switch (e.type) {
      case 'win':
        score += e.winner === AI_SIDE ? 1000 : -1000
        break
      case 'pending_win':
        score += e.side === AI_SIDE ? 120 : 0
        break
      case 'blocked':
        score += 90   // 成功阻断对方待胜
        break
      case 'draw':
        score += 10
        break
      default:
        break
    }
  }

  if (!sim.result) {
    const foe = opponent(AI_SIDE)
    // 对手下一步的即时三连威胁（我方落子后仍存在则危险）
    if (hasImmediateThreat(sim, foe)) score -= 60
    // 我方的两连（下一回合的潜在三连）
    score += countPairs(sim, AI_SIDE) * 8
    // 叠放占领的额外收益
    if (events.some(e => e.type === 'placed' && e.stacked)) score += 12
  }
  return score
}

/** side 是否存在"补一格即三连"的即时威胁（第三格可落：空格，或可被叠放的对方格） */
function hasImmediateThreat(state: MatchState, side: Side): boolean {
  for (const line of LINES) {
    const tops = line.map(i => topSide(state.board[i]))
    const mine = tops.filter(t => t === side).length
    if (mine !== 2) continue
    const target = line.find(i => topSide(state.board[i]) !== side)
    if (target === undefined) continue
    const cell = state.board[target]
    // 空格必可落；对方格只要未达叠放上限就存在被克制叠放的可能（保守估计）
    if (cell.stack.length === 0) return true
    if (cell.stack.length < STACK_LIMIT && topSide(cell) !== side) return true
  }
  return false
}

/** side 的两连数量（线上恰有 2 枚己方棋子且第三格为空） */
function countPairs(state: MatchState, side: Side): number {
  let n = 0
  for (const line of LINES) {
    const tops = line.map(i => topSide(state.board[i]))
    const mine = tops.filter(t => t === side).length
    const empty = tops.filter(t => t === null).length
    if (mine === 2 && empty === 1) n++
  }
  return n
}
