/**
 * MatchService 回合倒计时单元测试（vitest 假定时器）：
 * 超时自动跳过（事件标注 timeout + turnDeadline 下发）、行动重置计时、
 * 双方连续超时 both_skip 平局、待胜期守方超时判负、断线宽限期暂停计时 + 重连恢复。
 * TURN_TIMEOUT_MS 经 vi.hoisted 在模块加载前设为 50ms（须早于静态 import 生效）。
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

vi.hoisted(() => {
  process.env.TURN_TIMEOUT_MS = '50'
})

// eslint-disable-next-line import/first
import { MatchService } from './match.service.js'
import type { ClientView } from './match.service.js'
import { PRESET_CARDS } from './core/pieces.js'
import { DECK_SIZE } from './core/deck.js'
import type { CardWithSkins } from './core/deck.js'

/** 可记录消息的最小 socket 替身 */
class FakeSocket {
  sent: { event: string; data: unknown }[] = []
  send(data: string): void {
    this.sent.push(JSON.parse(data))
  }
  /** 最近一次某事件的 data */
  last<T = any>(event: string): T | undefined {
    for (let i = this.sent.length - 1; i >= 0; i--) {
      if (this.sent[i].event === event) return this.sent[i].data as T
    }
    return undefined
  }
  /** 所有 game:state 视角 */
  views(): ClientView[] {
    return this.sent.filter(m => m.event === 'game:state').map(m => m.data as ClientView)
  }
}

function makeService(pool: CardWithSkins[] = PRESET_CARDS) {
  const pieceService = { listPlayableCards: async () => pool }
  const prisma = {
    match: { create: async () => ({ id: 'db-match-1' }) },
    matchAction: { createMany: async () => ({ count: 0 }) },
  }
  return new MatchService(pieceService as never, prisma as never)
}

/** 开一局：红(r) vs 蓝(b)，返回双方 socket 与 service */
async function startGame() {
  const service = makeService()
  const red = new FakeSocket()
  const blue = new FakeSocket()
  await service.startDirectMatch(
    { playerId: 'r', name: '红方', socket: red },
    { playerId: 'b', name: '蓝方', socket: blue },
  )
  return { service, red, blue }
}

describe('MatchService 牌堆构建', () => {
  it('无工坊皮肤：整副预设卡池抽 60 张（开局发 6 张 → 牌堆余 54）', async () => {
    const service = makeService()
    const red = new FakeSocket()
    const blue = new FakeSocket()
    await service.startDirectMatch(
      { playerId: 'r', name: '红方', socket: red },
      { playerId: 'b', name: '蓝方', socket: blue },
    )
    const view = red.views()[0]
    expect(view.state.deck.length).toBe(DECK_SIZE - 6)
    // 本方手牌明文：全部来自预设卡内置外观（d01~d51）
    expect(view.state.hands.red.every((p: { id: string }) => /^d\d{2}$/.test(p.id))).toBe(true)
  })

  it('预设 + 工坊皮肤：牌堆精确 60 张，牌面只来自卡池（含工坊皮肤 id）', async () => {
    const pool: CardWithSkins[] = [
      ...PRESET_CARDS,
      { cardId: 'w1', name: '工坊卡', element: 'fire', skins: [{ skinId: 'w-s1', imageUrl: '/uploads/a.png' }] },
    ]
    const service = makeService(pool)
    const red = new FakeSocket()
    const blue = new FakeSocket()
    await service.startDirectMatch(
      { playerId: 'r', name: '红方', socket: red },
      { playerId: 'b', name: '蓝方', socket: blue },
    )
    const view = red.views()[0]
    const deckTotal = view.state.deck.length + view.state.hands.red.length + view.state.hands.blue.length
    expect(deckTotal).toBe(DECK_SIZE)
    const allowed = new Set<string>([
      ...PRESET_CARDS.map(c => c.skins[0].skinId),
      'w-s1',
    ])
    expect(view.state.hands.red.every((p: { id: string }) => allowed.has(p.id))).toBe(true)
  })

  it('工坊皮肤充足时：同名卡副本使用不同皮肤（阶段四）', async () => {
    // 5 张工坊卡各 3 款皮肤（火属性单属性卡：与预设 2 张火属性卡竞争阶段一名额）
    const pool: CardWithSkins[] = [
      ...PRESET_CARDS,
      ...Array.from({ length: 5 }, (_, i) => ({
        cardId: `w${i}`,
        name: `工坊卡${i}`,
        element: 'fire' as const,
        skins: [{ skinId: `w${i}-s1` }, { skinId: `w${i}-s2` }, { skinId: `w${i}-s3` }],
      })),
    ]
    const service = makeService(pool)
    const red = new FakeSocket()
    const blue = new FakeSocket()
    await service.startDirectMatch(
      { playerId: 'r', name: '红方', socket: red },
      { playerId: 'b', name: '蓝方', socket: blue },
    )
    const service2 = service as unknown as { rooms: Map<string, { state: { deck: unknown[]; hands: Record<string, { id: string; cardId?: string }[]> } }> }
    const state = [...service2.rooms.values()][0].state
    const all = [...state.deck, ...state.hands.red, ...state.hands.blue] as { id: string; cardId?: string }[]
    expect(all).toHaveLength(DECK_SIZE)
    const byCard = new Map<string, string[]>()
    for (const p of all) byCard.set(p.cardId!, [...(byCard.get(p.cardId!) ?? []), p.id])
    for (const [cardId, ids] of byCard) {
      if (ids.length > 1) expect(new Set(ids).size, `${cardId} 副本皮肤重复`).toBe(ids.length)
    }
  })
})

describe('MatchService 回合倒计时', () => {
  beforeEach(() => {
    vi.useFakeTimers()
  })

  afterEach(() => {
    vi.useRealTimers()
  })

  it('开局首帧即带倒计时：match:started 后第一条 game:state 的 turnDeadline 为数字（第一手可见倒计时）', async () => {
    const { red } = await startGame()
    const first = red.views()[0]
    expect(first).toBeTruthy()
    expect(typeof first.turnDeadline).toBe('number')
  })

  it('超时自动跳过：红方 50ms 无行动 → skipped(timeout) 广播 + 换边蓝方 + turnDeadline 下发', async () => {
    const { service, red, blue } = await startGame()
    expect(service.isPlayerInMatch('r')).toBe(true)

    vi.advanceTimersByTime(50)   // 红方回合超时

    const view = blue.last<ClientView>('game:state')!
    expect(view.state.turnSide).toBe('blue')
    expect(view.state.lastSkipped).toBe('red')
    expect(view.events[0]).toMatchObject({ type: 'skipped', side: 'red', timeout: true })
    expect(typeof view.turnDeadline).toBe('number')   // 蓝方回合计时已下发
    // 红方视角同样收到（对手手牌脱敏）
    const redView = red.last<ClientView>('game:state')!
    expect(redView.events[0]).toMatchObject({ type: 'skipped', side: 'red', timeout: true })
  })

  it('行动重置计时：红方及时落子 → 其计时器被取消，首个超时跳过的是蓝方', async () => {
    const { service, red, blue } = await startGame()
    const before = blue.last<ClientView>('game:state')!.turnDeadline!
    vi.advanceTimersByTime(20)       // 消耗部分回合时间
    service.applyPlace(red, 0, 0)   // 红方 20ms 时落子（50ms 内）
    expect(blue.last<ClientView>('game:state')!.state.turnSide).toBe('blue')

    // 换边视角携带的新截止时间应基于落子时刻重新起表（晚于旧截止）
    const after = blue.last<ClientView>('game:state')!.turnDeadline!
    expect(after).toBeGreaterThan(before)

    vi.advanceTimersByTime(50)      // 蓝方回合超时

    // 全部 skipped 事件中第一个应是 blue（red 的计时器已被其落子取消）
    const allSkipped = [...red.views(), ...blue.views()]
      .flatMap(v => v.events)
      .filter(e => e.type === 'skipped') as Array<{ side: string; timeout?: boolean }>
    expect(allSkipped.length).toBeGreaterThan(0)
    expect(allSkipped[0].side).toBe('blue')
    expect(allSkipped[0].timeout).toBe(true)
  })

  it('双方连续超时 → both_skip 平局，match:ended 下发', async () => {
    const { red } = await startGame()
    vi.advanceTimersByTime(100)   // 红(50ms)跳过 → 蓝(100ms)跳过 → 连续跳过平局

    const ended = red.last<{ result: { winner: string; reason: string } }>('match:ended')!
    expect(ended.result).toEqual({ winner: 'draw', reason: 'both_skip' })
  })

  it('待胜期守方超时 = 放弃阻断 → 三连方获胜（reason=line）', async () => {
    const { service, red, blue } = await startGame()
    // 红 0-1-2 三连；蓝两次主动跳过让出回合
    service.applyPlace(red, 0, 0)
    service.applySkip(blue)
    service.applyPlace(red, 0, 1)
    service.applySkip(blue)
    service.applyPlace(red, 0, 2)
    const mid = blue.last<ClientView>('game:state')!
    expect(mid.state.pendingWin?.winnerSide).toBe('red')

    vi.advanceTimersByTime(50)   // 蓝方阻断回合超时

    const ended = blue.last<{ result: { winner: string; reason: string } }>('match:ended')!
    expect(ended.result.winner).toBe('red')
    expect(ended.result.reason).toBe('line')
  })

  it('断线期间回合计时继续：断线方超时被自动跳过；重连不重置剩余时间', async () => {
    const { service, red, blue } = await startGame()
    service.handleDisconnect(red)
    expect(blue.last('opponent:disconnected')).toBeTruthy()

    vi.advanceTimersByTime(50)   // 断线方（红）回合超时：照常自动跳过
    const view = blue.last<ClientView>('game:state')!
    expect(view.state.turnSide).toBe('blue')
    expect(view.events[0]).toMatchObject({ type: 'skipped', side: 'red', timeout: true })
    expect(typeof view.turnDeadline).toBe('number')   // 蓝方回合计时照常下发

    // 重连：不重新起表（蓝方剩余时间继续走，deadline 不变）
    const blueDeadline = view.turnDeadline!
    const red2 = new FakeSocket()
    expect(service.reconnect(red2, 'r')).toBe(true)
    expect(red2.last('match:reconnected')).toBeTruthy()
    const reconnected = red2.last<ClientView>('game:state')!
    expect(reconnected.turnDeadline).toBe(blueDeadline)

    // 重连后蓝方正常落子：换边红方并下发新回合计时（对局继续）
    service.applyPlace(blue, 0, 0)
    const view2 = blue.last<ClientView>('game:state')!
    expect(view2.state.turnSide).toBe('red')
    expect(view2.events[0]).toMatchObject({ type: 'placed', side: 'blue' })
    expect(typeof view2.turnDeadline).toBe('number')
  })
})
