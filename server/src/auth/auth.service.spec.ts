/**
 * AuthService token 哈希存储单测（fake Prisma）：
 * 新登录下发 raw / 库内存哈希、raw 可校验且库中无明文、
 * 重登录轮换 token、旧明文行懒迁移。
 */
import { describe, expect, it } from 'vitest'
import { createHash } from 'node:crypto'
import { AuthService } from './auth.service.js'

interface UserRow {
  id: string
  provider: string
  openId: string
  nickname: string
  token: string
}

function fakePrisma(rows: UserRow[]) {
  let seq = 0
  return {
    user: {
      findUnique: async ({ where }: { where: Record<string, unknown> }) => {
        if (where.provider_openId) {
          const { provider, openId } = where.provider_openId as { provider: string; openId: string }
          return rows.find(r => r.provider === provider && r.openId === openId) ?? null
        }
        if (where.token !== undefined) {
          return rows.find(r => r.token === where.token) ?? null
        }
        return null
      },
      create: async ({ data }: { data: Omit<UserRow, 'id'> }) => {
        const row: UserRow = { id: `u${++seq}`, ...data }
        rows.push(row)
        return row
      },
      update: async ({ where, data }: { where: { id: string }; data: Partial<UserRow> }) => {
        const row = rows.find(r => r.id === where.id)!
        Object.assign(row, data)
        return row
      },
    },
  }
}

const sha = (t: string) => createHash('sha256').update(t).digest('hex')

function makeService(rows: UserRow[]) {
  return new AuthService(fakePrisma(rows) as never, { get: () => undefined } as never)
}

describe('AuthService token 哈希存储', () => {
  it('新登录：下发 raw，库内只存哈希，raw 可校验', async () => {
    const rows: UserRow[] = []
    const svc = makeService(rows)
    const user = await svc.guestLogin('device-aaaa-0001', '小明')
    const raw = (user as UserRow & { token: string }).token
    expect(raw).toMatch(/^[0-9a-f]{48}$/)          // raw 48 位 hex
    expect(rows[0].token).toBe(sha(raw))           // 库内是哈希而非明文
    expect(rows[0].token).not.toBe(raw)
    const me = await svc.verifyTokenOrNull(raw)
    expect(me?.id).toBe(rows[0].id)                // raw 校验通过
  })

  it('重登录：复用账号并轮换 token，旧 token 失效', async () => {
    const rows: UserRow[] = []
    const svc = makeService(rows)
    const first = await svc.guestLogin('device-bbbb-0002')
    const raw1 = (first as UserRow).token
    const second = await svc.guestLogin('device-bbbb-0002')
    const raw2 = (second as UserRow).token
    expect(raw2).not.toBe(raw1)                    // 已轮换
    expect(rows).toHaveLength(1)                   // 同一账号
    expect(await svc.verifyTokenOrNull(raw1)).toBeNull()   // 旧 token 失效
    expect((await svc.verifyTokenOrNull(raw2))?.id).toBe(rows[0].id)
  })

  it('旧明文 token 懒迁移：首次校验命中明文行 → 升级为哈希，raw 不变', async () => {
    const legacyRaw = 'legacy-plaintext-token-value-0123456789abcdef'
    const rows: UserRow[] = [{
      id: 'u9', provider: 'guest', openId: 'device-cccc-0003', nickname: '老用户', token: legacyRaw,
    }]
    const svc = makeService(rows)
    const me = await svc.verifyTokenOrNull(legacyRaw)
    expect(me?.id).toBe('u9')
    expect(rows[0].token).toBe(sha(legacyRaw))     // 已升级为哈希
    // 再次校验（哈希路径）仍通过
    expect((await svc.verifyTokenOrNull(legacyRaw))?.id).toBe('u9')
  })

  it('无效 token 返回 null', async () => {
    const svc = makeService([])
    expect(await svc.verifyTokenOrNull(undefined)).toBeNull()
    expect(await svc.verifyTokenOrNull('no-such-token')).toBeNull()
  })
})
