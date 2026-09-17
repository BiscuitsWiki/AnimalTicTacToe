/**
 * WS 网关：客户端消息格式 { event: string, data: object }（与 @nestjs/platform-ws 默认协议一致）。
 * H5 用浏览器原生 WebSocket，小程序用 Taro.connectSocket，均可直连。
 *
 * 应用层心跳：客户端每 15s 发 app:ping（服务端回 app:pong 并刷新房间 TTL）；
 * 超过 WS_HEARTBEAT_TIMEOUT_MS 未 ping 的连接视为半开死连接，主动断开以驱动清理
 * （否则房间会一直握着一个已掉线的房主，形成"幽灵房间"）。
 */
import { Logger, type OnModuleDestroy, type OnModuleInit } from '@nestjs/common'
import { SubscribeMessage, WebSocketGateway } from '@nestjs/websockets'
import type { WebSocket } from 'ws'
import { AuthService } from '../auth/auth.service.js'
import { createHeartbeat, WS_HEARTBEAT_SWEEP_MS } from '../common/ws-heartbeat.js'
import { MatchService } from './match.service.js'
import { RoomService } from './room.service.js'

@WebSocketGateway({ path: '/ws' })
export class GameGateway implements OnModuleInit, OnModuleDestroy {
  private readonly logger = new Logger(GameGateway.name)
  /** 应用层心跳跟踪（半开连接检测） */
  private readonly heartbeat = createHeartbeat()
  private sweepTimer: NodeJS.Timeout | null = null

  constructor(
    private readonly matchService: MatchService,
    private readonly roomService: RoomService,
    private readonly auth: AuthService,
  ) {}

  onModuleInit(): void {
    this.sweepTimer = setInterval(() => this.sweepStaleSockets(), WS_HEARTBEAT_SWEEP_MS)
    this.sweepTimer.unref()
  }

  onModuleDestroy(): void {
    if (this.sweepTimer) clearInterval(this.sweepTimer)
  }

  /** 扫描死连接并断开（terminate 会触发 handleDisconnect → 对局宽限/房间席位清理） */
  private sweepStaleSockets(): void {
    const stale = this.heartbeat.stale()
    for (const socket of stale) {
      this.heartbeat.untrack(socket)
      this.logger.warn(`ws heartbeat timeout, terminating stale connection (alive=${this.heartbeat.size})`)
      try {
        (socket as WebSocket).terminate()
      } catch {
        // 已关闭：忽略
      }
    }
  }

  handleConnection(client: WebSocket): void {
    this.heartbeat.track(client)
  }

  handleDisconnect(client: WebSocket): void {
    this.heartbeat.untrack(client)
    this.matchService.handleDisconnect(client)
    this.roomService.handleDisconnect(client)
  }

  /** 应用层心跳：刷新连接活跃时间 + 房间 TTL（连接中的房间不应被 TTL 回收） */
  @SubscribeMessage('app:ping')
  onAppPing(client: WebSocket, data: { playerId?: string }) {
    this.heartbeat.touch(client)
    if (data?.playerId) this.roomService.touch(String(data.playerId).slice(0, 64))
    client.send(JSON.stringify({ event: 'app:pong', data: { ts: Date.now() } }))
    return { ok: true }
  }

  @SubscribeMessage('queue:join')
  async onQueueJoin(client: WebSocket, data: { token?: string; playerId?: string; name?: string }) {
    // 登录态优先：token 解析出 userId/昵称；未登录回退旧行为（playerId+name）
    const user = await this.auth.verifyTokenOrNull(data?.token)
    const playerId = user?.id ?? String(data?.playerId ?? '').slice(0, 64)
    if (!playerId) return { ok: false, error: 'unauthorized' }
    const name = user?.nickname ?? (String(data?.name ?? '玩家').slice(0, 16) || '玩家')
    // 互斥：已在约战房间等待中则不允许同时排匹配队列
    if (this.roomService.isPlayerInRoom(playerId)) return { ok: false, error: 'in_room' }
    void this.matchService.joinQueue(playerId, name, client)
    return { ok: true }
  }

  @SubscribeMessage('queue:leave')
  onQueueLeave(client: WebSocket, data: { playerId: string }) {
    this.matchService.leaveQueue(String(data?.playerId ?? ''))
    return { ok: true }
  }

  /** 断线重连：token（优先）或 playerId 恢复对局 */
  @SubscribeMessage('match:reconnect')
  async onReconnect(client: WebSocket, data: { token?: string; playerId?: string }) {
    const user = await this.auth.verifyTokenOrNull(data?.token)
    const playerId = user?.id ?? String(data?.playerId ?? '').slice(0, 64)
    if (!playerId) {
      client.send(JSON.stringify({ event: 'match:reconnect', data: { ok: false, error: 'unauthorized' } }))
      return
    }
    const ok = this.matchService.reconnect(client, playerId)
    if (ok) {
      // 房间成员 socket 重绑 + 补发房间状态（恢复大厅 UI）
      this.roomService.rebindSocket(playerId, client)
      this.roomService.resendState(playerId, client)
      client.send(JSON.stringify({ event: 'match:reconnect', data: { ok: true } }))
    } else {
      // 不在对局中：附带所在房间（若有），客户端据此走房间重进
      const inRoom = this.roomService.isPlayerInRoom(playerId)
        ? this.roomService.roomIdOf(playerId)
        : undefined
      client.send(JSON.stringify({ event: 'match:reconnect', data: { ok: false, error: 'not_in_match', inRoom } }))
    }
  }

  @SubscribeMessage('game:place')
  onPlace(client: WebSocket, data: { handIdx: number; cellIdx: number }) {
    this.matchService.applyPlace(
      client,
      Number(data?.handIdx),
      Number(data?.cellIdx),
    )
    return { ok: true }
  }

  /** 跳过回合：本轮不落子，正常换边抽牌（待胜期守方跳过 = 未阻断） */
  @SubscribeMessage('game:skip')
  onSkip(client: WebSocket) {
    this.matchService.applySkip(client)
    return { ok: true }
  }

  /** 认输：对局中玩家主动判负，对方获胜 */
  @SubscribeMessage('game:resign')
  onResign(client: WebSocket) {
    this.matchService.applyResign(client)
    return { ok: true }
  }

  // ---------- P4.1 房间约战 ----------
  // 注：WsAdapter 对 @SubscribeMessage 返回值的应答是裸 JSON（无事件名信封），
  // 客户端事件总线无法按事件名分发，故结果统一用带信封的 room:created / room:joined 推送。

  @SubscribeMessage('room:create')
  async onRoomCreate(client: WebSocket, data: { token?: string; playerId?: string; name?: string }) {
    const user = await this.auth.verifyTokenOrNull(data?.token)
    const playerId = user?.id ?? String(data?.playerId ?? '').slice(0, 64)
    if (!playerId) return { ok: false, error: 'unauthorized' }
    const name = user?.nickname ?? (String(data?.name ?? '玩家').slice(0, 16) || '玩家')
    const res = this.roomService.createRoom(playerId, name, client)
    client.send(JSON.stringify({ event: 'room:created', data: res }))
    return { ok: true }
  }

  @SubscribeMessage('room:join')
  async onRoomJoin(
    client: WebSocket,
    data: { roomId?: string; token?: string; playerId?: string; name?: string },
  ) {
    const user = await this.auth.verifyTokenOrNull(data?.token)
    const playerId = user?.id ?? String(data?.playerId ?? '').slice(0, 64)
    if (!playerId) return { ok: false, error: 'unauthorized' }
    const name = user?.nickname ?? (String(data?.name ?? '玩家').slice(0, 16) || '玩家')
    // 统一大写并截断，容忍手输小写/首尾空格
    const roomId = String(data?.roomId ?? '').trim().toUpperCase().slice(0, 8)
    if (!roomId) {
      client.send(JSON.stringify({ event: 'room:joined', data: { ok: false, error: 'room_id_required' } }))
      return { ok: false, error: 'room_id_required' }
    }
    const res = await this.roomService.joinRoom(roomId, playerId, name, client)
    client.send(JSON.stringify({ event: 'room:joined', data: res }))
    return { ok: true }
  }

  /** 对局结束后玩家点"返回房间"：置位坐席返回标记并广播（未返回方大厅灰显） */
  @SubscribeMessage('room:returned')
  async onRoomReturned(
    client: WebSocket,
    data: { token?: string; playerId?: string },
  ) {
    const user = await this.auth.verifyTokenOrNull(data?.token)
    const playerId = user?.id ?? String(data?.playerId ?? '').slice(0, 64)
    if (!playerId) return { ok: false, error: 'unauthorized' }
    const res = this.roomService.markReturned(playerId)
    client.send(JSON.stringify({ event: 'room:returned', data: res }))
    return { ok: true }
  }

  /** 房主开始对局 */
  @SubscribeMessage('room:start')
  async onRoomStart(
    client: WebSocket,
    data: { roomId?: string; token?: string; playerId?: string },
  ) {
    const user = await this.auth.verifyTokenOrNull(data?.token)
    const playerId = user?.id ?? String(data?.playerId ?? '').slice(0, 64)
    if (!playerId) return { ok: false, error: 'unauthorized' }
    const roomId = String(data?.roomId ?? '').trim().toUpperCase().slice(0, 8)
    const res = await this.roomService.startGame(roomId, playerId)
    client.send(JSON.stringify({ event: 'room:started', data: res }))
    return { ok: true }
  }

  /** 房主转让所有权给蓝方坐席玩家 */
  @SubscribeMessage('room:host:transfer')
  async onRoomHostTransfer(
    client: WebSocket,
    data: { roomId?: string; token?: string; playerId?: string },
  ) {
    const user = await this.auth.verifyTokenOrNull(data?.token)
    const playerId = user?.id ?? String(data?.playerId ?? '').slice(0, 64)
    if (!playerId) return { ok: false, error: 'unauthorized' }
    const roomId = String(data?.roomId ?? '').trim().toUpperCase().slice(0, 8)
    const res = this.roomService.transferHost(roomId, playerId)
    client.send(JSON.stringify({ event: 'room:transferred', data: res }))
    return { ok: true }
  }

  /** 房主换边：红蓝坐席互换（选择先后手），仅等待阶段 */
  @SubscribeMessage('room:swap')
  async onRoomSwap(
    client: WebSocket,
    data: { roomId?: string; token?: string; playerId?: string },
  ) {
    const user = await this.auth.verifyTokenOrNull(data?.token)
    const playerId = user?.id ?? String(data?.playerId ?? '').slice(0, 64)
    if (!playerId) return { ok: false, error: 'unauthorized' }
    const roomId = String(data?.roomId ?? '').trim().toUpperCase().slice(0, 8)
    const res = this.roomService.swapSeats(roomId, playerId)
    client.send(JSON.stringify({ event: 'room:swapped', data: res }))
    return { ok: true }
  }

  /** 退出房间：优先按 socket 定位；携带 token/playerId 时可兜底（客户端重连后 socket 引用过期） */
  @SubscribeMessage('room:leave')
  async onRoomLeave(client: WebSocket, data: { token?: string; playerId?: string }) {
    const user = await this.auth.verifyTokenOrNull(data?.token)
    const playerId = user?.id ?? (data?.playerId ? String(data.playerId).slice(0, 64) : undefined)
    this.roomService.leaveRoom(client, playerId)
    return { ok: true }
  }
}
