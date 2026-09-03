/**
 * 登录 API：
 * POST /auth/guest    { deviceId, nickname? }  H5 设备号登录
 * POST /auth/wechat   { code }                 小程序 wx.login
 * GET  /auth/me                                查询当前登录态
 * PATCH /auth/profile { nickname }             改昵称
 */
import { Body, Controller, Get, Headers, HttpException, HttpStatus, Ip, Patch, Post } from '@nestjs/common'
import { AuthService } from './auth.service.js'
import { rateLimit } from '../common/rate-limit.js'

/** 登录接口限流：每 IP 每分钟 10 次 */
const LOGIN_RATE_LIMIT = 10
const RATE_WINDOW_MS = 60_000

function throttleLogin(kind: string, ip: string): void {
  if (!rateLimit(`auth:${kind}:${ip}`, LOGIN_RATE_LIMIT, RATE_WINDOW_MS)) {
    throw new HttpException('请求过于频繁，请稍后再试', HttpStatus.TOO_MANY_REQUESTS)
  }
}

@Controller('auth')
export class AuthController {
  constructor(private readonly auth: AuthService) {}

  @Post('guest')
  guest(@Ip() ip: string, @Body() body: { deviceId: string; nickname?: string }) {
    throttleLogin('guest', ip)
    return this.auth.guestLogin(body?.deviceId, body?.nickname)
  }

  @Post('wechat')
  wechat(@Ip() ip: string, @Body() body: { code: string }) {
    throttleLogin('wechat', ip)
    return this.auth.wechatLogin(body?.code)
  }

  @Get('me')
  me(@Headers() headers: Record<string, string>) {
    return this.auth.verifyToken(bearer(headers))
  }

  @Patch('profile')
  profile(@Headers() headers: Record<string, string>, @Body() body: { nickname: string }) {
    return this.auth.updateNickname(bearer(headers), body?.nickname)
  }
}

function bearer(headers: Record<string, string>): string | undefined {
  const h = headers['authorization']
  return h?.startsWith('Bearer ') ? h.slice(7) : undefined
}
