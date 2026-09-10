import { describe, expect, it, vi, afterEach } from 'vitest'
import { ContentSecurityService } from './content-security.service.js'

/** vi.mock 工厂会被提升，测试数据须在工厂内部定义 */
vi.mock('node:fs/promises', () => ({
  readFile: vi.fn().mockResolvedValue(
    Buffer.from(
      'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==',
      'base64',
    ),
  ),
}))

/** 与 mock 工厂返回值一致的 1x1 PNG */
const PNG_BYTES = Buffer.from(
  'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==',
  'base64',
)

function fakeConfig(vars: Record<string, string | undefined>) {
  return { get: (k: string) => vars[k] } as never
}

/** 拦截 fetch，返回腾讯云风格的 Response 包装 */
function stubFetch(resp: object) {
  const fetchMock = vi.fn().mockResolvedValue({ json: async () => resp })
  vi.stubGlobal('fetch', fetchMock)
  return fetchMock
}

describe('ContentSecurityService（腾讯云图片审核）', () => {
  afterEach(() => {
    vi.unstubAllGlobals()
    vi.clearAllMocks()
    vi.resetModules()
  })

  it('未配置密钥 → skip（人工兜底）', async () => {
    const svc = new ContentSecurityService(fakeConfig({}))
    const r = await svc.checkPieceImage('/uploads/abc123.png')
    expect(r).toEqual({ verdict: 'skip' })
  })

  it('非 /uploads/uuid 图片路径 → skip 不送检', async () => {
    const svc = new ContentSecurityService(
      fakeConfig({ TENCENT_SECRET_ID: 'id', TENCENT_SECRET_KEY: 'key' }),
    )
    const fetchMock = stubFetch({})
    expect(await svc.checkPieceImage('https://evil.com/x.png')).toEqual({ verdict: 'skip' })
    expect(await svc.checkPieceImage('/uploads/../etc/passwd')).toEqual({ verdict: 'skip' })
    expect(fetchMock).not.toHaveBeenCalled()
  })

  it('Block → 拒绝并携带违规标签', async () => {
    stubFetch({ Response: { Suggestion: 'Block', Label: 'Porn', SubLabel: 'PornInfo' } })
    const svc = new ContentSecurityService(
      fakeConfig({ TENCENT_SECRET_ID: 'id', TENCENT_SECRET_KEY: 'key' }),
    )
    const r = await svc.checkPieceImage('/uploads/0f1e2d3c-4b5a-6978-8796-a5b4c3d2e1f0.png')
    expect(r).toEqual({ verdict: 'block', label: 'Porn/PornInfo' })
  })

  it('Pass / Review → 放行进 pending', async () => {
    stubFetch({ Response: { Suggestion: 'Pass' } })
    const svc = new ContentSecurityService(
      fakeConfig({ TENCENT_SECRET_ID: 'id', TENCENT_SECRET_KEY: 'key' }),
    )
    expect(await svc.checkPieceImage('/uploads/0f1e2d3c-4b5a-6978-8796-a5b4c3d2e1f0.png')).toEqual({ verdict: 'pass' })
  })

  it('接口异常 → skip（fail-open）', async () => {
    vi.stubGlobal('fetch', vi.fn().mockRejectedValue(new Error('timeout')))
    const svc = new ContentSecurityService(
      fakeConfig({ TENCENT_SECRET_ID: 'id', TENCENT_SECRET_KEY: 'key' }),
    )
    const r = await svc.checkPieceImage('/uploads/0f1e2d3c-4b5a-6978-8796-a5b4c3d2e1f0.png')
    expect(r).toEqual({ verdict: 'skip' })
  })

  it('请求头含 TC3 签名与图片审核动作参数', async () => {
    const fetchMock = stubFetch({ Response: { Suggestion: 'Pass' } })
    const svc = new ContentSecurityService(
      fakeConfig({ TENCENT_SECRET_ID: 'AKIDtest', TENCENT_SECRET_KEY: 'key' }),
    )
    await svc.checkPieceImage('/uploads/0f1e2d3c-4b5a-6978-8796-a5b4c3d2e1f0.png')
    const [url, init] = fetchMock.mock.calls[0] as [string, RequestInit]
    expect(url).toBe('https://ims.tencentcloudapi.com/')
    expect(init.headers).toMatchObject({
      Host: 'ims.tencentcloudapi.com',
      'X-TC-Action': 'ImageModeration',
      'X-TC-Version': '2020-12-29',
    })
    const auth = (init.headers as Record<string, string>).Authorization
    expect(auth).toMatch(/^TC3-HMAC-SHA256 Credential=AKIDtest\/\d{4}-\d{2}-\d{2}\/ims\/tc3_request, /)
    // 送检体为 base64 图片内容
    expect(JSON.parse(String(init.body)).FileContent).toBe(PNG_BYTES.toString('base64'))
  })
})
