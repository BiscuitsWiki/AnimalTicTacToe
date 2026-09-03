/**
 * 安全组件单测：固定窗口限流器 + 管理端恒时鉴权。
 */
import { describe, expect, it } from 'vitest'
import { UnauthorizedException } from '@nestjs/common'
import { assertAdmin } from './admin-auth.js'
import { rateLimit, resetRateBuckets } from './rate-limit.js'

function fakeConfig(adminToken?: string) {
  return { get: () => adminToken } as never
}

describe('rateLimit 固定窗口限流', () => {
  it('窗口内放行至 limit 次，超出拒绝', () => {
    resetRateBuckets()
    expect(rateLimit('k', 3, 60_000)).toBe(true)
    expect(rateLimit('k', 3, 60_000)).toBe(true)
    expect(rateLimit('k', 3, 60_000)).toBe(true)
    expect(rateLimit('k', 3, 60_000)).toBe(false)
    expect(rateLimit('k', 3, 60_000)).toBe(false)
  })

  it('不同 key 互不影响', () => {
    resetRateBuckets()
    expect(rateLimit('a', 1, 60_000)).toBe(true)
    expect(rateLimit('a', 1, 60_000)).toBe(false)
    expect(rateLimit('b', 1, 60_000)).toBe(true)
  })

  it('窗口过期后重置', async () => {
    resetRateBuckets()
    expect(rateLimit('w', 1, 20)).toBe(true)
    expect(rateLimit('w', 1, 20)).toBe(false)
    await new Promise(r => setTimeout(r, 30))
    expect(rateLimit('w', 1, 20)).toBe(true)
  })
})

describe('assertAdmin 恒时鉴权', () => {
  const TOKEN = 'strong-admin-token-0123456789'

  it('token 一致则放行', () => {
    expect(() => assertAdmin(fakeConfig(TOKEN), { 'x-admin-token': TOKEN })).not.toThrow()
  })

  it('token 不一致 / 缺失 → 401', () => {
    expect(() => assertAdmin(fakeConfig(TOKEN), { 'x-admin-token': 'wrong-token-0123456789' })).toThrow(UnauthorizedException)
    expect(() => assertAdmin(fakeConfig(TOKEN), {})).toThrow(UnauthorizedException)
  })

  it('未配置或弱 token（<16 字符）→ 401 拒绝启动鉴权', () => {
    expect(() => assertAdmin(fakeConfig(undefined), { 'x-admin-token': 'anything' })).toThrow(UnauthorizedException)
    expect(() => assertAdmin(fakeConfig('short'), { 'x-admin-token': 'short' })).toThrow(UnauthorizedException)
  })
})
