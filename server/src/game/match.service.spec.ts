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

function makeService() {
  const pieceService = { listApproved: async () => [] as unknown[] }
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

describe('MatchService 回合倒计时', () => {
  beforeEach(() => {
    vi.useFakeTimers()
  })

  afterEach(() => {
    vi.useRealTimers()
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
    service.applyPlace(red, 0, 0)   // 红方立即落子（50ms 内）
    expect(blue.last<ClientView>('game:state')!.state.turnSide).toBe('blue')

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

  it('断线宽限期暂停计时：超时窗口内无 skipped；重连后恢复计时', async () => {
    const { service, red, blue } = await startGame()
    service.handleDisconnect(red)
    expect(blue.last('opponent:disconnected')).toBeTruthy()

    vi.advanceTimersByTime(500)   // 宽限期内（默认 60s）：不产生任何自动跳过
    expect([...blue.views()].flatMap(v => v.events).some(e => e.type === 'skipped')).toBe(false)
    expect(blue.last<ClientView>('game:state')!.state.turnSide).toBe('red')

    // 重连：恢复回合计时（重连方红方仍为行动方）
    const red2 = new FakeSocket()
    expect(service.reconnect(red2, 'r')).toBe(true)
    expect(red2.last('match:reconnected')).toBeTruthy()
    vi.advanceTimersByTime(50)
    const view = red2.last<ClientView>('game:state')!
    expect(view.state.turnSide).toBe('blue')
    expect(view.events[0]).toMatchObject({ type: 'skipped', side: 'red', timeout: true })
  })
})
