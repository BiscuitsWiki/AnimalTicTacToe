/**
 * 规则引擎单元测试（vitest）。
 * 覆盖：克制表、回合发牌（数量递增/封顶/替换式/重洗）、落子与叠放、待胜阻断、平局。
 * 手动抽牌已移除：回合开始由引擎自动发牌。
 */
import { describe, expect, it } from 'vitest'
import { canCapture, effectiveness } from '../elements'
import {
  canPlace, cloneState, createMatch, dealCountFor, hasAnyLegalPlacement,
  legalCells, linesOf, place, shuffle, topSide,
} from '../engine'
import type { MatchState, Piece, Side } from '../types'

const P = (id: string, element: Piece['element']): Piece =>
  ({ id, name: id, element })

/**
 * 直接构造对局状态（精确控制双方手牌；deck 默认为空 = 不触发自动发牌干扰）。
 * 适用于落子/叠放/胜负判定类用例；发牌规则本身用 createMatch 或显式 deck 测试。
 */
function makeState(
  redEls: Piece['element'][],
  blueEls: Piece['element'][],
  deckEls: Piece['element'][] = [],
  opts: { turnSide?: Side; turnCount?: number } = {},
): MatchState {
  return {
    phase: 'TURN_ACTION',
    board: Array.from({ length: 9 }, () => ({ stack: [] })),
    hands: {
      red: redEls.map((e, i) => P(`r${i}`, e)),
      blue: blueEls.map((e, i) => P(`b${i}`, e)),
    },
    deck: deckEls.map((e, i) => P(`dk${i}`, e)),
    deckSnapshot: deckEls.map((e, i) => P(`dk${i}`, e)),
    turnCount: opts.turnCount ?? 1,
    turnSide: opts.turnSide ?? 'red',
    lastPlaced: { red: null, blue: null },
    pendingWin: null,
    result: null,
  }
}

describe('属性克制表', () => {
  it('基本克制/抵抗/免疫', () => {
    expect(effectiveness('fire', 'grass')).toBe(2)
    expect(effectiveness('water', 'fire')).toBe(2)
    expect(effectiveness('fire', 'fire')).toBe(0.5)
    expect(effectiveness('fire', 'water')).toBe(0.5)
    expect(effectiveness('normal', 'ghost')).toBe(0)
    expect(effectiveness('ground', 'flying')).toBe(0)
    expect(effectiveness('fairy', 'dragon')).toBe(2)
    expect(effectiveness('normal', 'fire')).toBe(1) // 未声明 = 1x
  })

  it('canCapture 只认 >1', () => {
    expect(canCapture('fire', 'grass')).toBe(true)
    expect(canCapture('grass', 'fire')).toBe(false)
    expect(canCapture('normal', 'ghost')).toBe(false)
    expect(canCapture('water', 'water')).toBe(false)
  })
})

describe('回合发牌', () => {
  it('发牌数：3 起步每回合 +1，第 4 回合起封顶 6', () => {
    expect(dealCountFor(1)).toBe(3)
    expect(dealCountFor(2)).toBe(4)
    expect(dealCountFor(3)).toBe(5)
    expect(dealCountFor(4)).toBe(6)
    expect(dealCountFor(9)).toBe(6)
  })

  it('开局：红方第 1 回合自动发 3 张，直接可落子', () => {
    const deck = Array.from({ length: 10 }, (_, i) => P(`dk${i}`, 'normal'))
    const s = createMatch({ deck })
    expect(s.phase).toBe('TURN_ACTION')
    expect(s.turnSide).toBe('red')
    expect(s.turnCount).toBe(1)
    expect(s.hands.red).toHaveLength(3)
    expect(s.hands.blue).toHaveLength(0)
    expect(s.deck).toHaveLength(7)
    expect(s.board).toHaveLength(9)
  })

  it('换边自动发牌：对手旧手牌作废，按回合数重发并产生 dealt 事件', () => {
    const s = makeState(['fire'], ['water'], ['normal', 'normal', 'normal', 'normal'])
    const ev = place(s, 'red', 0, 0)
    expect(s.turnSide).toBe('blue')
    expect(s.turnCount).toBe(2)
    expect(s.hands.blue).toHaveLength(4)   // 原 1 张作废，第 2 回合重发 4 张
    const dealt = ev.find(e => e.type === 'dealt')
    expect(dealt).toBeDefined()
    if (dealt?.type === 'dealt') {
      expect(dealt.side).toBe('blue')
      expect(dealt.pieces).toHaveLength(4)
      expect(dealt.discarded).toBe(1)
      expect(dealt.reshuffled).toBe(false)
    }
  })

  it('落子后剩余手牌保留：供玩家复盘，不立即作废', () => {
    const s = makeState(
      ['fire', 'fire', 'fire'],
      ['water'],
      ['normal', 'normal', 'normal', 'normal'],
    )
    place(s, 'red', 0, 0)   // red 用 1 张，剩 2 张保留且为原牌
    expect(s.hands.red).toHaveLength(2)
    expect(s.hands.red.every(p => p.id.startsWith('r'))).toBe(true)
  })

  it('lastPlaced 记录双方最近落子格', () => {
    const s = makeState(['fire', 'fire'], ['water'])
    place(s, 'red', 0, 4)
    expect(s.lastPlaced.red).toBe(4)
    expect(s.lastPlaced.blue).toBeNull()
    place(s, 'blue', 0, 2)
    expect(s.lastPlaced.blue).toBe(2)
    place(s, 'red', 0, 0)   // 只保留最近一手
    expect(s.lastPlaced.red).toBe(0)
  })

  it('清牌时机在下个行动回合开始：囤 5 张未用，再行动时作废并重发 4 张', () => {
    const s = makeState(
      ['fire', 'fire', 'fire', 'fire', 'fire'],
      ['water'],
      ['normal', 'normal', 'normal', 'normal'],
      { turnSide: 'blue' },
    )
    place(s, 'blue', 0, 3)   // blue 走完 → red 第 2 回合开始：旧 5 张作废，重发 4 张
    expect(s.hands.red).toHaveLength(4)
    expect(s.hands.red.every(p => p.id.startsWith('dk'))).toBe(true)   // 全为新牌
  })

  it('牌堆耗尽自动按快照重洗补足', () => {
    const s = makeState(['fire'], ['water'], ['normal', 'fire'])
    const ev = place(s, 'red', 0, 0)   // blue 发 4 张：牌堆仅 2 张 → 重洗快照补足
    const dealt = ev.find(e => e.type === 'dealt')
    expect(dealt).toBeDefined()
    expect(dealt && dealt.type === 'dealt' ? dealt.reshuffled : false).toBe(true)
    expect(dealt && dealt.type === 'dealt' ? dealt.pieces.length : 0).toBe(4)
    expect(s.deckSnapshot).toHaveLength(2)   // 快照不变
  })

  it('空牌堆且空快照（退化配置）：跳过发牌，手牌保持原样', () => {
    const s = makeState(['fire'], ['water'], [])
    const ev = place(s, 'red', 0, 0)
    expect(s.hands.blue).toHaveLength(1)   // 不清理不补发
    expect(ev.some(e => e.type === 'dealt')).toBe(false)
  })
})

describe('落子与叠放占领', () => {
  it('空格落子', () => {
    const s = makeState(['fire'], ['water'])
    const ev = place(s, 'red', 0, 4)
    expect(ev[0].type).toBe('placed')
    expect(ev[0].stacked).toBe(false)
    expect(topSide(s.board[4])).toBe('red')
    expect(s.hands.red).toHaveLength(0)
  })

  it('克制可叠放占领，归属随最上层翻转', () => {
    const s = makeState(['grass'], ['fire'])
    place(s, 'red', 0, 0)
    const ev = place(s, 'blue', 0, 0)   // blue 用 fire 叠放 red 的 grass
    expect(ev[0].stacked).toBe(true)
    expect(s.board[0].stack).toHaveLength(2)
    expect(topSide(s.board[0])).toBe('blue')
    expect(s.board[0].stack[0].piece.element).toBe('grass') // 底层保留
  })

  it('同属性抵抗不可叠放', () => {
    const s = makeState(['fire'], ['fire'])
    place(s, 'red', 0, 0)
    expect(canPlace(s, 'blue', 0, 0)).toBe(false)
    expect(() => place(s, 'blue', 0, 0)).toThrow(/NOT_EFFECTIVE|CELL_OWNED/)
  })

  it('免疫与抵抗均不可叠放', () => {
    const s = makeState(['ghost'], ['normal'])
    place(s, 'red', 0, 0)
    expect(canPlace(s, 'blue', 0, 0)).toBe(false) // normal 打 ghost = 0
    const s2 = makeState(['grass'], ['water'])
    place(s2, 'red', 0, 0)
    expect(canPlace(s2, 'blue', 0, 0)).toBe(false) // water 打 grass = 0.5
  })

  it('己方格不可叠放', () => {
    const s = makeState(['fire', 'fire'], ['water'])
    place(s, 'red', 0, 4)
    place(s, 'blue', 0, 3)              // blue 走完，轮回 red
    expect(() => place(s, 'red', 0, 4)).toThrow(/CELL_OWNED/)
  })

  it('单格叠放上限 3 层', () => {
    // (0,0): red grass → blue fire(克制) → red water(克制fire) → 满 3 层
    const s = makeState(['grass', 'water'], ['fire', 'ground'], [])
    place(s, 'red', 0, 0)          // red grass
    place(s, 'blue', 0, 0)         // blue fire 叠放
    place(s, 'red', 0, 0)          // red water 叠放 → 3 层
    expect(s.board[0].stack).toHaveLength(3)
    expect(canPlace(s, 'blue', 0, 0)).toBe(false) // 已达上限
    expect(() => place(s, 'blue', 0, 0)).toThrow(/STACK_FULL/)
  })

  it('非本回合不可落子', () => {
    const s = makeState(['fire'], ['water'])
    expect(() => place(s, 'blue', 0, 4)).toThrow(/NOT_YOUR_TURN/)
  })

  it('legalCells 与 canPlace 一致', () => {
    const s = makeState(['grass'], ['fire', 'fire'])
    place(s, 'red', 0, 0)
    const cells = legalCells(s, 'blue', s.hands.blue[0])
    expect(cells).toContain(0)   // 可叠放 red 的 grass
    cells.forEach(c => expect(canPlace(s, 'blue', 0, c)).toBe(true))
  })
})

describe('待胜阻断', () => {
  /** 红蓝交替各落 3 子，red 在 0,1,2 成三连（fire），blue 在 3,4 落 water */
  function makePendingWin(): MatchState {
    const s = makeState(
      ['fire', 'fire', 'fire'], ['water', 'water', 'water'], [],
    )
    place(s, 'red', 0, 0)
    place(s, 'blue', 0, 3)
    place(s, 'red', 0, 1)
    place(s, 'blue', 0, 4)
    place(s, 'red', 0, 2)   // red 三连 0-1-2
    return s
  }

  it('三连不立即获胜，进入待胜缓冲', () => {
    const s = makePendingWin()
    expect(s.pendingWin?.winnerSide).toBe('red')
    expect(s.pendingWin?.line).toEqual([0, 1, 2])
    expect(s.result).toBeNull()
    expect(s.turnSide).toBe('blue')      // 轮到 blue 阻断
  })

  it('对手成功阻断 → 游戏继续', () => {
    const s = makeState(
      ['fire', 'fire', 'fire', 'fire'],
      ['water', 'water', 'water', 'water'], [],
    )
    place(s, 'red', 0, 0)
    place(s, 'blue', 0, 3)
    place(s, 'red', 0, 1)
    place(s, 'blue', 0, 4)
    place(s, 'red', 0, 2)   // red 三连
    const ev = place(s, 'blue', 0, 1)    // water 克制 fire，叠放打断
    expect(ev.some(e => e.type === 'blocked')).toBe(true)
    expect(s.pendingWin).toBeNull()
    expect(s.result).toBeNull()
    expect(topSide(s.board[1])).toBe('blue')
  })

  it('对手未能阻断 → 三连方获胜', () => {
    const s = makePendingWin()
    const ev = place(s, 'blue', 0, 5)    // blue 没去阻断，落在别处
    expect(ev.some(e => e.type === 'win' && e.winner === 'red')).toBe(true)
    expect(s.result?.winner).toBe('red')
    expect(s.result?.reason).toBe('line')
  })

  it('三连链路全部格子叠满 → 无法阻断，立即判胜（跳过待胜缓冲）', () => {
    // 0/1 格 red 已 3 层，2 格 blue 2 层；red water 叠放 2 格 → 三连且 0/1/2 均 3 层
    const s = makeState(['water'], ['fire'], [])
    const red3 = { side: 'red' as const, piece: P('rx', 'water') }
    const blueFire = (id: string) => ({ side: 'blue' as const, piece: P(id, 'fire') })
    s.board[0].stack = [blueFire('b0a'), blueFire('b0b'), red3]
    s.board[1].stack = [blueFire('b1a'), blueFire('b1b'), red3]
    s.board[2].stack = [blueFire('b2a'), blueFire('b2b')]
    const ev = place(s, 'red', 0, 2)     // water 克制 fire，叠放占领 2 格
    expect(ev.some(e => e.type === 'pending_win')).toBe(false)
    expect(ev.some(e => e.type === 'win' && e.winner === 'red')).toBe(true)
    expect(s.result?.winner).toBe('red')
    expect(s.result?.reason).toBe('line')
  })

  it('棋盘下满且阻断方无合法落子 → 三连方直接获胜', () => {
    // 终局盘面：red fire 占 0,1,2(三连),3,7；blue water 占 4,5,6,8；
    // blue 手牌只剩 fire（对 red fire 不克制，blue 格又不可自叠）→ 无处可落
    const s = makeState(
      ['fire', 'fire', 'fire', 'fire', 'fire'],
      ['water', 'water', 'water', 'water', 'fire'], [],
    )
    // 落子顺序经过验证：任何中途步骤都不形成三连
    const seq: Array<[Side, number]> = [
      ['red', 0], ['blue', 4], ['red', 1], ['blue', 5],
      ['red', 3], ['blue', 6], ['red', 7], ['blue', 8],
    ]
    for (const [side, cell] of seq) {
      place(s, side, 0, cell)
      expect(s.result).toBeNull()        // 中途不应终局
    }
    const ev = place(s, 'red', 0, 2)     // 第 9 子：red 三连 + 棋盘下满
    expect(ev.some(e => e.type === 'pending_win' && e.side === 'red')).toBe(true)
    expect(ev.some(e => e.type === 'win' && e.winner === 'red')).toBe(true)
    expect(s.board.every(c => c.stack.length > 0)).toBe(true)
    expect(s.result?.winner).toBe('red')
  })
})

describe('平局判定', () => {
  it('棋盘下满且无三连 → 平局', () => {
    // 无三连的填满布局（normal 互不克制无法叠放，全部落在空格）：
    // 终盘 R:{0,2,4,5,7}  B:{1,3,6,8} —— 8 条线均无同色三连
    const s = makeState(
      ['normal', 'normal', 'normal', 'normal', 'normal'],
      ['normal', 'normal', 'normal', 'normal'], [],
    )
    const seq: Array<[Side, number]> = [
      ['red', 0], ['blue', 1], ['red', 2], ['blue', 3],
      ['red', 4], ['blue', 6], ['red', 5], ['blue', 8],
    ]
    for (const [side, cell] of seq) {
      place(s, side, 0, cell)
      expect(s.result).toBeNull()        // 中途不应终局
    }
    const ev = place(s, 'red', 0, 7)     // 第 9 子填满棋盘
    expect(ev.some(e => e.type === 'draw')).toBe(true)
    expect(s.result).toEqual({ winner: 'draw', reason: 'board_full' })
    expect(linesOf(s.board, 'red')).toHaveLength(0)
    expect(linesOf(s.board, 'blue')).toHaveLength(0)
  })
})

describe('工具函数', () => {
  it('cloneState 深拷贝（修改克隆不影响原状态）', () => {
    const s = makeState(['fire'], ['water'])
    const c = cloneState(s)
    c.board[0].stack.push({ side: 'red', piece: P('x', 'fire') })
    expect(s.board[0].stack).toHaveLength(0)
  })

  it('shuffle 保持元素不变', () => {
    const arr = [1, 2, 3, 4, 5, 6, 7, 8, 9, 10]
    const out = shuffle([...arr])
    expect([...out].sort((a, b) => a - b)).toEqual(arr)
  })

  it('hasAnyLegalPlacement：空格恒可落', () => {
    const s = makeState(['fire'], [])
    expect(hasAnyLegalPlacement(s, 'red')).toBe(true)
  })
})
