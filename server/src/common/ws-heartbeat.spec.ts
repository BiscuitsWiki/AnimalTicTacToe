/**
 * WS 应用层心跳跟踪单测：半开连接（切网/锁屏无 close 事件）超时判死。
 */
import { describe, expect, it } from 'vitest'
import { createHeartbeat } from './ws-heartbeat.js'

describe('createHeartbeat（WS 应用层心跳）', () => {
  it('刚 track 的连接不算死连接', () => {
    const hb = createHeartbeat(45_000)
    const sock = {}
    hb.track(sock, 1000)
    expect(hb.stale(1000 + 45_000)).toEqual([])
    expect(hb.size).toBe(1)
  })

  it('超过阈值未 ping → 判为死连接；touch 后续命', () => {
    const hb = createHeartbeat(45_000)
    const sock = {}
    hb.track(sock, 1000)
    expect(hb.stale(1000 + 45_001)).toEqual([sock])

    hb.touch(sock, 1000 + 44_000)
    expect(hb.stale(1000 + 45_001)).toEqual([])
    expect(hb.stale(1000 + 44_000 + 45_001)).toEqual([sock])
  })

  it('untrack（连接已关闭）后不再出现在死连接列表', () => {
    const hb = createHeartbeat(45_000)
    const sock = {}
    hb.track(sock, 0)
    hb.untrack(sock)
    expect(hb.size).toBe(0)
    expect(hb.stale(10 ** 6)).toEqual([])
  })

  it('多连接各自独立计时', () => {
    const hb = createHeartbeat(1000)
    const a = { id: 'a' }
    const b = { id: 'b' }
    hb.track(a, 0)
    hb.track(b, 0)
    hb.touch(a, 900)          // a 仍在心跳
    expect(hb.stale(1200)).toEqual([b])
    expect(hb.size).toBe(2)   // stale 不修改状态，由调用方 untrack
  })
})