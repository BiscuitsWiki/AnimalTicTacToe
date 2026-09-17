/**
 * WS 应用层心跳（半开连接兜底）。
 *
 * 背景：手机切网/锁屏/休眠会造成"半开"TCP 连接——客户端和服务端都收不到 close，
 * 于是房间席位/对局宽限逻辑全都感知不到玩家其实已经掉线（幽灵房间的根因之一）。
 *
 * 方案：客户端每 15s 发一次 app:ping，服务端 touch 记录活跃时间并回 app:pong；
 * 网关定期扫描，超过 timeoutMs 未 ping 的连接判为死连接并主动 terminate，
 * 从而驱动既有的 handleDisconnect 清理链路（对局宽限/房间席位与所有权）。
 *
 * 纯逻辑（不依赖 ws 实例），便于单测。
 */

/** 判死阈值（毫秒）：三个心跳周期未见 ping 即断连 */
export const WS_HEARTBEAT_TIMEOUT_MS = Number(process.env.WS_HEARTBEAT_TIMEOUT_MS ?? 45_000)
/** 扫描间隔（毫秒） */
export const WS_HEARTBEAT_SWEEP_MS = Number(process.env.WS_HEARTBEAT_SWEEP_MS ?? 15_000)

export interface Heartbeat {
  /** 新连接接入 */
  track(socket: object, now?: number): void
  /** 收到心跳（app:ping）：刷新活跃时间 */
  touch(socket: object, now?: number): void
  /** 连接关闭：移出跟踪表 */
  untrack(socket: object): void
  /** 超过阈值未活跃的连接（不修改状态，由调用方 terminate） */
  stale(now?: number): object[]
  /** 跟踪中的连接数（观测/测试用） */
  readonly size: number
}

export function createHeartbeat(timeoutMs = WS_HEARTBEAT_TIMEOUT_MS): Heartbeat {
  const lastSeen = new Map<object, number>()
  return {
    track(socket, now = Date.now()) {
      lastSeen.set(socket, now)
    },
    touch(socket, now = Date.now()) {
      lastSeen.set(socket, now)
    },
    untrack(socket) {
      lastSeen.delete(socket)
    },
    stale(now = Date.now()) {
      const out: object[] = []
      for (const [socket, at] of lastSeen) {
        if (now - at > timeoutMs) out.push(socket)
      }
      return out
    },
    get size() {
      return lastSeen.size
    },
  }
}