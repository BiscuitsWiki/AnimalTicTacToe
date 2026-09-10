/**
 * P4.1 RoomService 坐席制单元测试：
 * 创建/入座/观战席/开始对局/房主转让（主动+自动）/解散/TTL/终局回等待态。
 * MatchService 用替身（isPlayerInMatch / startDirectMatch / attachSpectators / onMatchEnded）。
 */
import { Test } from '@nestjs/testing'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { MatchService } from './match.service.js'
import { RoomService } from './room.service.js'

/** 可记录消息的最小 socket 替身 */
class FakeSocket {
  sent: { event: string; data: unknown }[] = []
  send(data: string): void {
    this.sent.push(JSON.parse(data))
  }
  /** 最近一次某事件的 data */
  last(event: string): unknown {
    for (let i = this.sent.length - 1; i >= 0; i--) {
      if (this.sent[i].event === event) return this.sent[i].data
    }
    return undefined
  }
}

function fakeMatchService() {
  const inMatch = new Set<string>()
  const started: Array<{
    red: { playerId: string; name: string }
    blue: { playerId: string; name: string }
  }> = []
  const attached: Array<{ matchId: string; count: number }> = []
  const endedCallbacks: Array<(matchId: string) => void> = []
  let seq = 0
  return {
    started,
    attached,
    endedCallbacks,
    isPlayerInMatch: (id: string) => inMatch.has(id),
    setInMatch: (id: string, v: boolean) => (v ? inMatch.add(id) : inMatch.delete(id)),
    startDirectMatch: async (
      red: { playerId: string; name: string; socket: unknown },
      blue: { playerId: string; name: string; socket: unknown },
    ) => {
      const matchId = `m${++seq}`
      started.push({ red, blue })
      inMatch.add(red.playerId)
      inMatch.add(blue.playerId)
      return matchId
    },
    attachSpectators: (matchId: string, spectators: unknown[]) => {
      attached.push({ matchId, count: spectators.length })
    },
    reconnect: vi.fn(() => true),
    resumeSpectator: vi.fn(() => true),
    onMatchEnded: (cb: (matchId: string) => void) => {
      endedCallbacks.push(cb)
    },
    /** 测试辅助：模拟对局终局 */
    fireMatchEnded: (matchId: string) => {
      for (const cb of endedCallbacks) cb(matchId)
    },
  }
}

type FakeMatch = ReturnType<typeof fakeMatchService>

describe('RoomService（坐席制）', () => {
  let service: RoomService
  let match: FakeMatch

  beforeEach(async () => {
    match = fakeMatchService()
    const moduleRef = await Test.createTestingModule({
      providers: [
        RoomService,
        { provide: MatchService, useValue: match },
      ],
    }).compile()
    service = moduleRef.get(RoomService)
    service.onModuleInit()   // 手动触发终局回调注册
    vi.useFakeTimers()
  })

  afterEach(() => {
    vi.useRealTimers()
  })

  const create = (id = 'p1', name = '小明', sock = new FakeSocket()) => {
    const res = service.createRoom(id, name, sock as never)
    return { res, sock }
  }

  const seatGuest = async (roomId: string, id = 'p2', name = '客人', sock = new FakeSocket()) => {
    return { res: await service.joinRoom(roomId, id, name, sock as never), sock }
  }

  it('创建房间：返回 6 位房间码，房主即红方坐席', () => {
    const { res } = create()
    expect(res.ok).toBe(true)
    if (!res.ok) return
    expect(res.data.roomId).toMatch(/^[2-9A-HJ-NP-Z]{6}$/)
    expect(service.isPlayerInRoom('p1')).toBe(true)
  })

  it('重复创建/已在房间中：拒绝 already_in_room', () => {
    create()
    const res = service.createRoom('p1', '小明', new FakeSocket() as never)
    expect(res).toEqual({ ok: false, error: 'already_in_room' })
  })

  it('首位加入者入座蓝方坐席，第二位进观战席', async () => {
    const { res } = create()
    if (!res.ok) return
    const roomId = res.data.roomId

    const g = await seatGuest(roomId)
    expect(g.res.ok).toBe(true)
    if (!g.res.ok) return
    expect(g.res.data.role).toBe('guest')

    const s = await seatGuest(roomId, 'p3', '路人')
    expect(s.res.ok).toBe(true)
    if (!s.res.ok) return
    expect(s.res.data.role).toBe('spectator')
    expect(s.res.data.room.spectatorCount).toBe(1)
  })

  it('刷新重进同一房间：房主/蓝方/观战者恢复原身份，不占新席位', async () => {
    const { res } = create()
    if (!res.ok) return
    const roomId = res.data.roomId
    await seatGuest(roomId)
    const spec = await seatGuest(roomId, 'p3', '路人')

    // 房主换新 socket 重进 → role 'host'
    const hostRe = await service.joinRoom(roomId, 'p1', '小明', new FakeSocket() as never)
    expect(hostRe.ok).toBe(true)
    if (hostRe.ok) expect(hostRe.data.role).toBe('host')

    // 蓝方重进 → role 'guest'
    const guestRe = await service.joinRoom(roomId, 'p2', '客人', new FakeSocket() as never)
    expect(guestRe.ok).toBe(true)
    if (guestRe.ok) expect(guestRe.data.role).toBe('guest')

    // 观战者重进 → role 'spectator'，观战席人数不增
    const specRe = await service.joinRoom(roomId, 'p3', '路人', new FakeSocket() as never)
    expect(specRe.ok).toBe(true)
    if (specRe.ok) {
      expect(specRe.data.role).toBe('spectator')
      expect(specRe.data.room.spectatorCount).toBe(1)
    }
    void spec
  })

  it('对局中刷新重进：坐席玩家走对局恢复，观战者走观战恢复', async () => {
    const { res } = create()
    if (!res.ok) return
    const roomId = res.data.roomId
    await seatGuest(roomId)
    const spec = await seatGuest(roomId, 'p3', '路人')
    await service.startGame(roomId, 'p1')

    match.reconnect.mockClear()
    match.resumeSpectator.mockClear()

    // 房主重进（对局中）：触发对局恢复
    const hostSock = new FakeSocket()
    const hostRe = await service.joinRoom(roomId, 'p1', '小明', hostSock as never)
    expect(hostRe.ok).toBe(true)
    expect(match.reconnect).toHaveBeenCalledWith(hostSock, 'p1')

    // 观战者重进（对局中）：触发观战恢复 + 收到观战开局事件
    const specSock = new FakeSocket()
    const specRe = await service.joinRoom(roomId, 'p3', '路人', specSock as never)
    expect(specRe.ok).toBe(true)
    expect(match.resumeSpectator).toHaveBeenCalled()
    const start = specSock.last('match:started') as { youAre: string } | undefined
    expect(start?.youAre).toBe('spectator')
    void spec
  })

  it('开始对局：非房主/无坐席玩家/重复开始均被拒', async () => {
    const { res } = create()
    if (!res.ok) return
    const roomId = res.data.roomId

    // 无蓝方坐席
    expect(await service.startGame(roomId, 'p1')).toEqual({ ok: false, error: 'no_guest' })
    // 非房主发起
    await seatGuest(roomId)
    expect(await service.startGame(roomId, 'p2')).toEqual({ ok: false, error: 'not_host' })
    // 房主发起 → 成功
    expect((await service.startGame(roomId, 'p1')).ok).toBe(true)
    // 重复开始
    expect(await service.startGame(roomId, 'p1')).toEqual({ ok: false, error: 'match_running' })
  })

  it('开始对局：房主红方、蓝方坐席为蓝方，观战者挂载并收转播', async () => {
    const { res, sock: hostSock } = create()
    if (!res.ok) return
    const roomId = res.data.roomId
    const { sock: guestSock } = await seatGuest(roomId)
    const { sock: specSock } = await seatGuest(roomId, 'p3', '路人')

    const start = await service.startGame(roomId, 'p1')
    expect(start.ok).toBe(true)
    // 开局参数：房主红、坐席蓝
    expect(match.started).toHaveLength(1)
    expect(match.started[0].red.playerId).toBe('p1')
    expect(match.started[0].blue.playerId).toBe('p2')
    // 观战者被挂载到对局
    expect(match.attached).toEqual([{ matchId: match.started[0] ? 'm1' : '', count: 1 }])
    // 观战者收到观战版 match:started
    const specStart = specSock.last('match:started') as { youAre: string; redName: string; blueName: string }
    expect(specStart.youAre).toBe('spectator')
    expect(specStart.redName).toBe('小明')
    expect(specStart.blueName).toBe('客人')
    // 房主收到 playing 态房间状态
    const state = hostSock.last('room:state') as { phase: string }
    expect(state.phase).toBe('playing')
    void guestSock
  })

  it('对局中第三者加入：进观战席并立即挂载对局', async () => {
    const { res } = create()
    if (!res.ok) return
    const roomId = res.data.roomId
    await seatGuest(roomId)
    await service.startGame(roomId, 'p1')

    const late = await seatGuest(roomId, 'p3', '迟到者')
    expect(late.res.ok).toBe(true)
    if (!late.res.ok) return
    expect(late.res.data.role).toBe('spectator')
    expect(match.attached.at(-1)?.count).toBe(1)
    const start = late.sock.last('match:started') as { youAre: string }
    expect(start.youAre).toBe('spectator')
  })

  it('房主换边：红蓝坐席昵称互换，再换回来', async () => {
    const { res, sock: hostSock } = create()
    if (!res.ok) return
    const roomId = res.data.roomId
    await seatGuest(roomId)

    const swap1 = service.swapSeats(roomId, 'p1')
    expect(swap1.ok).toBe(true)
    let state = hostSock.last('room:state') as { redName: string; blueName: string | null }
    expect(state.redName).toBe('客人')
    expect(state.blueName).toBe('小明')

    const swap2 = service.swapSeats(roomId, 'p1')
    expect(swap2.ok).toBe(true)
    state = hostSock.last('room:state') as { redName: string; blueName: string | null }
    expect(state.redName).toBe('小明')
    expect(state.blueName).toBe('客人')
  })

  it('换边后开局：挑战者执红先行（房主选后手）', async () => {
    const { res } = create()
    if (!res.ok) return
    const roomId = res.data.roomId
    await seatGuest(roomId)
    expect(service.swapSeats(roomId, 'p1').ok).toBe(true)

    const start = await service.startGame(roomId, 'p1')
    expect(start.ok).toBe(true)
    expect(match.started).toHaveLength(1)
    expect(match.started[0].red.playerId).toBe('p2')
    expect(match.started[0].blue.playerId).toBe('p1')
  })

  it('非房主换边被拒', async () => {
    const { res } = create()
    if (!res.ok) return
    const roomId = res.data.roomId
    await seatGuest(roomId)
    expect(service.swapSeats(roomId, 'p2')).toEqual({ ok: false, error: 'not_host' })
  })

  it('对局中不可换边', async () => {
    const { res } = create()
    if (!res.ok) return
    const roomId = res.data.roomId
    await seatGuest(roomId)
    await service.startGame(roomId, 'p1')
    expect(service.swapSeats(roomId, 'p1')).toEqual({ ok: false, error: 'match_running' })
  })

  it('主动转让房主：座位互换，新旧房主身份对调', async () => {
    const { res } = create()
    if (!res.ok) return
    const roomId = res.data.roomId
    const { sock: guestSock } = await seatGuest(roomId)

    // 非房主不能转让
    expect(service.transferHost(roomId, 'p2')).toEqual({ ok: false, error: 'not_host' })
    expect(service.transferHost(roomId, 'p1').ok).toBe(true)

    const state = guestSock.last('room:state') as { hostName: string; guestName: string }
    expect(state.hostName).toBe('客人')
    expect(state.guestName).toBe('小明')
  })

  it('对局中不可转让房主', async () => {
    const { res } = create()
    if (!res.ok) return
    const roomId = res.data.roomId
    await seatGuest(roomId)
    await service.startGame(roomId, 'p1')

    expect(service.transferHost(roomId, 'p1')).toEqual({ ok: false, error: 'match_running' })
  })

  it('房主退出（有坐席玩家）：所有权自动转让，房间保留', async () => {
    const { res, sock: hostSock } = create()
    if (!res.ok) return
    const roomId = res.data.roomId
    const { sock: guestSock } = await seatGuest(roomId)

    service.leaveRoom(hostSock as never)
    expect(service.roomCount).toBe(1)   // 房间保留
    const state = guestSock.last('room:state') as { hostName: string; guestName: string | null }
    expect(state.hostName).toBe('客人')
    expect(state.guestName).toBeNull()
    // 旧房主已离场
    expect(service.isPlayerInRoom('p1')).toBe(false)
    expect(service.isPlayerInRoom('p2')).toBe(true)
  })

  it('房主退出（无坐席玩家）：解散房间并通知观战者', async () => {
    const { res, sock: hostSock } = create()
    if (!res.ok) return
    const roomId = res.data.roomId
    // 先入座再观战，然后坐席玩家退出 → 房间只剩房主+观战者
    const { sock: guestSock } = await seatGuest(roomId)
    const { sock: specSock } = await seatGuest(roomId, 'p3', '路人')
    service.leaveRoom(guestSock as never)

    service.leaveRoom(hostSock as never)
    expect(service.roomCount).toBe(0)
    const closed = specSock.last('room:closed') as { reason: string }
    expect(closed.reason).toBe('host_left')
  })

  it('蓝方坐席退出：坐席清空，房间保留', async () => {
    const { res } = create()
    if (!res.ok) return
    const roomId = res.data.roomId
    const { sock: guestSock } = await seatGuest(roomId)

    service.leaveRoom(guestSock as never)
    expect(service.roomCount).toBe(1)
    expect(service.isPlayerInRoom('p2')).toBe(false)
  })

  it('观战者退出：观战人数减少', async () => {
    const { res } = create()
    if (!res.ok) return
    const roomId = res.data.roomId
    await seatGuest(roomId)
    const { sock: specSock } = await seatGuest(roomId, 'p3', '路人')

    service.leaveRoom(specSock as never)
    expect(service.roomCount).toBe(1)
    expect(service.isPlayerInRoom('p3')).toBe(false)
  })

  it('对局终局：房间回到 waiting，可再次开局', async () => {
    const { res, sock: hostSock } = create()
    if (!res.ok) return
    const roomId = res.data.roomId
    await seatGuest(roomId)
    await service.startGame(roomId, 'p1')
    const matchId = match.started[0] ? 'm1' : ''

    // 模拟终局回调
    match.fireMatchEnded(matchId)
    const state = hostSock.last('room:state') as { phase: string }
    expect(state.phase).toBe('waiting')
    // 可再次开局
    expect((await service.startGame(roomId, 'p1')).ok).toBe(true)
    expect(match.started).toHaveLength(2)
  })

  it('断线等同退出：房主断线触发自动转让', async () => {
    const { res, sock: hostSock } = create()
    if (!res.ok) return
    const roomId = res.data.roomId
    const { sock: guestSock } = await seatGuest(roomId)

    service.handleDisconnect(hostSock as never)
    const state = guestSock.last('room:state') as { hostName: string }
    expect(state.hostName).toBe('客人')
  })

  it('TTL 到期：房间自动回收并通知全员', async () => {
    const { res, sock: hostSock } = create()
    if (!res.ok) return
    const roomId = res.data.roomId
    const { sock: specSock } = await seatGuest(roomId, 'p3', '路人')

    vi.advanceTimersByTime(2 * 60 * 60 * 1000 + 1000)
    expect(service.roomCount).toBe(0)
    const closed = specSock.last('room:closed') as { reason: string }
    expect(closed.reason).toBe('ttl_expired')
    const hostClosed = hostSock.last('room:closed') as { reason: string }
    expect(hostClosed.reason).toBe('ttl_expired')
  })

  it('TTL 活动刷新：加入操作会重置回收计时', async () => {
    const { res } = create()
    if (!res.ok) return
    const roomId = res.data.roomId
    vi.advanceTimersByTime(60 * 60 * 1000)   // 1 小时无操作
    // 加入触发 TTL 刷新
    const g = await seatGuest(roomId)
    expect(g.res.ok).toBe(true)
    vi.advanceTimersByTime(60 * 60 * 1000)   // 再过 1 小时（自加入起算未到期）
    expect(service.roomCount).toBe(1)
    vi.advanceTimersByTime(2 * 60 * 60 * 1000)
    expect(service.roomCount).toBe(0)
  })
})
