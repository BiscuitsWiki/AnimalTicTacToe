/**
 * 登录鉴权服务（P3 正式登录）。
 * - guest：H5 设备号登录（openId = 客户端持久化的设备号）
 * - wechat：小程序 wx.login code 换 openid（需配置 WX_APPID / WX_SECRET）
 * - token：随机 48 位 hex 下发给客户端，库内只存 SHA-256 哈希（旧明文行在首次校验时懒迁移）
 */
import { BadRequestException, Injectable, UnauthorizedException } from '@nestjs/common'
import { ConfigService } from '@nestjs/config'
import { PrismaService } from '../prisma.service.js'
import { createHash, randomBytes } from 'node:crypto'

/** token 的 SHA-256 hex（库内存储形态） */
function hashToken(token: string): string {
  return createHash('sha256').update(token).digest('hex')
}

/** 签发新 token：返回 { raw（下发客户端）, hash（入库） } */
function issueToken(): { raw: string; hash: string } {
  const raw = randomBytes(24).toString('hex')
  return { raw, hash: hashToken(raw) }
}

export interface AuthUser {
  id: string
  provider: string
  nickname: string
}

const NICKNAME_ADJECTIVES = ['机灵的', '勇敢的', '神秘的', '欢快的', '沉稳的', '悠闲的']
const NICKNAME_ANIMALS = ['小狐狸', '小柴犬', '橘猫', '兔兔', '小熊', '水獭', '鹦鹉', '刺猬']

function randomNickname(): string {
  const a = NICKNAME_ADJECTIVES[Math.floor(Math.random() * NICKNAME_ADJECTIVES.length)]
  const b = NICKNAME_ANIMALS[Math.floor(Math.random() * NICKNAME_ANIMALS.length)]
  return a + b
}

@Injectable()
export class AuthService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly config: ConfigService,
  ) {}

  /** 设备号游客登录：已注册则复用账号并轮换 token，否则建档 */
  async guestLogin(deviceId: string, nickname?: string) {
    if (!deviceId || deviceId.length < 8 || deviceId.length > 64) {
      throw new BadRequestException('设备号格式非法')
    }
    const { raw, hash } = issueToken()
    const existing = await this.prisma.user.findUnique({
      where: { provider_openId: { provider: 'guest', openId: deviceId } },
    })
    if (existing) {
      // 复用账号：轮换 token（走到重登录说明旧 token 已丢失/失效）+ 顺带更新昵称
      const updated = await this.prisma.user.update({
        where: { id: existing.id },
        data: { token: hash, ...(nickname && nickname !== existing.nickname ? { nickname } : {}) },
      })
      return { ...updated, token: raw }
    }
    // 新建档：库内存哈希，raw 只在下发响应中出现一次
    const created = await this.prisma.user.create({
      data: {
        provider: 'guest',
        openId: deviceId,
        nickname: nickname || randomNickname(),
        token: hash,
      },
    })
    return { ...created, token: raw }
  }

  /** 小程序 wx.login：code 换 openid 并登录/建档 */
  async wechatLogin(code: string) {
    const appid = this.config.get<string>('WX_APPID')
    const secret = this.config.get<string>('WX_SECRET')
    if (!appid || !secret) {
      throw new BadRequestException('未配置 WX_APPID / WX_SECRET，无法微信登录')
    }
    if (!code) throw new BadRequestException('缺少 code')

    const url =
      `https://api.weixin.qq.com/sns/jscode2session?appid=${appid}` +
      `&secret=${secret}&js_code=${encodeURIComponent(code)}&grant_type=authorization_code`
    const res = await fetch(url)
    const data = (await res.json()) as { openid?: string; errcode?: number; errmsg?: string }
    if (!data.openid) {
      throw new UnauthorizedException(`微信登录失败: ${data.errcode} ${data.errmsg}`)
    }

    const existing = await this.prisma.user.findUnique({
      where: { provider_openId: { provider: 'wechat', openId: data.openid } },
    })
    const { raw, hash } = issueToken()
    if (existing) {
      // 复用账号并轮换 token（raw 下发客户端，库内只存哈希）
      const updated = await this.prisma.user.update({
        where: { id: existing.id },
        data: { token: hash },
      })
      return { ...updated, token: raw }
    }
    const created = await this.prisma.user.create({
      data: {
        provider: 'wechat',
        openId: data.openid,
        nickname: randomNickname(),
        token: hash,
      },
    })
    return { ...created, token: raw }
  }

  /** 校验 token，返回用户（无效抛 401） */
  async verifyToken(token: string | undefined): Promise<AuthUser> {
    const user = await this.verifyTokenOrNull(token)
    if (!user) throw new UnauthorizedException('登录态无效')
    return user
  }

  /** 校验 token，返回用户或 null（WS 等软校验场景）；旧明文行首次命中时懒迁移为哈希 */
  async verifyTokenOrNull(token: string | undefined): Promise<AuthUser | null> {
    if (!token) return null
    const hashed = hashToken(token)
    let user = await this.prisma.user.findUnique({ where: { token: hashed } })
    if (!user) {
      // 旧明文 token 兼容：命中即升级为哈希存储（客户端持有的 raw 不变）
      const legacy = await this.prisma.user.findUnique({ where: { token } })
      if (legacy) {
        user = await this.prisma.user.update({
          where: { id: legacy.id },
          data: { token: hashed },
        })
      }
    }
    return user ? { id: user.id, provider: user.provider, nickname: user.nickname } : null
  }

  /** 修改昵称 */
  async updateNickname(token: string | undefined, nickname: string) {
    const user = await this.verifyToken(token)
    const name = (nickname ?? '').trim()
    if (name.length < 1 || name.length > 12) {
      throw new BadRequestException('昵称需 1~12 个字符')
    }
    const updated = await this.prisma.user.update({
      where: { id: user.id },
      data: { nickname: name },
    })
    return updated
  }
}
