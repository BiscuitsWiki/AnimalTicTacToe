/**
 * 工坊图片内容安全检测（腾讯云图片审核 ImageModeration，TC3 签名直调，零 SDK 依赖）。
 * - 提交棋子时同步送检（FileContent base64，本地/公网均可用，不依赖公网可访问 URL）
 * - 未配置密钥 / 接口异常 → skip（fail-open 放行进 pending，管理后台人工兜底）
 * - Block → 拒绝提交；Review/Pass → 正常 pending
 * 环境变量：TENCENT_SECRET_ID / TENCENT_SECRET_KEY（CAM 密钥，需开通"图片审核/内容安全"服务）
 */
import { Injectable, Logger } from '@nestjs/common'
import { ConfigService } from '@nestjs/config'
import { createHmac, createHash } from 'node:crypto'
import { readFile } from 'node:fs/promises'
import { join } from 'node:path'

const HOST = 'ims.tencentcloudapi.com'
const SERVICE = 'ims'
const ACTION = 'ImageModeration'
const VERSION = '2020-12-29'

/** 送检图片路径白名单：仅 uploads 目录下本服务生成的 uuid 文件名（防路径穿越送检任意文件） */
const UPLOAD_URL_RE = /^\/uploads\/([a-f0-9-]{8,64}\.(png|jpe?g|webp))$/i

export type SecVerdict =
  | { verdict: 'skip' }                                  // 未配置/异常：放行，人工兜底
  | { verdict: 'pass' }                                  // 通过
  | { verdict: 'review' }                                // 疑似（人工重点复核）
  | { verdict: 'block'; label: string }                  // 违规：拒绝提交

/** TC3-HMAC-SHA256 签名（腾讯云 API 通用鉴权），sha256hex 快捷函数 */
const sha256hex = (data: string | Buffer) => createHash('sha256').update(data).digest('hex')
const hmac = (key: string | Buffer, data: string) => createHmac('sha256', key).update(data).digest()

@Injectable()
export class ContentSecurityService {
  private readonly logger = new Logger(ContentSecurityService.name)

  constructor(private readonly config: ConfigService) {}

  /** 检测工坊棋子图片（imageUrl 须为 /uploads/<file> 形式） */
  async checkPieceImage(imageUrl: string): Promise<SecVerdict> {
    const secretId = this.config.get<string>('TENCENT_SECRET_ID')
    const secretKey = this.config.get<string>('TENCENT_SECRET_KEY')
    if (!secretId || !secretKey) return { verdict: 'skip' }   // 未配置：人工审核兜底

    const m = UPLOAD_URL_RE.exec(imageUrl)
    if (!m) return { verdict: 'skip' }                        // 非白名单路径：不送检（入库前另有校验）

    try {
      const content = await readFile(join(process.cwd(), 'uploads', m[1]))
      const res = await this.callImageModeration(secretId, secretKey, content.toString('base64'))
      const suggestion = res.Suggestion as string | undefined
      if (suggestion === 'Pass') return { verdict: 'pass' }
      if (suggestion === 'Review') return { verdict: 'review' }
      if (suggestion === 'Block') {
        return { verdict: 'block', label: [res.Label, res.SubLabel].filter(Boolean).join('/') || '违规内容' }
      }
      return { verdict: 'skip' }
    } catch (err) {
      // fail-open：接口超时/限频等异常放行进 pending，人工审核兜底
      this.logger.warn(`图片审核接口异常，已放行人工兜底: ${String(err instanceof Error ? err.message : err)}`)
      return { verdict: 'skip' }
    }
  }

  /** TC3 签名 + POST ImageModeration，返回 Response 对象（异常时抛错） */
  private async callImageModeration(secretId: string, secretKey: string, fileContentBase64: string) {
    const body = JSON.stringify({ FileContent: fileContentBase64 })
    const timestamp = Math.floor(Date.now() / 1000)
    const date = new Date(timestamp * 1000).toISOString().slice(0, 10)

    // 1. 拼接规范请求串
    const canonicalRequest = [
      'POST', '/',
      '',                                              // query string
      `content-type:application/json; charset=utf-8`,
      `host:${HOST}`,
      '',
      'content-type;host',
      sha256hex(body),
    ].join('\n')

    // 2. 拼接待签名字符串
    const credentialScope = `${date}/${SERVICE}/tc3_request`
    const stringToSign = [
      'TC3-HMAC-SHA256',
      String(timestamp),
      credentialScope,
      sha256hex(canonicalRequest),
    ].join('\n')

    // 3. 计算签名（派生密钥链）
    const kDate = hmac(('TC3' + secretKey) as string, date)
    const kService = hmac(kDate, SERVICE)
    const kSigning = hmac(kService, 'tc3_request')
    const signature = createHmac('sha256', kSigning).update(stringToSign).digest('hex')

    const authorization =
      `TC3-HMAC-SHA256 Credential=${secretId}/${credentialScope}, ` +
      `SignedHeaders=content-type;host, Signature=${signature}`

    // 4. 发起调用
    const r = await fetch(`https://${HOST}/`, {
      method: 'POST',
      headers: {
        Authorization: authorization,
        'Content-Type': 'application/json; charset=utf-8',
        Host: HOST,
        'X-TC-Action': ACTION,
        'X-TC-Version': VERSION,
        'X-TC-Timestamp': String(timestamp),
      },
      body,
      signal: AbortSignal.timeout(8000),
    })
    const data = (await r.json()) as {
      Response?: { Suggestion?: string; Label?: string; SubLabel?: string; Error?: { Code?: string; Message?: string } }
    }
    if (data.Response?.Error) {
      throw new Error(`tencent ims ${data.Response.Error.Code}: ${data.Response.Error.Message}`)
    }
    return data.Response ?? {}
  }
}
