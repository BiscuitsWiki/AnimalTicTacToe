/**
 * 客户端心跳参数与存活判据（不依赖 Taro/浏览器环境，便于单测）。
 * 说明：手机切网/锁屏会造成"半开"连接——onclose 可能永不触发，
 * 因此需要靠"超过阈值未收到任何服务端消息"来判死（详见 services/ws.ts）。
 */

/** 心跳发送间隔（毫秒） */
export const HEARTBEAT_INTERVAL_MS = 15_000
/** 判死阈值（毫秒）：三个心跳周期未收到任何服务端消息 */
export const HEARTBEAT_TIMEOUT_MS = 45_000

/** 连接是否已被判死 */
export function isConnectionStale(
  lastMessageAt: number,
  now: number,
  timeoutMs = HEARTBEAT_TIMEOUT_MS,
): boolean {
  return now - lastMessageAt > timeoutMs
}