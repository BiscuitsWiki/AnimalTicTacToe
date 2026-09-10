/**
 * 对局管理：匹配队列 + 房间 + 服务端权威裁决 + 视角化广播。
 * P2.3：对局结果/棋谱持久化（SQLite）+ 断线宽限期重连。
 */
import { Injectable, Logger } from '@nestjs/common'
import type { WebSocket } from 'ws'
import { PrismaService } from '../prisma.service.js'
import { PieceService } from '../piece/piece.service.js'
import {
  createMatch, opponent, place, resign, shuffle, skip,
} from './core/engine.js'
import { freshDeck } from './core/pieces.js'
import type { MatchResult, MatchState, PlaceEvent, Piece, Side } from './core/types.js'
import { DECK_SIZE } from './core/types.js'
import type { Element } from './core/elements.js'

/** 服务端向某客户端推送的套接字抽象 */
export interface ClientSocket {
  send(data: string): void
}

export interface Player {
  playerId: string
  name: string
  side: Side
  socket: ClientSocket | null   // 断线等待重连期间为 null
}

/** 观战者（P4.1 房间观战席）：只收视角化广播，不可操作 */
export interface Spectator {
  name: string
  socket: ClientSocket
  /** 房间观战者身份标识（重进恢复用） */
  playerId?: string
}

/** 棋谱条目（内存收集，对局结束一次性落库） */
interface ActionRecord {
  seq: number
  side: Side
  type: 'place' | 'deal' | 'skip' | 'resign'
  payload: Record<string, unknown>
}

export interface GameRoom {
  matchId: string
  state: MatchState
  players: Player[]
  /** 观战者（P4.1 房间观战席） */
  spectators: Spectator[]
  actions: ActionRecord[]
  createdAt: Date
  /** 断线判负定时器（重连成功则取消） */
  forfeitTimer: NodeJS.Timeout | null
}

interface WaitingEntry {
  playerId: string
  name: string
  socket: ClientSocket
}

export interface ClientView {
  matchId: string
  youAre: Side | 'spectator'
  state: MatchState          // 视角化后：对手手牌/牌堆为等长占位；观战视角双方手牌均隐藏
  events: PlaceEvent[]       // 最近一次动作产生的事件（战报文案用）
}

let matchSeq = 0

/** 视角化占位棋子（对手手牌/牌堆/他人发牌内容） */
function hiddenPiece(): Piece {
  return { id: 'hidden', name: '?', element: 'normal' as Element }
}

/** 断线重连宽限期（毫秒），可用环境变量覆盖（测试期调短） */
const RECONNECT_GRACE_MS = Number(process.env.RECONNECT_GRACE_MS ?? 60_000)

@Injectable()
export class MatchService {
  private readonly logger = new Logger(MatchService.name)
  private waiting: WaitingEntry[] = []
  private rooms = new Map<string, GameRoom>()
  /** socket -> 房间/玩家索引（断线清理用；观战者 playerId 记 '__spectator__'） */
  private socketRoom = new Map<ClientSocket, { roomId: string; playerId: string }>()
  /** playerId -> 房间 id（重连查找用，房间销毁时移除） */
  private playerRoom = new Map<string, string>()
  /** 对局终局回调（RoomService 注册：房间回到等待态） */
  private matchEndedCallbacks: Array<(matchId: string) => void> = []

  constructor(
    private readonly pieceService: PieceService,
    private readonly prisma: PrismaService,
  ) {}

  /** 注册对局终局回调（RoomService 用） */
  onMatchEnded(cb: (matchId: string) => void): void {
    this.matchEndedCallbacks.push(cb)
  }

  /**
   * 挂载观战者到进行中的对局：立即推送观战视角，后续动作同步广播。
   * 对局不存在/已结束时静默忽略（调用方 RoomService 保证时序）。
   */
  attachSpectators(matchId: string, spectators: Spectator[]): void {
    const room = this.rooms.get(matchId)
    if (!room || room.state.result) return
    for (const s of spectators) {
      room.spectators.push(s)
      this.socketRoom.set(s.socket, { roomId: matchId, playerId: '__spectator__' })
    }
    this.sendSpectatorView(room, [])
  }

  /** 观战者重进恢复：按 playerId 重绑 socket（无则新增），补发观战视角 */
  resumeSpectator(matchId: string, playerId: string, name: string, socket: ClientSocket): boolean {
    const room = this.rooms.get(matchId)
    if (!room || room.state.result) return false
    const existing = room.spectators.find(s => s.playerId === playerId)
    if (existing) existing.socket = socket
    else room.spectators.push({ playerId, name, socket })
    this.socketRoom.set(socket, { roomId: matchId, playerId: '__spectator__' })
    this.logger.log(`match ${matchId}: spectator ${name} resumed`)
    this.sendSpectatorView(room, [])
    return true
  }

  /** 加入匹配队列；队列已有等待者则立即撮合并开局（掷硬币随机先后手） */
  async joinQueue(playerId: string, name: string, socket: ClientSocket): Promise<void> {
    // 同一玩家重复入队：直接忽略
    if (this.waiting.some(w => w.playerId === playerId)) return

    const foe = this.waiting.shift()
    if (!foe) {
      this.waiting.push({ playerId, name, socket })
      this.push(socket, 'queue:waiting', {})
      return
    }

    // 随机先后手：掷硬币决定谁执红先行（房间模式不变，房主执红）
    const seeker = { playerId, name, socket }
    const [red, blue] = Math.random() < 0.5 ? [foe, seeker] : [seeker, foe]
    await this.startDirectMatch(red, blue)
  }

  /** 玩家是否在对局中（房间/队列互斥校验用） */
  isPlayerInMatch(playerId: string): boolean {
    const roomId = this.playerRoom.get(playerId)
    if (!roomId) return false
    const room = this.rooms.get(roomId)
    return !!room && !room.state.result
  }

  /**
   * 直接开局（匹配撮合 / P4.1 房间约战共用）：红方先行。
   * @returns 对局房间 id（matchId）
   */
  async startDirectMatch(
    red: { playerId: string; name: string; socket: ClientSocket },
    blue: { playerId: string; name: string; socket: ClientSocket },
  ): Promise<string> {
    // 公共池组牌（回合发牌制：初始手牌由引擎在开局时自动发）
    const deck = await this.buildDeck()

    const roomId = `m${++matchSeq}`
    const room: GameRoom = {
      matchId: roomId,
      state: createMatch({ deck: deck.slice(0, DECK_SIZE) }),
      players: [
        { playerId: red.playerId, name: red.name, side: 'red', socket: red.socket },
        { playerId: blue.playerId, name: blue.name, side: 'blue', socket: blue.socket },
      ],
      spectators: [],
      actions: [],
      createdAt: new Date(),
      forfeitTimer: null,
    }
    this.rooms.set(roomId, room)
    this.socketRoom.set(red.socket, { roomId, playerId: red.playerId })
    this.socketRoom.set(blue.socket, { roomId, playerId: blue.playerId })
    this.playerRoom.set(red.playerId, roomId)
    this.playerRoom.set(blue.playerId, roomId)

    this.logger.log(`match ${roomId} started: ${red.name}(red) vs ${blue.name}(blue)`)
    for (const p of room.players) {
      this.push(p.socket, 'match:started', {
        matchId: roomId,
        youAre: p.side,
        opponentName: room.players.find(x => x.side !== p.side)?.name ?? '对手',
      })
      this.sendView(room, p, [])
    }
    return roomId
  }

  /** 退出队列（未匹配成功时） */
  leaveQueue(playerId: string): void {
    this.waiting = this.waiting.filter(w => w.playerId !== playerId)
  }

  /** 重连：按 playerId 恢复对局绑定与视角。返回是否成功。 */
  reconnect(socket: ClientSocket, playerId: string): boolean {
    const roomId = this.playerRoom.get(playerId)
    const room = roomId ? this.rooms.get(roomId) : undefined
    if (!room || room.state.result) return false

    const player = room.players.find(p => p.playerId === playerId)
    if (!player) return false

    // 恢复绑定
    player.socket = socket
    this.socketRoom.set(socket, { roomId: room.matchId, playerId })
    if (room.forfeitTimer) {
      clearTimeout(room.forfeitTimer)
      room.forfeitTimer = null
    }

    const foe = room.players.find(p => p.side !== player.side)!
    this.logger.log(`match ${room.matchId}: ${player.name} reconnected`)
    this.push(socket, 'match:reconnected', {
      youAre: player.side,
      opponentName: foe.name,
    })
    this.sendView(room, player, [])
    this.push(foe.socket, 'opponent:reconnected', {})
    return true
  }

  /** 落子指令（回合发牌制：发牌在 place 内自动结算并随事件广播） */
  applyPlace(socket: ClientSocket, handIdx: number, cellIdx: number): void {
    const room = this.roomOf(socket)
    if (!room) return
    const player = this.playerOf(room, socket)
    if (!player || room.state.turnSide !== player.side) return
    try {
      const events = place(room.state, player.side, handIdx, cellIdx)
      for (const e of events) {
        if (e.type === 'placed') {
          this.record(room, e.side, 'place', { handIdx, cellIdx })
        }
        // 棋谱记录本回合自动抽牌
        if (e.type === 'dealt') {
          this.record(room, e.side, 'deal', { count: e.pieces.length })
        }
      }
      this.broadcast(room, events)
      if (room.state.result) {
        this.endMatch(room, room.state.result.winner, room.state.result.reason)
      }
    } catch {
      this.sendView(room, player, [])   // 非法落子：回推纠偏
    }
  }

  /**
   * 跳过指令：本轮不落子，正常换边抽牌。
   * 待胜期守方跳过 = 未阻断（三连方获胜）；双方连续跳过 = 平局（both_skip）。
   */
  applySkip(socket: ClientSocket): void {
    const room = this.roomOf(socket)
    if (!room) return
    const player = this.playerOf(room, socket)
    if (!player || room.state.turnSide !== player.side) return
    try {
      const events = skip(room.state, player.side)
      this.record(room, player.side, 'skip', {})
      // 棋谱记录跳过后对手的自动抽牌
      for (const e of events) {
        if (e.type === 'dealt') {
          this.record(room, e.side, 'deal', { count: e.pieces.length })
        }
      }
      this.broadcast(room, events)
      if (room.state.result) {
        this.endMatch(room, room.state.result.winner, room.state.result.reason)
      }
    } catch {
      this.sendView(room, player, [])   // 非法跳过（已终局等）：回推纠偏
    }
  }

  /** 认输指令：side 直接判负，对方获胜 */
  applyResign(socket: ClientSocket): void {
    const room = this.roomOf(socket)
    if (!room) return
    const player = this.playerOf(room, socket)
    if (!player || room.state.result) return
    try {
      const events = resign(room.state, player.side)
      this.record(room, player.side, 'resign', {})
      this.broadcast(room, events)
      this.endMatch(room, room.state.result!.winner, room.state.result!.reason)
    } catch {
      // 对局已结束等异常：忽略
    }
  }

  /**
   * 断线：清队列；对局中进入宽限期等待重连，超时判对手胜。
   */
  handleDisconnect(socket: ClientSocket): void {
    const entry = this.socketRoom.get(socket)
    this.socketRoom.delete(socket)
    this.waiting = this.waiting.filter(w => w.socket !== socket)
    if (!entry) return

    const room = this.rooms.get(entry.roomId)
    if (!room) return

    // 观战者断线：直接移除，不占用宽限期
    const specIdx = room.spectators.findIndex(s => s.socket === socket)
    if (specIdx >= 0) {
      room.spectators.splice(specIdx, 1)
      return
    }

    const quitter = room.players.find(p => p.playerId === entry.playerId)
    if (!quitter || room.state.result) {
      this.disposeRoom(room)
      return
    }

    // 宽限期：不立即判负，等待重连
    quitter.socket = null
    const stayer = room.players.find(p => p.side !== quitter.side)!
    this.logger.warn(`match ${room.matchId}: ${quitter.name} disconnected (grace ${RECONNECT_GRACE_MS}ms)`)
    this.push(stayer.socket, 'opponent:disconnected', { graceMs: RECONNECT_GRACE_MS })

    room.forfeitTimer = setTimeout(() => {
      if (room.state.result) return
      this.logger.warn(`match ${room.matchId}: grace expired, ${quitter.name} forfeits`)
      this.endMatch(room, opponent(quitter.side), 'opponent_disconnect')
    }, RECONNECT_GRACE_MS)
  }

  // ---------- 内部工具 ----------

  /** 统一终局：落库（Match + 棋谱）→ 广播 → 清理房间 */
  private endMatch(room: GameRoom, winner: Side | 'draw', reason: string): void {
    if (room.forfeitTimer) {
      clearTimeout(room.forfeitTimer)
      room.forfeitTimer = null
    }
    room.state.phase = 'FINISHED'
    room.state.result = { winner, reason: reason as MatchResult['reason'] }

    for (const p of room.players) {
      this.push(p.socket, 'match:ended', {
        result: room.state.result,
        youWin: winner === p.side,
        ...(reason === 'opponent_disconnect' ? { reason: 'opponent_disconnect' } : {}),
      })
    }
    // 观战者只收结果
    for (const s of room.spectators) {
      this.push(s.socket, 'match:ended', { result: room.state.result })
    }
    this.persistMatch(room, winner, reason).catch(e =>
      this.logger.error(`persist match ${room.matchId} failed: ${String(e)}`),
    )
    this.disposeRoom(room)
    for (const cb of this.matchEndedCallbacks) {
      try {
        cb(room.matchId)
      } catch (e) {
        this.logger.error(`matchEnded callback failed: ${String(e)}`)
      }
    }
  }

  /** 对局结果 + 棋谱落库（异步执行，失败仅记日志不影响对局） */
  private async persistMatch(room: GameRoom, winner: Side | 'draw', reason: string): Promise<void> {
    const [red, blue] = room.players
    const saved = await this.prisma.match.create({
      data: {
        redPlayerId: red.playerId,
        bluePlayerId: blue.playerId,
        redName: red.name,
        blueName: blue.name,
        winnerSide: winner,
        reason,
        createdAt: room.createdAt,
        endedAt: new Date(),
      },
    })
    if (room.actions.length > 0) {
      await this.prisma.matchAction.createMany({
        data: room.actions.map(a => ({
          matchId: saved.id,
          seq: a.seq,
          side: a.side,
          type: a.type,
          payload: JSON.stringify(a.payload),
        })),
      })
    }
    this.logger.log(`match ${room.matchId} persisted as ${saved.id}: ${winner} (${reason})`)
  }

  /** 记录棋谱动作 */
  private record(room: GameRoom, side: Side, type: ActionRecord['type'], payload: Record<string, unknown>): void {
    room.actions.push({ seq: room.actions.length + 1, side, type, payload })
  }

  private roomOf(socket: ClientSocket): GameRoom | undefined {
    const entry = this.socketRoom.get(socket)
    return entry ? this.rooms.get(entry.roomId) : undefined
  }

  private playerOf(room: GameRoom, socket: ClientSocket): Player | undefined {
    return room.players.find(p => p.socket === socket)
  }

  private disposeRoom(room: GameRoom): void {
    if (room.forfeitTimer) clearTimeout(room.forfeitTimer)
    for (const p of room.players) {
      if (p.socket) this.socketRoom.delete(p.socket as WebSocket)
      this.playerRoom.delete(p.playerId)
    }
    for (const s of room.spectators) {
      this.socketRoom.delete(s.socket as WebSocket)
    }
    this.rooms.delete(room.matchId)
  }

  private broadcast(room: GameRoom, events: PlaceEvent[]): void {
    for (const p of room.players) this.sendView(room, p, events)
    if (room.spectators.length > 0) this.sendSpectatorView(room, events)
  }

  /** 事件视角化：dealt 事件中非查看者阵营的牌面替换为占位（防泄密） */
  private sanitizeEvents(events: PlaceEvent[], viewerSide: Side | 'spectator'): PlaceEvent[] {
    return events.map(e =>
      e.type === 'dealt' && e.side !== viewerSide
        ? { ...e, pieces: e.pieces.map(() => hiddenPiece()) }
        : e,
    )
  }

  /** 观战视角推送：双方手牌与牌堆均隐藏为占位 */
  private sendSpectatorView(room: GameRoom, events: PlaceEvent[]): void {
    const hidden = (n: number) => Array.from({ length: n }, () => hiddenPiece())
    const s = room.state
    const view: ClientView = {
      matchId: room.matchId,
      youAre: 'spectator',
      state: {
        ...s,
        hands: {
          red: hidden(s.hands.red.length),
          blue: hidden(s.hands.blue.length),
        } as MatchState['hands'],
        deck: hidden(s.deck.length),
      },
      events: this.sanitizeEvents(events, 'spectator'),
    }
    for (const spec of room.spectators) this.push(spec.socket, 'game:state', view)
  }

  /** 视角化推送：对手手牌与牌堆只发数量（等长占位） */
  private sendView(room: GameRoom, player: Player, events: PlaceEvent[]): void {
    if (!player.socket) return   // 断线中：跳过，重连时补发
    const hidden = (n: number) => Array.from({ length: n }, () => hiddenPiece())
    const s = room.state
    const foe = opponent(player.side)
    const view: ClientView = {
      matchId: room.matchId,
      youAre: player.side,
      state: {
        ...s,
        hands: {
          [player.side]: s.hands[player.side],
          [foe]: hidden(s.hands[foe].length),
        } as MatchState['hands'],
        deck: hidden(s.deck.length),
      },
      events: this.sanitizeEvents(events, player.side),
    }
    this.push(player.socket, 'game:state', view)
  }

  /** 组牌：与客户端 deckSource 语义一致——工坊审核池 ≥36 张时随机取 36 张；不足时整副回退预设牌（36 张属性齐全），绝不出现占位卡 */
  private async buildDeck() {
    const approved = await this.pieceService.listApproved(500)
    const pieces = approved.map(p => ({
      id: p.id, name: p.name, element: p.element as Element,
    }))
    if (pieces.length >= DECK_SIZE) {
      return shuffle(pieces).slice(0, DECK_SIZE) as Piece[]
    }
    return freshDeck()
  }

  private push(socket: ClientSocket | null, event: string, data: unknown): void {
    if (!socket) return
    try {
      socket.send(JSON.stringify({ event, data }))
    } catch {
      // 连接已死则忽略（断线处理由 handleDisconnect 兜底）
    }
  }
}
