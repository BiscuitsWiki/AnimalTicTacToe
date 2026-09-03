/**
 * 登录态管理（P3 正式登录）。
 * - H5：设备号游客登录（POST /auth/guest），token 持久化到本地存储
 * - 小程序：预留微信登录（wx.login → POST /auth/wechat），需服务端配置 WX_APPID/WX_SECRET
 * - 所有 REST/WS 调用通过 getToken() 携带登录态
 */
import Taro from '@tarojs/taro'
import { API_BASE } from '../config'

export { API_BASE } from '../config'

const DEVICE_KEY = 'attt_device_id'
const TOKEN_KEY = 'attt_token'

export interface AuthUser {
  id: string
  provider: string
  nickname: string
  token: string
}

let cachedUser: AuthUser | null = null
let pending: Promise<AuthUser | null> | null = null

/** 本机设备号（游客登录身份） */
export function getDeviceId(): string {
  let id = Taro.getStorageSync<string>(DEVICE_KEY)
  if (!id) {
    id = `dev_${Date.now().toString(36)}_${Math.random().toString(36).slice(2, 10)}`
    Taro.setStorageSync(DEVICE_KEY, id)
  }
  return id
}

/** 已登录用户（未登录/登录失败返回 null） */
export function getAuthUser(): AuthUser | null {
  return cachedUser
}

/** 当前用户 ID（未登录返回空串） */
export function getUserId(): string {
  return cachedUser?.id ?? ''
}

export function getToken(): string {
  return cachedUser?.token ?? Taro.getStorageSync<string>(TOKEN_KEY) ?? ''
}

/** 登录态请求头（未登录返回空对象） */
export function authHeader(): Record<string, string> {
  const token = getToken()
  return token ? { authorization: `Bearer ${token}` } : {}
}

/**
 * 确保已登录：
 * 1. 本地有 token → GET /auth/me 校验
 * 2. 校验失败/无 token → 设备号游客登录
 * 服务端不可达时返回 null（离线降级，调用方自行兜底）
 */
export function ensureLogin(): Promise<AuthUser | null> {
  if (cachedUser) return Promise.resolve(cachedUser)
  if (pending) return pending
  pending = (async () => {
    const saved = Taro.getStorageSync<string>(TOKEN_KEY)
    if (saved) {
      try {
        const res = await Taro.request({
          url: `${API_BASE}/auth/me`,
          header: { authorization: `Bearer ${saved}` },
        })
        if (res.statusCode === 200) {
          cachedUser = { ...(res.data as AuthUser), token: saved }
          return cachedUser
        }
      } catch { /* 服务不可达，走游客登录再试 */ }
    }
    // 游客登录（设备号）
    try {
      const res = await Taro.request({
        url: `${API_BASE}/auth/guest`,
        method: 'POST',
        data: { deviceId: getDeviceId() },
        header: { 'content-type': 'application/json' },
      })
      if (res.statusCode >= 400) return null
      cachedUser = res.data as AuthUser
      Taro.setStorageSync(TOKEN_KEY, cachedUser.token)
      return cachedUser
    } catch {
      return null
    }
  })().finally(() => { pending = null })
  return pending
}

/** 修改昵称 */
export async function updateNickname(nickname: string): Promise<AuthUser> {
  const res = await Taro.request({
    url: `${API_BASE}/auth/profile`,
    method: 'PATCH',
    data: { nickname },
    header: { 'content-type': 'application/json', ...authHeader() },
  })
  if (res.statusCode >= 400) {
    throw new Error((res.data as { message?: string })?.message ?? '修改失败')
  }
  cachedUser = { ...(res.data as AuthUser), token: getToken() }
  return cachedUser
}

/** 小程序微信登录（需服务端配置 WX_APPID / WX_SECRET） */
export async function wechatLogin(): Promise<AuthUser> {
  const { code } = await Taro.login()
  const res = await Taro.request({
    url: `${API_BASE}/auth/wechat`,
    method: 'POST',
    data: { code },
    header: { 'content-type': 'application/json' },
  })
  if (res.statusCode >= 400) {
    throw new Error((res.data as { message?: string })?.message ?? '微信登录失败')
  }
  cachedUser = res.data as AuthUser
  Taro.setStorageSync(TOKEN_KEY, cachedUser.token)
  return cachedUser
}
