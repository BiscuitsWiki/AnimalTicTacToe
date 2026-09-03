/**
 * WebSocket 封装（H5 用浏览器原生 WebSocket，小程序用 Taro.connectSocket）。
 * 消息协议与服务端 WsAdapter 一致：{ event: string, data: object }。
 */
import Taro from '@tarojs/taro'
import { WS_BASE } from '../config'

export { WS_BASE } from '../config'

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

  connect(onOpen?: () => void, onClose?: () => void): Promise<void> {
    return new Promise((resolve, reject) => {
      const messageHandler = (raw: string) => {
        try {
          const msg = JSON.parse(raw) as WsMessage
          this.handlers.get(msg.event)?.forEach(h => h(msg.data))
        } catch { /* 忽略非法消息 */ }
      }

      if (typeof WebSocket !== 'undefined') {
        // H5：浏览器原生 WebSocket
        const ws = new WebSocket(WS_BASE)
        this.ws = ws
        ws.onopen = () => { onOpen?.(); resolve() }
        ws.onclose = () => { if (!this.disposed) onClose?.() }
        ws.onerror = () => { if (!this.disposed) reject(new Error('WS 连接失败')) }
        ws.onmessage = ev => messageHandler(String(ev.data))
      } else {
        // 小程序：Taro.connectSocket
        const task = Taro.connectSocket({ url: WS_BASE })
        this.ws = task
        task.onOpen(() => { onOpen?.(); resolve() })
        task.onClose(() => { if (!this.disposed) onClose?.() })
        task.onError(() => { if (!this.disposed) reject(new Error('WS 连接失败')) })
        task.onMessage(res => messageHandler(String(res.data)))
      }
    })
  }

  on(event: string, handler: Handler): void {
    if (!this.handlers.has(event)) this.handlers.set(event, new Set())
    this.handlers.get(event)!.add(handler)
  }

  send(event: string, data: unknown): void {
    const payload = JSON.stringify({ event, data })
    const ws = this.ws as WebSocket | null
    if (ws && typeof ws.send === 'function') ws.send(payload)
    else (this.ws as Taro.SocketTask | null)?.send({ data: payload })
  }

  close(): void {
    this.disposed = true
    const ws = this.ws as WebSocket | null
    if (ws && typeof ws.close === 'function') ws.close()
    else (this.ws as Taro.SocketTask | null)?.close({})
    this.ws = null
    this.handlers.clear()
  }
}
