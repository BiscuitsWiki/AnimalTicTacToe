/**
 * 规则引擎单元测试（vitest）。
 * 覆盖：克制/抵抗表（双属性择优与连乘）、回合抽牌（起始 3 张 + 每回合 1 张、不重洗）、
 * 落子与叠放（上限 8 层）、待胜阻断、跳过（换边抽牌 / 连续跳过平局 / 待胜期跳过判负）、
 * 平局（board_full 叠满 / both_skip 连续跳过）、认输。
 */
import { describe, expect, it } from 'vitest'
import { canCapture, captureMultiplier, effectiveness, ELEMENTS } from '../elements'
import { PRESET_DECK } from '../pieces'
import {
  canPlace, cloneState, createMatch, dealCountFor, hasAnyLegalPlacement,
  legalCells, linesOf, place, resign, shuffle, skip, topSide,
} from '../engine'
import type { MatchState, Piece, Side } from '../types'

const P = (id: string, element: Piece['element'], element2?: Piece['element']): Piece =>
  ({ id, name: id, element, ...(element2 && element2 !== element ? { element2 } : {}) })

/**
 * 直接构造对局状态（精确控制双方手牌；deck 默认为空 = 不触发自动抽牌干扰）。
 * 适用于落子/叠放/胜负判定类用例；抽牌规则本身用 createMatch 或显式 deck 测试。
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
    turnCount: opts.turnCount ?? 1,
    turnSide: opts.turnSide ?? 'red',
    lastPlaced: { red: null, blue: null },
    lastSkipped: null,
    pendingWin: null,
    result: null,
  }
}

describe('属性克制表（洛克王国 18 属性）', () => {
  it('基本克制关系', () => {
    expect(effectiveness('fire', 'grass')).toBe(2)
    expect(effectiveness('water', 'fire')).toBe(2)
    expect(effectiveness('grass', 'water')).toBe(2)
    expect(effectiveness('light', 'ghost')).toBe(2)      // 光克幽
    expect(effectiveness('illusion', 'poison')).toBe(2)  // 幻克毒
    expect(effectiveness('cute', 'dragon')).toBe(2)      // 萌克龙
    expect(effectiveness('martial', 'normal')).toBe(2)   // 武克普通
    expect(effectiveness('machine', 'earth')).toBe(2)    // 机械克地
    expect(effectiveness('normal', 'fire')).toBe(1)      // 普通不克任何属性
    expect(effectiveness('fire', 'fire')).toBe(1)        // 同属性不克制
  })

  it('抵抗（受击减半）：被克一方反击为 0.5', () => {
    expect(effectiveness('water', 'grass')).toBe(0.5)    // 草克水 → 水攻草被抵抗
    expect(effectiveness('fire', 'water')).toBe(0.5)     // 水克火 → 火攻水被抵抗
    expect(effectiveness('grass', 'fire')).toBe(0.5)     // 火克草 → 草攻火被抵抗
    expect(effectiveness('normal', 'martial')).toBe(0.5) // 武克普通 → 普通攻武被抵抗
    expect(effectiveness('normal', 'fire')).toBe(1)      // 无克制关系 → 中性 1x
  })

  it('互克对双向均为 2（克制优先于抵抗）', () => {
    expect(effectiveness('ice', 'earth')).toBe(2)
    expect(effectiveness('earth', 'ice')).toBe(2)
    expect(effectiveness('light', 'ghost')).toBe(2)
    expect(effectiveness('ghost', 'light')).toBe(2)
    expect(effectiveness('dark', 'cute')).toBe(2)
    expect(effectiveness('cute', 'dark')).toBe(2)
    expect(effectiveness('dragon', 'dragon')).toBe(2)    // 龙克龙（自身）
    expect(effectiveness('ghost', 'ghost')).toBe(2)      // 幽克幽（自身）
  })

  it('canCapture 只认 >1（单属性 = 克制且未被抵抗）', () => {
    expect(canCapture(P('a', 'fire'), P('b', 'grass'))).toBe(true)
    expect(canCapture(P('a', 'grass'), P('b', 'fire'))).toBe(false)   // 草攻火被抵抗 0.5
    expect(canCapture(P('a', 'normal'), P('b', 'ghost'))).toBe(false)
    expect(canCapture(P('a', 'water'), P('b', 'water'))).toBe(false)
    expect(canCapture(P('a', 'earth'), P('b', 'electric'))).toBe(true)   // 地克电
    expect(canCapture(P('a', 'electric'), P('b', 'earth'))).toBe(false)
  })

  it('克制表健全性：除普通外每属性至少克一种；互克仅限自身与光幽/冰地/恶萌', () => {
    for (const el of ELEMENTS) {
      const beats = ELEMENTS.filter(d => canCapture({ element: el }, { element: d }))
      if (el === 'normal') {
        expect(beats).toHaveLength(0)   // 普通不克任何属性
      } else {
        expect(beats.length).toBeGreaterThanOrEqual(1)
      }
    }
    // 洛克王国的互克关系：龙克龙、幽克幽（自身），以及 光↔幽、冰↔地、恶↔萌 三组双向克制
    const mutual: string[] = []
    for (const a of ELEMENTS) {
      for (const b of ELEMENTS) {
        if (a !== b && canCapture({ element: a }, { element: b }) && canCapture({ element: b }, { element: a })) {
          mutual.push(`${a}|${b}`)
        }
      }
    }
    expect(mutual.sort()).toEqual([
      'cute|dark', 'dark|cute', 'earth|ice', 'ghost|light', 'ice|earth', 'light|ghost',
    ])
  })

  it('预设牌：36 单属性（18 属性 × 各 2 张）+ 15 双属性（《洛克王国：世界》现役精灵），全部合法', () => {
    expect(PRESET_DECK).toHaveLength(51)
    expect(new Set(PRESET_DECK.map(p => p.id)).size).toBe(51)    // id 唯一
    expect(new Set(PRESET_DECK.map(p => p.name)).size).toBe(51)  // 名字唯一
    const singles = PRESET_DECK.filter(p => !p.element2)
    const duals = PRESET_DECK.filter(p => p.element2)
    expect(singles).toHaveLength(36)
    expect(duals).toHaveLength(15)
    const count = new Map<string, number>()
    for (const p of singles) {
      expect(ELEMENTS).toContain(p.element)
      count.set(p.element, (count.get(p.element) ?? 0) + 1)
    }
    expect(count.size).toBe(18)
    for (const el of ELEMENTS) {
      expect(count.get(el)).toBe(2)
    }
    for (const p of duals) {
      expect(ELEMENTS).toContain(p.element)
      expect(ELEMENTS).toContain(p.element2!)
      expect(p.element2).not.toBe(p.element)
    }
    // 双属性预设棋子参与克制判定（抽样：熔岩布丁 水+火 vs 炎尾狐 火）
    const pudding = PRESET_DECK.find(p => p.name === '熔岩布丁')
    const fox = PRESET_DECK.find(p => p.name === '炎尾狐')
    expect(pudding && fox).toBeTruthy()
    if (pudding && fox) {
      expect(canCapture(pudding, fox)).toBe(true)    // 水+火 攻 火：择水 2x
      expect(canCapture(fox, pudding)).toBe(false)   // 火 攻 水+火：0.5×1 被抵抗
    }
  })
})

describe('双属性判定（进攻择优 × 防守连乘）', () => {
  it('用户示例：翼+水 攻 火+草 → 择翼（1×2=2 > 水 2×0.5=1）', () => {
    const atk = P('atk', 'wing', 'water')
    const def = P('def', 'fire', 'grass')
    expect(captureMultiplier(atk, def)).toBe(2)
    expect(canCapture(atk, def)).toBe(true)
  })

  it('单属性水 攻 火+草 → 2×0.5=1，抵抗抵消不算克制', () => {
    const def = P('def', 'fire', 'grass')
    expect(captureMultiplier(P('a', 'water'), def)).toBe(1)
    expect(canCapture(P('a', 'water'), def)).toBe(false)
    expect(captureMultiplier(P('a', 'wing'), def)).toBe(2)   // 翼单属性仍克草
  })

  it('防守方双弱点连乘：火 攻 草+虫 → 2×2=4', () => {
    expect(captureMultiplier(P('a', 'fire'), P('d', 'grass', 'bug'))).toBe(4)
  })

  it('进攻方双属性择优：水+翼 攻 火 → max(2,1)=2', () => {
    expect(captureMultiplier(P('a', 'water', 'wing'), P('d', 'fire'))).toBe(2)
  })

  it('副属性补克：水 攻 龙 1x，水+龙 攻 龙 → 龙克龙 2x', () => {
    expect(captureMultiplier(P('a', 'water'), P('d', 'dragon'))).toBe(1)
    expect(captureMultiplier(P('a', 'water', 'dragon'), P('d', 'dragon'))).toBe(2)
  })

  it('防守方副属性补抵抗：火 攻 冰+水 → 2×0.5=1 不算克制', () => {
    expect(captureMultiplier(P('a', 'fire'), P('d', 'ice', 'water'))).toBe(1)
    expect(canCapture(P('a', 'fire'), P('d', 'ice', 'water'))).toBe(false)
  })

  it('主副属性相同按单属性处理（直测 element2 === element 去重分支）', () => {
    // 注意：P 助手会丢弃与主属性相同的 element2，这里用原生对象才能命中 elementsOf 的去重路径
    expect(captureMultiplier({ element: 'fire', element2: 'fire' }, { element: 'water' })).toBe(0.5)  // 火攻水被抵抗
    expect(captureMultiplier({ element: 'water', element2: 'water' }, { element: 'fire' })).toBe(2)
    expect(captureMultiplier({ element: 'fire', element2: 'fire' }, { element: 'water' }))
      .toBe(captureMultiplier({ element: 'fire' }, { element: 'water' }))   // 与真单属性完全一致
  })

  it('普通属性双属性仍不克制任何目标', () => {
    expect(canCapture({ element: 'normal', element2: 'normal' }, P('d', 'ghost'))).toBe(false)
    // 普通+任意副属性：能否克制只取决于副属性
    expect(canCapture(P('a', 'normal', 'light'), P('d', 'ghost'))).toBe(true)    // 光克幽
    expect(canCapture(P('a', 'normal', 'water'), P('d', 'grass'))).toBe(false)   // 水攻草被抵抗
  })

  it('双向抵抗：火 攻 水+地 → 0.5×0.5=0.25（防守方双属性均抵抗进攻方）', () => {
    expect(captureMultiplier(P('a', 'fire'), P('d', 'water', 'earth'))).toBe(0.25)
    expect(canCapture(P('a', 'fire'), P('d', 'water', 'earth'))).toBe(false)
  })

  it('择优后仍不克制：火+电 攻 水+地 → max(0.25, 2×0.5)=1，不可占领', () => {
    const def = P('d', 'water', 'earth')
    expect(captureMultiplier(P('a', 'electric'), def)).toBe(1)          // 电克水被地抵抗抵消
    expect(captureMultiplier(P('a', 'fire', 'electric'), def)).toBe(1)  // 双属性择优也只到 1
    expect(canCapture(P('a', 'fire', 'electric'), def)).toBe(false)
  })

  it('防守方双弱点连乘 4x：萌 攻 龙+武 → 2×2=4', () => {
    expect(captureMultiplier(P('a', 'cute'), P('d', 'dragon', 'martial'))).toBe(4)
    expect(canCapture(P('a', 'cute'), P('d', 'dragon', 'martial'))).toBe(true)
  })

  it('普通作为防守属性完全中性：不稀释克制、不提供抵抗', () => {
    expect(captureMultiplier(P('a', 'fire'), P('d', 'grass', 'normal'))).toBe(2)   // 2×1
    expect(captureMultiplier(P('a', 'water'), P('d', 'normal', 'fire'))).toBe(2)  // 1×2
    expect(canCapture(P('a', 'fire'), P('d', 'water', 'normal'))).toBe(false)     // 0.5×1 仍被抵抗
  })

  it('互克对作为防守组合（冰+地）：火被地抵抗抵消为 1，水克地仍为 2', () => {
    const def = P('d', 'ice', 'earth')
    expect(captureMultiplier(P('a', 'fire'), def)).toBe(1)       // 2×0.5
    expect(captureMultiplier(P('a', 'water'), def)).toBe(2)      // 1×2
    expect(captureMultiplier(P('a', 'electric'), def)).toBe(0.5) // 1×0.5（地克电）
    expect(canCapture(P('a', 'fire'), def)).toBe(false)
    expect(canCapture(P('a', 'water'), def)).toBe(true)
  })

  it('互克对镜像对轰：光+幽 攻 光+幽 → 幽线 2×2=4，双向均可占领', () => {
    const a = P('a', 'light', 'ghost')
    const d = P('d', 'light', 'ghost')
    expect(captureMultiplier(a, d)).toBe(4)
    expect(canCapture(a, d)).toBe(true)
    expect(canCapture(d, a)).toBe(true)
  })

  it('全表不变量：倍率值域 {0.25,0.5,1,2,4}；主副去重/交换等价；进攻加副属性永不更差', () => {
    type Profile = { element: Piece['element']; element2?: Piece['element'] }
    const singles: Profile[] = ELEMENTS.map(x => ({ element: x }))
    const duals: Profile[] = []
    for (const x of ELEMENTS) {
      for (const y of ELEMENTS) {
        if (x !== y) duals.push({ element: x, element2: y })
      }
    }
    const all = [...singles, ...duals]   // 18 单属性 + 306 双属性组合
    const key = (p: Profile) => `${p.element}+${p.element2 ?? '-'}`
    const ALLOWED = new Set([0.25, 0.5, 1, 2, 4])
    const badDomain: string[] = []
    const badSwap: string[] = []
    const badMono: string[] = []
    const badDedup: string[] = []
    for (const atk of all) {
      for (const def of all) {
        const m = captureMultiplier(atk, def)
        if (!ALLOWED.has(m)) badDomain.push(`${key(atk)} 攻 ${key(def)} = ${m}`)
        if (atk.element2 && atk.element2 !== atk.element) {
          const swapped: Profile = { element: atk.element2, element2: atk.element }
          if (captureMultiplier(swapped, def) !== m) badSwap.push(`${key(atk)} 攻 ${key(def)}`)
          if (m < captureMultiplier({ element: atk.element }, def)
            || m < captureMultiplier({ element: atk.element2 }, def)) {
            badMono.push(`${key(atk)} 攻 ${key(def)}`)
          }
        }
      }
    }
    for (const x of ELEMENTS) {
      for (const def of all) {
        if (captureMultiplier({ element: x, element2: x }, def) !== captureMultiplier({ element: x }, def)) {
          badDedup.push(`${x}+${x} 攻 ${key(def)}`)
        }
      }
    }
    expect(badDomain).toEqual([])
    expect(badSwap).toEqual([])
    expect(badMono).toEqual([])
    expect(badDedup).toEqual([])
  })

  it('双属性不可叠放（引擎 place 集成）：火+草 攻 翼+水 与 单水 攻 火+草 均被抵抗/抵消', () => {
    const s = makeState([], [])
    s.hands.red = [P('rw', 'wing', 'water'), P('rw2', 'water')]
    s.hands.blue = [P('bf', 'fire', 'grass'), P('bf2', 'fire', 'grass')]
    place(s, 'red', 0, 4)                     // red 翼+水 落空格 4
    expect(topSide(s.board[4])).toBe('red')
    // blue 火+草 攻 翼+水：火 1×0.5=0.5，草 0.5×2=1 → 择草 1 ≤ 1 不可叠
    expect(canPlace(s, 'blue', 0, 4)).toBe(false)
    expect(() => place(s, 'blue', 0, 4)).toThrow(/NOT_EFFECTIVE/)
    place(s, 'blue', 0, 3)                    // blue 火+草 落空格 3
    // red 单水 攻 火+草：2×0.5=1 抵抗抵消 → 不可叠
    expect(canPlace(s, 'red', 0, 3)).toBe(false)
  })

  it('双属性叠放占领：翼+水 叠放 火+草 成功翻转归属（择翼 1×2=2）', () => {
    const s = makeState([], [], [], { turnSide: 'blue' })
    s.hands.red = [P('rw', 'wing', 'water')]
    s.hands.blue = [P('bf', 'fire', 'grass')]
    place(s, 'blue', 0, 4)                    // blue 火+草 落空格 4
    const ev = place(s, 'red', 0, 4)          // red 翼+水 叠放占领
    expect(ev[0].type).toBe('placed')
    expect(ev[0].stacked).toBe(true)
    expect(topSide(s.board[4])).toBe('red')
    expect(s.board[4].stack).toHaveLength(2)
    expect(s.board[4].stack[0].piece.element).toBe('fire')   // 底层保留
  })

  it('legalCells 区分双属性手牌：翼+水 视 火+草 格为可叠，单水只认空格', () => {
    const s = makeState([], [], [], { turnSide: 'blue' })
    s.hands.red = [P('rw', 'wing', 'water'), P('rw2', 'water')]
    s.hands.blue = [P('bf', 'fire', 'grass')]
    place(s, 'blue', 0, 4)                      // blue 火+草 落空格 4
    const dualCells = legalCells(s, 'red', s.hands.red[0])
    const singleCells = legalCells(s, 'red', s.hands.red[1])
    expect(dualCells).toContain(4)              // 翼+水 克制 火+草 → 可叠
    expect(dualCells).toHaveLength(9)           // 8 空格 + 1 可叠格
    expect(singleCells).not.toContain(4)        // 单水 2×0.5=1 → 只能落空格
    expect(singleCells).toHaveLength(8)
  })

  it('叠放事件与棋盘层均保留 element2', () => {
    const s = makeState([], [], [], { turnSide: 'blue' })
    s.hands.red = [P('rw', 'wing', 'water')]
    s.hands.blue = [P('bf', 'fire', 'grass')]
    place(s, 'blue', 0, 4)
    const ev = place(s, 'red', 0, 4)
    expect(ev.some(e => e.type === 'placed' && e.piece.element2 === 'water')).toBe(true)
    expect(s.board[4].stack[0].piece.element2).toBe('grass')   // 底层保留副属性
    expect(s.board[4].stack[1].piece.element2).toBe('water')   // 顶层
  })

  it('cloneState 深拷贝保留 element2', () => {
    const s = makeState([], [], [], { turnSide: 'blue' })
    s.hands.red = [P('rw', 'wing', 'water')]
    s.hands.blue = [P('bf', 'fire', 'grass')]
    place(s, 'blue', 0, 4)
    place(s, 'red', 0, 4)
    const c = cloneState(s)
    expect(c.board[4].stack[0].piece.element2).toBe('grass')
    expect(c.board[4].stack[1].piece.element2).toBe('water')
  })

  it('双属性参与待胜阻断：翼+水 叠上 火+草 三连格完成阻断', () => {
    const s = makeState([], [])
    s.hands.red = [P('r1', 'fire', 'grass'), P('r2', 'fire', 'grass'), P('r3', 'fire', 'grass')]
    s.hands.blue = [P('b1', 'normal'), P('b2', 'normal'), P('b3', 'wing', 'water')]
    place(s, 'red', 0, 0)
    place(s, 'blue', 0, 3)
    place(s, 'red', 0, 1)
    place(s, 'blue', 0, 4)
    place(s, 'red', 0, 2)                       // red 火+草 三连 0-1-2
    expect(s.pendingWin?.winnerSide).toBe('red')
    const ev = place(s, 'blue', 0, 1)           // 翼+水 克制 火+草 → 叠放阻断
    expect(ev.some(e => e.type === 'blocked')).toBe(true)
    expect(s.pendingWin).toBeNull()
    expect(topSide(s.board[1])).toBe('blue')
    expect(s.board[1].stack[0].piece.element2).toBe('grass')
  })

  it('单水无法阻断 火+草 三连（2×0.5=1）：三连格均不可叠 → 未阻断判负', () => {
    const s = makeState([], [])
    s.hands.red = [P('r1', 'fire', 'grass'), P('r2', 'fire', 'grass'), P('r3', 'fire', 'grass')]
    s.hands.blue = [P('b1', 'normal'), P('b2', 'normal'), P('b3', 'water')]
    place(s, 'red', 0, 0)
    place(s, 'blue', 0, 3)
    place(s, 'red', 0, 1)
    place(s, 'blue', 0, 4)
    place(s, 'red', 0, 2)                       // red 三连，轮 blue 阻断
    expect(canPlace(s, 'blue', 0, 0)).toBe(false)   // 三连格顶层均为 火+草
    expect(canPlace(s, 'blue', 0, 1)).toBe(false)
    expect(canPlace(s, 'blue', 0, 2)).toBe(false)
    const ev = place(s, 'blue', 0, 5)           // 只能落空格 = 放弃阻断
    expect(ev.some(e => e.type === 'win' && e.winner === 'red')).toBe(true)
    expect(s.result?.reason).toBe('line')
  })
})

describe('回合抽牌', () => {
  it('抽牌数：双方首个行动回合各 3 张，此后每回合 1 张', () => {
    expect(dealCountFor(1)).toBe(3)
    expect(dealCountFor(2)).toBe(3)
    expect(dealCountFor(3)).toBe(1)
    expect(dealCountFor(4)).toBe(1)
    expect(dealCountFor(9)).toBe(1)
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

  it('换边自动抽牌：对手首个行动回合发起始 3 张并产生 dealt 事件', () => {
    const s = makeState(['fire'], ['water'], ['normal', 'normal', 'normal', 'normal'])
    const ev = place(s, 'red', 0, 0)
    expect(s.turnSide).toBe('blue')
    expect(s.turnCount).toBe(2)
    expect(s.hands.blue).toHaveLength(4)   // 原 1 张 + 首回合抽 3 张（累加）
    const dealt = ev.find(e => e.type === 'dealt')
    expect(dealt).toBeDefined()
    if (dealt?.type === 'dealt') {
      expect(dealt.side).toBe('blue')
      expect(dealt.pieces).toHaveLength(3)
    }
  })

  it('落子后剩余手牌保留：落 1 抽 1，不作废不重发', () => {
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

  it('手牌跨回合累加：非首个行动回合每次只抽 1 张', () => {
    const s = makeState(
      ['fire', 'fire', 'fire'],
      ['water'],
      ['normal', 'normal', 'normal', 'normal'],
      { turnSide: 'blue', turnCount: 3 },
    )
    place(s, 'blue', 0, 3)   // blue 走完 → red 第 4 回合开始：仅抽 1 张
    expect(s.hands.red).toHaveLength(4)                        // 3 原有 + 1 新抽
    expect(s.hands.red.filter(p => p.id.startsWith('r'))).toHaveLength(3)   // 原牌保留
  })

  it('牌堆耗尽不重洗：剩余不足抽多少算多少，为空则不再抽', () => {
    const s = makeState(['fire'], ['water'], ['normal'], { turnCount: 3 })
    const ev1 = place(s, 'red', 0, 0)
    expect(s.hands.blue).toHaveLength(2)   // 1 原有 + 抽走牌堆仅剩的 1 张
    expect(s.deck).toHaveLength(0)
    const dealt1 = ev1.find(e => e.type === 'dealt')
    expect(dealt1 && dealt1.type === 'dealt' ? dealt1.pieces.length : 0).toBe(1)
    const ev2 = place(s, 'blue', 0, 3)
    expect(s.hands.red).toHaveLength(0)    // 牌堆已空：不再抽
    expect(ev2.some(e => e.type === 'dealt')).toBe(false)
  })

  it('空牌堆：跳过抽牌，手牌保持原样', () => {
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

  it('同属性不可叠放', () => {
    const s = makeState(['fire'], ['fire'])
    place(s, 'red', 0, 0)
    expect(canPlace(s, 'blue', 0, 0)).toBe(false)
    expect(() => place(s, 'blue', 0, 0)).toThrow(/NOT_EFFECTIVE|CELL_OWNED/)
  })

  it('非克制关系均不可叠放（1x）', () => {
    const s = makeState(['ghost'], ['normal'])
    place(s, 'red', 0, 0)
    expect(canPlace(s, 'blue', 0, 0)).toBe(false) // 普通不克任何属性
    const s2 = makeState(['grass'], ['water'])
    place(s2, 'red', 0, 0)
    expect(canPlace(s2, 'blue', 0, 0)).toBe(false) // 草克水，但反向水不克草
  })

  it('己方格不可叠放', () => {
    const s = makeState(['fire', 'fire'], ['water'])
    place(s, 'red', 0, 4)
    place(s, 'blue', 0, 3)              // blue 走完，轮回 red
    expect(() => place(s, 'red', 0, 4)).toThrow(/CELL_OWNED/)
  })

  it('单格叠放上限 8 层', () => {
    // (0,0) 交替克制链叠满 8 层：grass→fire→water→grass→fire→water→grass→fire
    const s = makeState(
      ['grass', 'water', 'fire', 'grass', 'water'],
      ['fire', 'grass', 'water', 'fire', 'water'],
      [],
    )
    place(s, 'red', 0, 0)    // 1: red grass
    place(s, 'blue', 0, 0)   // 2: blue fire 克制 grass
    place(s, 'red', 0, 0)    // 3: red water 克制 fire
    place(s, 'blue', 0, 0)   // 4: blue grass 克制 water
    place(s, 'red', 0, 0)    // 5: red fire 克制 grass
    place(s, 'blue', 0, 0)   // 6: blue water 克制 fire
    place(s, 'red', 0, 0)    // 7: red grass 克制 water
    place(s, 'blue', 0, 0)   // 8: blue fire 克制 grass → 满 8 层
    expect(s.board[0].stack).toHaveLength(8)
    expect(canPlace(s, 'red', 0, 0)).toBe(false) // 已达上限（red 剩 water 克制顶层 fire）
    expect(() => place(s, 'red', 0, 0)).toThrow(/STACK_FULL/)
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

describe('最近一手标记（盖子场景）', () => {
  it('盖住对方最近一手：双方 lastPlaced 同格（lastBoth 双标记渲染的状态基础）', () => {
    const s = makeState(['grass', 'fire'], ['fire'])
    place(s, 'red', 0, 4)    // red grass 落空格 4
    place(s, 'blue', 0, 4)   // blue fire 克制 grass 盖上
    expect(s.lastPlaced).toEqual({ red: 4, blue: 4 })
  })

  it('同格交锋后一方落向他处：标记分离', () => {
    const s = makeState(['grass', 'fire'], ['fire'])
    place(s, 'red', 0, 4)
    place(s, 'blue', 0, 4)
    place(s, 'red', 0, 0)    // red 用剩余 fire 落空格 0
    expect(s.lastPlaced).toEqual({ red: 0, blue: 4 })
  })

  it('跳过不移动标记', () => {
    const s = makeState(['fire'], ['water'])
    place(s, 'red', 0, 4)
    skip(s, 'blue')
    expect(s.lastPlaced).toEqual({ red: 4, blue: null })
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

  it('三连链路全部格子叠满 8 层 → 无法阻断，立即判胜（跳过待胜缓冲）', () => {
    // 0/1 格已满 8 层且顶层 red，2 格 7 层顶层 blue fire；red water 叠放 2 格第 8 层 → 三连且全链叠满
    const s = makeState(['water'], ['fire'], [])
    const blueFire = (id: string) => ({ side: 'blue' as const, piece: P(id, 'fire') })
    const redWater = (id: string) => ({ side: 'red' as const, piece: P(id, 'water') })
    const fullRedTop = (p: string) => [
      blueFire(`${p}a`), redWater(`${p}r1`), blueFire(`${p}b`), redWater(`${p}r2`),
      blueFire(`${p}c`), redWater(`${p}r3`), blueFire(`${p}d`), redWater(`${p}r4`),
    ]
    s.board[0].stack = fullRedTop('c0')
    s.board[1].stack = fullRedTop('c1')
    s.board[2].stack = [
      blueFire('c2a'), blueFire('c2b'), blueFire('c2c'), blueFire('c2d'),
      blueFire('c2e'), blueFire('c2f'), blueFire('c2g'),
    ]
    const ev = place(s, 'red', 0, 2)     // water 克制 fire，叠放占领 2 格 → 满 8 层
    expect(ev.some(e => e.type === 'pending_win')).toBe(false)
    expect(ev.some(e => e.type === 'win' && e.winner === 'red')).toBe(true)
    expect(s.result?.winner).toBe('red')
    expect(s.result?.reason).toBe('line')
  })

  it('棋盘下满且阻断方无合法落子：不自动判胜，须跳过（跳过 = 未阻断）→ 三连方获胜', () => {
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
    expect(s.result).toBeNull()          // 不再自动判终局：blue 须自行处置
    expect(hasAnyLegalPlacement(s, 'blue')).toBe(false)
    const ev2 = skip(s, 'blue')          // blue 无处可落只能跳过 = 放弃阻断
    expect(ev2.some(e => e.type === 'win' && e.winner === 'red')).toBe(true)
    expect(s.result?.winner).toBe('red')
    expect(s.result?.reason).toBe('line')
  })
})

describe('平局判定', () => {
  it('棋盘九格全部叠满 8 层且无三连 → 平局（board_full）', () => {
    const s = makeState(['fire'], ['water'], [])
    /** 构造 n 层叠放（顶层归属 top，其余层交替；棋子内容只需保证最上层可被克制） */
    const stack = (top: Side, n: number) =>
      Array.from({ length: n }, (_, i) => ({
        side: (i === n - 1 ? top : top === 'red' ? 'blue' : 'red') as Side,
        piece: P(`s_${top}_${n}_${i}`, 'normal'),
      }))
    // 8 格已叠满 8 层，顶层 R:{0,2,4,7} B:{1,3,6,8}（叠放前后均无三连）；
    // 5 格 7 层顶层 blue grass，待 red fire 叠满第 8 层
    const full: Array<[number, Side]> = [
      [0, 'red'], [1, 'blue'], [2, 'red'], [3, 'blue'],
      [4, 'red'], [6, 'blue'], [7, 'red'], [8, 'blue'],
    ]
    for (const [i, top] of full) s.board[i].stack = stack(top, 8)
    s.board[5].stack = stack('blue', 7)
    s.board[5].stack[6].piece = P('c5top', 'grass')   // 顶层 grass：fire 克制可叠
    const ev = place(s, 'red', 0, 5)     // 叠满最后一格 → 全盘 8 层
    expect(ev.some(e => e.type === 'draw')).toBe(true)
    expect(s.result).toEqual({ winner: 'draw', reason: 'board_full' })
    expect(s.board.every(c => c.stack.length >= 8)).toBe(true)
    expect(linesOf(s.board, 'red')).toHaveLength(0)
    expect(linesOf(s.board, 'blue')).toHaveLength(0)
  })

  it('棋盘下满但未叠满 → 不判平，对局继续；随后双方连续跳过 → 平局（both_skip）', () => {
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
    const ev = place(s, 'red', 0, 7)     // 第 9 子填满棋盘（每格仅 1 层）
    expect(ev.some(e => e.type === 'draw')).toBe(false)   // 未叠满：不判平
    expect(s.result).toBeNull()
    expect(s.turnSide).toBe('blue')      // 对局继续
    // 双方手牌耗尽无处可落 → 连续跳过 → both_skip 平局
    skip(s, 'blue')
    const ev2 = skip(s, 'red')
    expect(ev2.some(e => e.type === 'draw')).toBe(true)
    expect(s.result).toEqual({ winner: 'draw', reason: 'both_skip' })
  })

  it('无处可落不再自动判平：行动方须跳过，双方连续跳过才平局', () => {
    // 8 格已占（无三连），red 叠放占领 6 格后棋盘仍未满；
    // blue 手牌为空、牌堆为空 → 无处可落且无待胜
    const s = makeState(['fire'], [], [])
    const L = (side: Side, el: Piece['element'], i: number) =>
      ({ side, piece: P(`${side}${i}_${el}`, el) })
    s.board[0].stack = [L('blue', 'grass', 0)]
    s.board[1].stack = [L('red', 'fire', 1)]
    s.board[2].stack = [L('blue', 'fire', 2)]
    s.board[3].stack = [L('red', 'fire', 3)]
    s.board[4].stack = [L('blue', 'fire', 4)]
    s.board[5].stack = [L('red', 'fire', 5)]
    s.board[6].stack = [L('blue', 'grass', 6)]
    s.board[7].stack = [L('red', 'fire', 7)]
    const ev = place(s, 'red', 0, 6)     // fire 克制 grass，叠放 6 格
    expect(ev.some(e => e.type === 'draw')).toBe(false)   // 不再自动判平
    expect(s.result).toBeNull()
    expect(s.turnSide).toBe('blue')      // blue 无处可落，须自行跳过
    skip(s, 'blue')
    const ev2 = skip(s, 'red')           // red 手牌也已用尽 → 跟着跳过 → 平局
    expect(ev2.some(e => e.type === 'draw')).toBe(true)
    expect(s.result).toEqual({ winner: 'draw', reason: 'both_skip' })
  })
})

describe('跳过回合', () => {
  it('跳过不消耗手牌，正常换边并由对手抽牌', () => {
    const s = makeState(['fire'], ['water'], ['normal', 'normal', 'normal'])
    const ev = skip(s, 'red')
    expect(ev[0]).toEqual({ type: 'skipped', side: 'red' })
    expect(s.turnSide).toBe('blue')
    expect(s.turnCount).toBe(2)
    expect(s.lastSkipped).toBe('red')
    expect(s.hands.red).toHaveLength(1)          // 手牌不消耗
    expect(s.hands.blue).toHaveLength(4)         // 原 1 张 + 首回合抽 3 张
    const dealt = ev.find(e => e.type === 'dealt')
    expect(dealt && dealt.type === 'dealt' ? dealt.pieces.length : 0).toBe(3)
  })

  it('双方连续跳过 → 平局（both_skip）', () => {
    const s = makeState(['fire'], ['water'], [])
    skip(s, 'red')
    const ev = skip(s, 'blue')
    expect(ev.some(e => e.type === 'draw')).toBe(true)
    expect(s.phase).toBe('FINISHED')
    expect(s.result).toEqual({ winner: 'draw', reason: 'both_skip' })
  })

  it('落子重置连续跳过：A跳过→B落子→A跳过→B跳过 才判平', () => {
    const s = makeState(['fire', 'fire'], ['water', 'water'], [])
    skip(s, 'red')            // red 跳过
    place(s, 'blue', 0, 4)    // blue 落子 → 重置跳过计数
    expect(s.lastSkipped).toBeNull()
    expect(s.result).toBeNull()
    skip(s, 'red')            // red 再跳过
    expect(s.result).toBeNull()   // blue 未跟着跳过，游戏继续
    skip(s, 'blue')           // blue 紧跟跳过 → 平局
    expect(s.result).toEqual({ winner: 'draw', reason: 'both_skip' })
  })

  it('待胜期守方跳过 = 未阻断 → 三连方获胜', () => {
    const s = makeState(
      ['fire', 'fire', 'fire'], ['water', 'water', 'water'], [],
    )
    place(s, 'red', 0, 0)
    place(s, 'blue', 0, 3)
    place(s, 'red', 0, 1)
    place(s, 'blue', 0, 4)
    place(s, 'red', 0, 2)   // red 三连 0-1-2，轮 blue 阻断
    const ev = skip(s, 'blue')
    expect(ev.some(e => e.type === 'win' && e.winner === 'red')).toBe(true)
    expect(s.result).toEqual({ winner: 'red', reason: 'line' })
  })

  it('非本回合不可跳过', () => {
    const s = makeState(['fire'], ['water'])
    expect(() => skip(s, 'blue')).toThrow(/NOT_YOUR_TURN/)
  })

  it('对局已结束不可跳过', () => {
    const s = makeState(['fire'], ['water'])
    skip(s, 'red')
    skip(s, 'blue')          // both_skip 平局终局
    expect(() => skip(s, 'red')).toThrow(/GAME_OVER/)
  })
})

describe('认输', () => {
  it('认输直接判负，对方获胜', () => {
    const s = makeState(['fire'], ['water'])
    const ev = resign(s, 'red')
    expect(s.phase).toBe('FINISHED')
    expect(s.result).toEqual({ winner: 'blue', reason: 'resign' })
    expect(ev.some(e => e.type === 'resigned' && e.side === 'red')).toBe(true)
  })

  it('对局已结束不可认输', () => {
    const s = makeState(['fire'], ['water'])
    resign(s, 'red')
    expect(() => resign(s, 'blue')).toThrow(/GAME_OVER/)
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
