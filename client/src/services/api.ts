/**
 * HTTP 请求封装（Taro.request 薄包装）。
 * 开发期后端跑在本机 NestJS（默认 3000 端口）。
 * 小程序真机调试时需改为局域网 IP（localhost 指向手机自身）。
 */
import Taro from '@tarojs/taro'
import { API_BASE, authHeader } from './auth'

export { API_BASE } from './auth'

export interface ApiPiece {
  id: string
  name: string
  element: string
  imageUrl: string
}

export async function getJSON<T>(path: string): Promise<T> {
  const res = await Taro.request({
    url: `${API_BASE}${path}`,
    method: 'GET',
    header: authHeader(),
  })
  if (res.statusCode >= 400) throw new Error(`GET ${path} -> ${res.statusCode}`)
  return res.data as T
}

export async function postJSON<T>(path: string, data: unknown): Promise<T> {
  const res = await Taro.request({
    url: `${API_BASE}${path}`,
    method: 'POST',
    data,
    header: { 'content-type': 'application/json', ...authHeader() },
  })
  if (res.statusCode >= 400) {
    const msg = (res.data as { message?: string })?.message
    throw new Error(msg ?? `POST ${path} -> ${res.statusCode}`)
  }
  return res.data as T
}

/** 上传图片（multipart），返回 { url } */
export async function uploadImage(filePath: string): Promise<{ url: string }> {
  const res = await Taro.uploadFile({
    url: `${API_BASE}/pieces/image`,
    filePath,
    name: 'file',
    header: authHeader(),
  })
  if (res.statusCode >= 400) {
    throw new Error(`图片上传失败 -> ${res.statusCode}`)
  }
  return JSON.parse(res.data) as { url: string }
}

/** 公共池（审核通过的棋子） */
export function fetchApprovedPieces(): Promise<ApiPiece[]> {
  return getJSON<ApiPiece[]>('/pieces/approved?limit=100')
}

/** 个人战绩（P2.3：基于已落库的对局记录） */
export interface PlayerStats {
  playerId: string
  wins: number
  losses: number
  draws: number
  total: number
}

export function fetchStats(playerId: string): Promise<PlayerStats> {
  return getJSON<PlayerStats>(`/game/stats/${encodeURIComponent(playerId)}`)
}

/** 历史对局条目（P6 数据落库） */
export interface HistoryItem {
  matchId: string
  /** 我的阵营 */
  mySide: 'red' | 'blue'
  /** 对手昵称 */
  opponentName: string
  /** 我方结果 */
  result: 'win' | 'lose' | 'draw'
  /** 结束原因：line=三连 board_full=平 opponent_disconnect=对手超时未归 */
  reason: string
  /** 结束时间（ISO 字符串） */
  endedAt: string
}

/** 最近对局列表（默认 20 条，上限 50） */
export function fetchHistory(playerId: string, limit = 20): Promise<{ items: HistoryItem[] }> {
  return getJSON<{ items: HistoryItem[] }>(
    `/game/history/${encodeURIComponent(playerId)}?limit=${limit}`,
  )
}

/** 举报理由（与服务端白名单一致） */
export const REPORT_REASONS: { value: string; label: string }[] = [
  { value: 'porn', label: '色情低俗' },
  { value: 'violence', label: '暴力血腥' },
  { value: 'politics', label: '政治敏感' },
  { value: 'infringement', label: '侵权盗用' },
  { value: 'ad', label: '广告骚扰' },
  { value: 'other', label: '其他' },
]

/** 对局内举报棋子（P3：登录态下举报者自动归属当前用户） */
export async function reportPiece(pieceId: string, reason: string, matchId?: string): Promise<{
  ok: boolean
  duplicated: boolean
  reportCount: number
  takedown: boolean
}> {
  return postJSON(`/pieces/${encodeURIComponent(pieceId)}/report`, {
    matchId,
    reason,
  })
}
