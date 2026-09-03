/**
 * 管理端鉴权（共享）：x-admin-token 与 ADMIN_TOKEN 恒时比较。
 * 要求 ADMIN_TOKEN 已配置且长度 ≥ 16，避免弱口令/未配置直接放行。
 */
import { UnauthorizedException } from '@nestjs/common'
import type { ConfigService } from '@nestjs/config'
import { timingSafeEqual } from 'node:crypto'

export function assertAdmin(config: ConfigService, headers: Record<string, string>): void {
  const expected = config.get<string>('ADMIN_TOKEN') ?? ''
  const got = headers['x-admin-token'] ?? ''
  if (expected.length < 16) {
    throw new UnauthorizedException('ADMIN_TOKEN 未配置或强度不足（需 ≥ 16 字符）')
  }
  const a = Buffer.from(got)
  const b = Buffer.from(expected)
  if (a.length !== b.length || !timingSafeEqual(a, b)) {
    throw new UnauthorizedException('管理员鉴权失败')
  }
}
