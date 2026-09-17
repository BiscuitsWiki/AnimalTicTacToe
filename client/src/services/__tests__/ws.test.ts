/**
 * WS 连接存活判据测试（半开连接：切网/锁屏时 onclose 不触发，需靠心跳超时判死）。
 */
import { describe, expect, it } from 'vitest'
import { HEARTBEAT_INTERVAL_MS, HEARTBEAT_TIMEOUT_MS, isConnectionStale } from '../ws-heartbeat'

describe('isConnectionStale（连接存活判据）', () => {
  it('阈值内收到过消息 → 视为存活', () => {
    expect(isConnectionStale(1000, 1000 + HEARTBEAT_TIMEOUT_MS)).toBe(false)
  })

  it('超过阈值未收到任何消息 → 判为死连接', () => {
    expect(isConnectionStale(1000, 1000 + HEARTBEAT_TIMEOUT_MS + 1)).toBe(true)
  })

  it('心跳间隔须明显小于判死阈值（否则正常连接也会被误判）', () => {
    expect(HEARTBEAT_INTERVAL_MS * 2).toBeLessThan(HEARTBEAT_TIMEOUT_MS)
  })
})