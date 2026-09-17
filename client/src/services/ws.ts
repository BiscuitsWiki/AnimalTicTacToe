/**
 * WebSocket 封装（H5 用浏览器原生 WebSocket，小程序用 Taro.connectSocket）。
 * 消息协议与服务端 WsAdapter 一致：{ event: string, data: object }。
 *
 * 应用层心跳：连接建立后每 15s 发一次 app:ping（服务端回 app:pong）。
 * 手机切网/锁屏/休眠会造成"半开"连接——onclose 可能永不触发（客户端以为还连着，
 * 发送静默丢弃，用户看到"点了没反应"）。因此：超过 45s 未收到任何服务端消息即判为死连接，
 * 主动 close 驱动页面重连，并通过 onDead 回调解锁 UI 提示。
 */
import Taro from '@tarojs/taro'
import { WS_BASE } from '../config'
import { HEARTBEAT_INTERVAL_MS, isConnectionStale } from './ws-heartbeat'

export { WS_BASE } from '../config'
export { HEARTBEAT_INTERVAL_MS, HEARTBEAT_TIMEOUT_MS, isConnectionStale } from './ws-heartbeat'

export interface WsMessage {
  event: string
  data: any
}

type Handler = (data: any) => void

/** 简易事件总线（页面卸载时调用 dispose） */
export class GameSocket {
  private ws: WebSocket | Taro.SocketTask | null = null
  private handlers = new Map<string, Set<Handler>>()
  private disposed = false
  /** 连接已建立且未断开 */
  private opened = false
  /** 最近一次收到服务端消息的时间（心跳存活判据） */
  private lastMessageAt = 0
  private hbTimer: ReturnType<typeof setInterval> | null = null
  /** 死连接提示只报一次（避免发送守卫与心跳超时重复提示） */
  private deadNotified = false

  /** 连接被判死（半开连接/已断开）时回调：页面据此提示并触发重连 */
  onDead: (() => void) | null = null
  /** 心跳附带的身份数据（服务端据此刷新房间 TTL） */
  pingData: () => Record<string, unknown> = () => ({})

  connect(onOpen?: () => void, onClose?: () => void): Promise<void> {
    return new Promise((resolve, reject) => {
      const onEstablished = () => {
        this.opened = true
        this.lastMessageAt = Date.now()
        this.startHeartbeat()
        onOpen?.()
        resolve()
      }
      const onClosed = () => {
        this.stopHeartbeat()
        this.opened = false
        if (!this.disposed) onClose?.()
      }
      const messageHandler = (raw: string) => {
        this.lastMessageAt = Date.now()
        try {
          const msg = JSON.parse(raw) as WsMessage
          this.handlers.get(msg.event)?.forEach(h => h(msg.data))
        } catch { /* 忽略非法消息 */ }
      }

      if (typeof WebSocket !== 'undefined') {
        // H5：浏览器原生 WebSocket
        const ws = new WebSocket(WS_BASE)
        this.ws = ws
        ws.onopen = onEstablished
        ws.onclose = onClosed
        ws.onerror = () => {
          this.opened = false
          if (!this.disposed) reject(new Error('WS 连接失败'))
        }
        ws.onmessage = ev => messageHandler(String(ev.data))
      } else {
        // 小程序：Taro.connectSocket
        const task = Taro.connectSocket({ url: WS_BASE })
        this.ws = task
        task.onOpen(onEstablished)
        task.onClose(onClosed)
        task.onError(() => {
          this.opened = false
          if (!this.disposed) reject(new Error('WS 连接失败'))
        })
        task.onMessage(res => messageHandler(String(res.data)))
      }
    })
  }

  /** 连接是否可用（发送前守卫：避免把操作发进一个已死的连接） */
  isOpen(): boolean {
    return this.opened && !this.disposed
  }

  on(event: string, handler: Handler): void {
    if (!this.handlers.has(event)) this.handlers.set(event, new Set())
    this.handlers.get(event)!.add(handler)
  }

  /** 一次性监听（返回取消函数）：用于房间操作的应答超时校验 */
  once(event: string, handler: Handler): () => void {
    const wrapped: Handler = data => {
      this.off(event, wrapped)
      handler(data)
    }
    this.on(event, wrapped)
    return () => this.off(event, wrapped)
  }

  off(event: string, handler: Handler): void {
    this.handlers.get(event)?.delete(handler)
  }

  /**
   * 发送消息。连接不可用时不静默丢弃：标记死连接（触发 onDead + close → 页面重连）并返回 false。
   */
  send(event: string, data: unknown): boolean {
    if (!this.isOpen()) {
      this.declareDead()
      return false
    }
    this.rawSend(event, data)
    return true
  }

  /** 主动判死（页面在操作无应答等场景调用）：提示 + 断开（close 驱动重连） */
  markDead(): void {
    this.declareDead()
  }

  close(): void {
    this.disposed = true
    this.stopHeartbeat()
    this.opened = false
    this.rawClose()
    this.ws = null
    this.handlers.clear()
  }

  // ---------- 内部 ----------

  private startHeartbeat(): void {
    this.stopHeartbeat()
    this.hbTimer = setInterval(() => {
      if (!this.opened) return
      if (isConnectionStale(this.lastMessageAt, Date.now())) {
        this.declareDead()
        return
      }
      this.rawSend('app:ping', this.pingData())
    }, HEARTBEAT_INTERVAL_MS)
  }

  private stopHeartbeat(): void {
    if (this.hbTimer) {
      clearInterval(this.hbTimer)
      this.hbTimer = null
    }
  }

  /** 判死：提示一次 + 主动断开（onclose 是重连的唯一入口，避免重复重连链） */
  private declareDead(): void {
    if (this.disposed) return
    this.stopHeartbeat()
    const wasOpen = this.opened
    this.opened = false
    if (!this.deadNotified) {
      this.deadNotified = true
      this.onDead?.()
    }
    if (wasOpen) this.rawClose()
  }

  private rawSend(event: string, data: unknown): void {
    const payload = JSON.stringify({ event, data })
    const ws = this.ws as WebSocket | null
    try {
      if (ws && typeof ws.send === 'function') ws.send(payload)
      else (this.ws as Taro.SocketTask | null)?.send({ data: payload })
    } catch {
      // 发送失败按死连接处理（等待 onclose 兜底）
      this.declareDead()
    }
  }

  private rawClose(): void {
    const ws = this.ws as WebSocket | null
    try {
      if (ws && typeof ws.close === 'function') ws.close()
      else (this.ws as Taro.SocketTask | null)?.close({})
    } catch {
      // 已关闭：忽略
    }
  }
}