/**
 * P4.1 房间服务：坐席制好友约战房间（内存表）。
 * 坐席：房主（红方坐席）+ 一位挑战者（蓝方坐席）；其余加入者进观战席。
 * 生命周期：创建(waiting) → 双方入座 → 房主点"开始对局"(playing) → 终局回 waiting（可反复开局）。
 * 房主退出（主动/断线）时所有权自动转让给另一位坐席玩家；无坐席玩家则解散房间。
 * TTL 2 小时无活动自动回收（可用 ROOM_TTL_MS 覆盖）。
 */
import { Injectable, Logger, type OnModuleInit } from '@nestjs/common'
import type { ClientSocket } from './match.service.js'
import { MatchService } from './match.service.js'

/** 房间码字符集：去除易混淆的 0/O/1/I，共 32 字符 */
const ROOM_CODE_ALPHABET = '23456789ABCDEFGHJKLMNPQRSTUVWXYZ'
const ROOM_CODE_LEN = 6
/** 房间无活动回收时间（毫秒） */
const ROOM_TTL_MS = Number(process.env.ROOM_TTL_MS ?? 2 * 60 * 60 * 1000)
/** 房间码碰撞重试上限 */
const CODE_RETRY = 5
/** 观战席人数上限 */
const SPECTATOR_LIMIT = 20

/** 加入结果：入座（蓝方坐席）或观战；'host' 仅用于房主重进恢复 */
export type JoinRole = 'host' | 'guest' | 'spectator'

export interface RoomStateView {
  roomId: string
  phase: 'waiting' | 'playing'
  /** 红方坐席（房主）昵称 */
  hostName: string
  /** 蓝方坐席昵称（未入座为 null） */
  guestName: string | null
  spectatorCount: number
}

export type RoomResult<T = undefined> =
  | ({ ok: true } & (T extends undefined ? { data?: undefined } : { data: T }))
  | { ok: false; error: string }

interface RoomMember {
  playerId: string
  name: string
  socket: ClientSocket
}

interface Room {
  roomId: string
  /** 红方坐席 = 房主 */
  host: RoomMember
  /** 蓝方坐席（挑战者） */
  guest: RoomMember | null
  /** 观战席 */
  spectators: RoomMember[]
  phase: 'waiting' | 'playing'
  /** 进行中/最近一场对局 id */
  matchId: string | null
  createdAt: Date
  /** TTL 回收定时器（每次活动重置） */
  ttlTimer: NodeJS.Timeout
}

@Injectable()
export class RoomService implements OnModuleInit {
  private readonly logger = new Logger(RoomService.name)
  private rooms = new Map<string, Room>()
  /** playerId -> roomId（互斥校验用，含观战者） */
  private playerRoom = new Map<string, string>()

  constructor(private readonly matchService: MatchService) {}

  /** 对局终局回调：房间回到 waiting，等待房主再次开局 */
  onModuleInit(): void {
    this.matchService.onMatchEnded(matchId => {
      for (const room of this.rooms.values()) {
        if (room.matchId === matchId) {
          room.phase = 'waiting'
          room.matchId = null
          this.broadcastState(room)
          this.logger.log(`room ${room.roomId}: match ended, back to waiting`)
        }
      }
    })
  }

  /** 创建房间：创建者即房主（红方坐席）。已在房间/对局中则拒绝。 */
  createRoom(playerId: string, name: string, socket: ClientSocket): RoomResult<{ roomId: string }> {
    if (this.isPlayerInRoom(playerId)) return { ok: false, error: 'already_in_room' }
    if (this.matchService.isPlayerInMatch(playerId)) return { ok: false, error: 'in_match' }

    const roomId = this.genRoomCode()
    const room: Room = {
      roomId,
      host: { playerId, name, socket },
      guest: null,
      spectators: [],
      phase: 'waiting',
      matchId: null,
      createdAt: new Date(),
      ttlTimer: setTimeout(() => this.dispose(roomId, 'ttl_expired'), ROOM_TTL_MS),
    }
    this.rooms.set(roomId, room)
    this.playerRoom.set(playerId, roomId)
    this.logger.log(`room ${roomId} created by ${name}(${playerId})`)
    this.broadcastState(room)
    return { ok: true, data: { roomId } }
  }

  /**
   * 加入房间：蓝方坐席空且未开局 → 入座；否则进观战席。
   * 对局进行中加入的观战者立即挂载到对局并收到观战视角。
   */
  async joinRoom(
    roomId: string,
    playerId: string,
    name: string,
    socket: ClientSocket,
  ): Promise<RoomResult<{ role: JoinRole; room: RoomStateView }>> {
    const room = this.rooms.get(roomId)
    if (!room) return { ok: false, error: 'room_not_found' }
    if (this.isPlayerInRoom(playerId)) {
      // 同房间重进（页面刷新/断线重连）：重绑 socket 恢复席位/观战，不占新席位
      const existingId = this.playerRoom.get(playerId)!
      if (existingId !== roomId) return { ok: false, error: 'already_in_room' }
      return this.rejoinRoom(room, playerId, socket)
    }
    if (this.matchService.isPlayerInMatch(playerId)) return { ok: false, error: 'in_match' }

    this.refreshTtl(room)

    // 蓝方坐席空且未开局：入座
    if (!room.guest && room.phase === 'waiting') {
      room.guest = { playerId, name, socket }
      this.playerRoom.set(playerId, roomId)
      this.logger.log(`room ${roomId}: ${name} seated as guest`)
      this.broadcastState(room)
      return { ok: true, data: { role: 'guest', room: this.viewOf(room) } }
    }

    // 否则进观战席（对局中可立即观战）
    if (room.spectators.length >= SPECTATOR_LIMIT) {
      return { ok: false, error: 'spectator_full' }
    }
    room.spectators.push({ playerId, name, socket })
    this.playerRoom.set(playerId, roomId)
    this.logger.log(`room ${roomId}: ${name} joined as spectator`)
    this.broadcastState(room)

    if (room.phase === 'playing' && room.matchId) {
      this.matchService.attachSpectators(room.matchId, [{ name, socket }])
      this.push(socket, 'match:started', {
        youAre: 'spectator',
        redName: room.host.name,
        blueName: room.guest?.name ?? '对手',
      })
    }
    return { ok: true, data: { role: 'spectator', room: this.viewOf(room) } }
  }

  /** 开始对局：仅房主可发起，蓝方坐席须已入座，未在对局中。 */
  async startGame(roomId: string, playerId: string): Promise<RoomResult> {
    const room = this.rooms.get(roomId)
    if (!room) return { ok: false, error: 'room_not_found' }
    if (room.host.playerId !== playerId) return { ok: false, error: 'not_host' }
    if (room.phase === 'playing') return { ok: false, error: 'match_running' }
    if (!room.guest) return { ok: false, error: 'no_guest' }

    const host = room.host
    const guest = room.guest
    const matchId = await this.matchService.startDirectMatch(
      { playerId: host.playerId, name: host.name, socket: host.socket },
      { playerId: guest.playerId, name: guest.name, socket: guest.socket },
    )
    room.phase = 'playing'
    room.matchId = matchId
    this.refreshTtl(room)

    // 观战席转播开局并挂载观战视角
    if (room.spectators.length > 0) {
      this.matchService.attachSpectators(
        matchId,
        room.spectators.map(s => ({ playerId: s.playerId, name: s.name, socket: s.socket })),
      )
      for (const s of room.spectators) {
        this.push(s.socket, 'match:started', {
          youAre: 'spectator',
          redName: host.name,
          blueName: guest.name,
        })
      }
    }
    this.logger.log(`room ${roomId}: match started by host`)
    this.broadcastState(room)
    return { ok: true }
  }

  /** 转让房主：仅房主可发起，仅等待阶段可转让（对局中转让会打乱坐席阵营），转让给蓝方坐席玩家（座位互换）。 */
  transferHost(roomId: string, playerId: string): RoomResult {
    const room = this.rooms.get(roomId)
    if (!room) return { ok: false, error: 'room_not_found' }
    if (room.host.playerId !== playerId) return { ok: false, error: 'not_host' }
    if (room.phase === 'playing') return { ok: false, error: 'match_running' }
    if (!room.guest) return { ok: false, error: 'no_guest' }

    const oldHost = room.host
    room.host = room.guest
    room.guest = oldHost
    this.logger.log(`room ${roomId}: host transferred to ${room.host.name}`)
    this.broadcastState(room)
    return { ok: true }
  }

  /**
   * 退出房间（room:leave 或断线）。
   * 房主退出：有坐席玩家 → 所有权自动转让；无 → 解散房间并通知全员。
   */
  leaveRoom(socket: ClientSocket): void {
    const room = this.roomOfSocket(socket)
    if (!room) return
    this.refreshTtl(room)

    if (room.host.socket === socket) {
      if (room.guest) {
        const oldHost = room.host
        const newHost = room.guest
        room.host = newHost
        room.guest = null
        this.playerRoom.delete(oldHost.playerId)   // 旧房主离场
        this.logger.log(`room ${room.roomId}: host left, host transferred to ${newHost.name}`)
        this.broadcastState(room)
        return
      }
      this.dispose(room.roomId, 'host_left')
      return
    }

    if (room.guest?.socket === socket) {
      this.playerRoom.delete(room.guest.playerId)
      room.guest = null
      this.broadcastState(room)
      return
    }

    const idx = room.spectators.findIndex(s => s.socket === socket)
    if (idx >= 0) {
      this.playerRoom.delete(room.spectators[idx].playerId)
      room.spectators.splice(idx, 1)
      this.broadcastState(room)
    }
  }

  /** 连接断开：等同退出房间（对局中的宽限判负由 MatchService 处理） */
  handleDisconnect(socket: ClientSocket): void {
    this.leaveRoom(socket)
  }

  /** 对局断线重连后：房间成员 socket 重绑（大厅广播可达） */
  rebindSocket(playerId: string, socket: ClientSocket): void {
    const roomId = this.playerRoom.get(playerId)
    if (!roomId) return
    const room = this.rooms.get(roomId)
    if (!room) return
    if (room.host.playerId === playerId) room.host.socket = socket
    else if (room.guest?.playerId === playerId) room.guest.socket = socket
    else {
      const s = room.spectators.find(x => x.playerId === playerId)
      if (s) s.socket = socket
    }
  }

  /**
   * 同房间重进恢复：重绑 socket → 回推房间状态与角色；
   * 对局进行中：坐席玩家走 match:reconnect 恢复视角，观战者走观战恢复。
   */
  private rejoinRoom(room: Room, playerId: string, socket: ClientSocket): RoomResult<{ role: JoinRole; room: RoomStateView }> {
    this.refreshTtl(room)

    if (room.host.playerId === playerId || room.guest?.playerId === playerId) {
      const isHost = room.host.playerId === playerId
      if (isHost) room.host.socket = socket
      else room.guest!.socket = socket
      this.logger.log(`room ${room.roomId}: ${isHost ? 'host' : 'guest'} rejoined`)
      this.broadcastState(room)
      // 对局进行中：恢复对局视角（match:reconnected + 棋盘快照）
      if (room.phase === 'playing' && room.matchId) {
        this.matchService.reconnect(socket, playerId)
      }
      return { ok: true, data: { role: isHost ? 'host' : 'guest', room: this.viewOf(room) } }
    }

    // 观战者重进
    const spec = room.spectators.find(x => x.playerId === playerId)
    if (spec) {
      spec.socket = socket
      this.logger.log(`room ${room.roomId}: spectator ${spec.name} rejoined`)
      this.broadcastState(room)
      if (room.phase === 'playing' && room.matchId) {
        const ok = this.matchService.resumeSpectator(room.matchId, playerId, spec.name, socket)
        if (ok) {
          // 补发观战开局事件，驱动客户端进入观战界面
          this.push(socket, 'match:started', {
            youAre: 'spectator',
            redName: room.host.name,
            blueName: room.guest?.name ?? '对手',
          })
        }
      }
      return { ok: true, data: { role: 'spectator', room: this.viewOf(room) } }
    }

    // playerRoom 有映射但成员已不在（异常态）：清映射走正常加入
    this.playerRoom.delete(playerId)
    return { ok: false, error: 'room_not_found' }
  }

  /** 重连后补发房间状态（恢复大厅 UI） */
  resendState(playerId: string, socket: ClientSocket): void {
    const roomId = this.playerRoom.get(playerId)
    if (!roomId) return
    const room = this.rooms.get(roomId)
    if (!room) return
    this.push(socket, 'room:state', this.viewOf(room))
  }

  isPlayerInRoom(playerId: string): boolean {
    return this.playerRoom.has(playerId)
  }

  /** 玩家所在房间 id（未在房间返回 undefined） */
  roomIdOf(playerId: string): string | undefined {
    return this.playerRoom.get(playerId)
  }

  /** 当前房间数（观测/测试用） */
  get roomCount(): number {
    return this.rooms.size
  }

  // ---------- 内部 ----------

  private viewOf(room: Room): RoomStateView {
    return {
      roomId: room.roomId,
      phase: room.phase,
      hostName: room.host.name,
      guestName: room.guest?.name ?? null,
      spectatorCount: room.spectators.length,
    }
  }

  /** 房间状态广播：房主/坐席/观战全员 */
  private broadcastState(room: Room): void {
    const view = this.viewOf(room)
    const targets: Array<{ socket: ClientSocket }> = [
      room.host,
      ...(room.guest ? [room.guest] : []),
      ...room.spectators,
    ]
    for (const t of targets) this.push(t.socket, 'room:state', view)
  }

  private roomOfSocket(socket: ClientSocket): Room | undefined {
    for (const room of this.rooms.values()) {
      if (
        room.host.socket === socket ||
        room.guest?.socket === socket ||
        room.spectators.some(s => s.socket === socket)
      ) {
        return room
      }
    }
    return undefined
  }

  /** TTL 活动刷新：清旧定时器重新计时 */
  private refreshTtl(room: Room): void {
    clearTimeout(room.ttlTimer)
    room.ttlTimer = setTimeout(() => this.dispose(room.roomId, 'ttl_expired'), ROOM_TTL_MS)
  }

  /** 生成不冲突的房间码；重试上限后带时间戳兜底（极小概率） */
  private genRoomCode(): string {
    for (let attempt = 0; attempt < CODE_RETRY; attempt++) {
      let code = ''
      for (let i = 0; i < ROOM_CODE_LEN; i++) {
        code += ROOM_CODE_ALPHABET[Math.floor(Math.random() * ROOM_CODE_ALPHABET.length)]
      }
      if (!this.rooms.has(code)) return code
    }
    return `R${Date.now().toString(36).toUpperCase().slice(-5)}`
  }

  private dispose(roomId: string, reason: string): void {
    const room = this.rooms.get(roomId)
    if (!room) return
    clearTimeout(room.ttlTimer)
    this.rooms.delete(roomId)
    const members = [room.host, ...(room.guest ? [room.guest] : []), ...room.spectators]
    for (const m of members) {
      this.playerRoom.delete(m.playerId)
      this.push(m.socket, 'room:closed', { reason })
    }
    this.logger.log(`room ${roomId} disposed (${reason})`)
  }

  private push(socket: ClientSocket, event: string, data: unknown): void {
    try {
      socket.send(JSON.stringify({ event, data }))
    } catch {
      // 连接已死则忽略（断线处理由 handleDisconnect 兜底）
    }
  }
}
