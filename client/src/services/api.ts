/**
 * HTTP 请求封装（Taro.request 薄包装）。
 * 开发期后端跑在本机 NestJS（默认 3000 端口）。
 * 小程序真机调试时需改为局域网 IP（localhost 指向手机自身）。
 */
import Taro from '@tarojs/taro'
import { API_BASE, authHeader } from './auth'

export { API_BASE } from './auth'

export interface ApiPiece {
  /** 皮肤 id（skinId，审核/下架/举报粒度） */
  id: string
  /** 所属卡牌 id（同名即同一张卡，卡牌持有名称与属性） */
  cardId?: string
  name: string
  element: string
  /** 副属性（可选） */
  element2?: string | null
  imageUrl: string
}

/** 卡牌信息（工坊提交时的"同名卡"提示：同名即同一张卡，属性以卡牌为准） */
export interface ApiCardLookup {
  cardId: string
  name: string
  element: string
  element2?: string | null
  source: string
  approvedSkinCount: number
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

/** 上传图片（multipart），返回 { url }；H5 端自动压缩，避免手机原图超出 2MB 限制 */
export async function uploadImage(filePath: string): Promise<{ url: string }> {
  if (process.env.TARO_ENV === 'h5') {
    return uploadImageH5(filePath)
  }
  const res = await Taro.uploadFile({
    url: `${API_BASE}/pieces/image`,
    filePath,
    name: 'file',
    header: authHeader(),
  })
  if (res.statusCode === 413) throw new Error('图片过大（上限 2MB）')
  if (res.statusCode >= 400) {
    throw new Error(`图片上传失败（${res.statusCode}）`)
  }
  return JSON.parse(res.data) as { url: string }
}

/** H5：超过 1MB 才触发压缩；最长边压到该像素上限 */
const UPLOAD_TRIGGER_BYTES = 1024 * 1024
const UPLOAD_MAX_EDGE = 1024

/** H5 端：压缩后用 fetch + FormData 直传（同源无 CORS 问题，dev 跨端口已开 CORS） */
async function uploadImageH5(src: string): Promise<{ url: string }> {
  let blob: Blob
  try {
    blob = await (await fetch(src)).blob()
  } catch {
    throw new Error('无法读取所选图片，请重试')
  }
  if (blob.size > UPLOAD_TRIGGER_BYTES) {
    const compressed = await compressH5(src, UPLOAD_MAX_EDGE)
    if (compressed && compressed.size < blob.size) blob = compressed
  }
  if (blob.size > 2 * 1024 * 1024) throw new Error('图片过大（上限 2MB），请更换较小的图片')
  const ext = blob.type.includes('webp') ? 'webp' : blob.type.includes('png') ? 'png' : 'jpg'
  const fd = new FormData()
  fd.append('file', blob, `piece.${ext}`)
  let res: Response
  try {
    res = await fetch(`${API_BASE}/pieces/image`, {
      method: 'POST',
      headers: authHeader(),
      body: fd,
    })
  } catch {
    throw new Error('无法连接服务器，请检查网络')
  }
  if (res.status === 413) throw new Error('图片过大（上限 2MB），请更换较小的图片')
  if (!res.ok) {
    const msg = (await res.json().catch(() => null) as { message?: string } | null)?.message
    throw new Error(msg ?? `图片上传失败（${res.status}）`)
  }
  return res.json() as Promise<{ url: string }>
}

/** H5 canvas 压缩：webp 优先（保留透明底），浏览器不支持 webp 时退白底 jpeg */
function compressH5(src: string, maxEdge: number): Promise<Blob | null> {
  return new Promise(resolve => {
    const img = new Image()
    img.onload = () => {
      try {
        const scale = Math.min(1, maxEdge / Math.max(img.width, img.height))
        const w = Math.max(1, Math.round(img.width * scale))
        const h = Math.max(1, Math.round(img.height * scale))
        const canvas = document.createElement('canvas')
        canvas.width = w
        canvas.height = h
        canvas.getContext('2d')!.drawImage(img, 0, 0, w, h)
        canvas.toBlob(b => {
          if (b && b.type === 'image/webp') return resolve(b)
          const c2 = document.createElement('canvas')
          c2.width = w
          c2.height = h
          const ctx = c2.getContext('2d')!
          ctx.fillStyle = '#fff'
          ctx.fillRect(0, 0, w, h)
          ctx.drawImage(img, 0, 0, w, h)
          c2.toBlob(jb => resolve(jb), 'image/jpeg', 0.85)
        }, 'image/webp', 0.85)
      } catch {
        resolve(null)
      }
    }
    img.onerror = () => resolve(null)
    img.src = src
  })
}

/** 公共池（审核通过的皮肤，含所属卡牌名称与属性） */
export function fetchApprovedPieces(): Promise<ApiPiece[]> {
  return getJSON<ApiPiece[]>('/pieces/approved?limit=100')
}

/** 按名称查卡牌（未占用时返回 null；用于提交时的同名卡提示与属性锁定） */
export function fetchCardByName(name: string): Promise<ApiCardLookup | null> {
  return getJSON<ApiCardLookup | null>(`/pieces/card?name=${encodeURIComponent(name)}`)
}

/** 单模式胜负平小计 */
export interface ModeStats {
  wins: number
  losses: number
  draws: number
  total: number
}

/** 个人战绩（P2.3：基于已落库的对局记录；真人对战与人机分开统计） */
export interface PlayerStats {
  playerId: string
  /** 真人对战（匹配 + 房间） */
  pvp: ModeStats
  /** 人机对战 */
  ai: ModeStats
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
  /** 对局模式：pvp=真人 ai=人机 */
  mode: string
  /** 结束时间（ISO 字符串） */
  endedAt: string
}

/** 最近对局列表（默认 20 条，上限 50；mode=pvp|ai 过滤，缺省全部） */
export function fetchHistory(
  playerId: string,
  limit = 20,
  mode?: 'pvp' | 'ai',
): Promise<{ items: HistoryItem[] }> {
  const q = mode ? `?limit=${limit}&mode=${mode}` : `?limit=${limit}`
  return getJSON<{ items: HistoryItem[] }>(
    `/game/history/${encodeURIComponent(playerId)}${q}`,
  )
}

/** 人机对局结果上报（本地结算 → 落库统计） */
export function reportAiResult(payload: {
  playerId: string
  playerName: string
  mySide: 'red' | 'blue'
  winnerSide: 'red' | 'blue' | 'draw'
  reason: string
}): Promise<{ ok: boolean; matchId: string }> {
  return postJSON('/game/ai-result', payload)
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

/** 撤回待审核棋子（仅作者本人，pending 状态） */
export async function withdrawPiece(pieceId: string): Promise<{ ok: boolean }> {
  return postJSON(`/pieces/${encodeURIComponent(pieceId)}/withdraw`, {})
}

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
