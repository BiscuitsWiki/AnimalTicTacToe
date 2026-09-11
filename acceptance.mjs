#!/usr/bin/env node
/**
 * 部署后自动化验收脚本（零依赖，Node >= 22，用全局 fetch / WebSocket）。
 *
 * 用法（在任意能访问目标地址的机器上）：
 *   node acceptance.mjs http://服务器IP            # 验收完整部署（80 入口，nginx 同源反代）
 *   node acceptance.mjs http://localhost:3000      # 直连后端模式：跳过静态托管与端口收敛检查
 *
 * 覆盖项：
 *   [Web]  H5 首页 / 静态资源缓存头 / 运营后台 /admin/
 *   [API]  游客登录 / 登录态 / 工坊列表 / 战绩统计 / 历史对局 / 上传路由 / uploads 静态服务
 *          / 安全响应头经反代透传（X-Content-Type-Options）
 *   [WS]   /ws 反代升级：快速匹配开局（双端 match:started + game:state）+ 房间创建
 *   [安全] 3000 端口不应对公网可达（compose 仅 expose，期望连接失败）
 *
 * 退出码：0 全部通过；1 存在失败项。
 */

const baseArg = process.argv[2] ?? 'http://localhost'
const base = new URL(baseArg.endsWith('/') ? baseArg.slice(0, -1) : baseArg)
/** origin 无尾斜杠，避免拼接出 //auth 双斜杠路径 */
const origin = base.origin
/** 直连后端（无 nginx 层）时跳过 Web 静态与端口收敛检查 */
const directBackend = base.port === '3000'
const wsBase = `${base.protocol === 'https:' ? 'wss' : 'ws'}://${base.host}/ws`

const results = []
let failed = 0

async function check(label, fn) {
  try {
    const detail = await fn()
    results.push({ label, ok: true, detail })
    console.log(`PASS: ${label}${detail ? `（${detail}）` : ''}`)
  } catch (err) {
    failed++
    results.push({ label, ok: false, detail: err.message })
    console.log(`FAIL: ${label}\n      ${err.message}`)
  }
}

function assert(cond, msg) {
  if (!cond) throw new Error(msg)
}

const sleep = ms => new Promise(r => setTimeout(r, ms))

// ---------- HTTP 小工具 ----------
async function http(method, path, { body, headers } = {}) {
  const res = await fetch(`${origin}${path}`, {
    method,
    headers: { ...(body ? { 'Content-Type': 'application/json' } : {}), ...headers },
    body: body ? JSON.stringify(body) : undefined,
  })
  const text = await res.text()
  let json = null
  try { json = JSON.parse(text) } catch { /* 非 JSON 响应 */ }
  return { status: res.status, headers: res.headers, text, json }
}

// ---------- WS 小工具（复用 smoke-reconnect 的收件箱模式）----------
function wsClient(name) {
  const ws = new WebSocket(wsBase)
  const inbox = []
  const waiters = []
  ws.addEventListener('message', ev => {
    const msg = JSON.parse(String(ev.data))
    for (let i = waiters.length - 1; i >= 0; i--) {
      if (waiters[i].event === msg.event) {
        waiters.splice(i, 1)[0].resolve(msg.data)
        return
      }
    }
    inbox.push(msg)
  })
  return {
    ws,
    open: () => new Promise((resolve, reject) => {
      const t = setTimeout(() => reject(new Error(`${name} WS 连接超时`)), 8000)
      ws.addEventListener('open', () => { clearTimeout(t); resolve() }, { once: true })
      ws.addEventListener('error', () => { clearTimeout(t); reject(new Error(`${name} WS 连接失败`)) }, { once: true })
    }),
    wait: (event, timeout = 8000) => new Promise((resolve, reject) => {
      const idx = inbox.findIndex(m => m.event === event)
      if (idx >= 0) { resolve(inbox.splice(idx, 1)[0].data); return }
      const t = setTimeout(() => reject(new Error(`${name} 等待 ${event} 超时`)), timeout)
      waiters.push({ event, resolve: d => { clearTimeout(t); resolve(d) } })
    }),
    send: (event, data) => ws.send(JSON.stringify({ event, data })),
    close: () => ws.close(),
  }
}

// ---------- 验收 ----------
const runId = Math.random().toString(36).slice(2, 10)
let token = ''

console.log(`目标：${base}  模式：${directBackend ? '直连后端（跳过 Web 静态检查）' : '完整部署'}\n`)

if (!directBackend) {
  await check('H5 首页可达', async () => {
    const r = await http('GET', '/')
    assert(r.status === 200, `期望 200，实际 ${r.status}`)
    assert((r.headers.get('content-type') ?? '').includes('text/html'), '响应非 HTML')
    assert(r.text.includes('id="app"') || r.text.includes('<div id'),'页面缺少挂载点')
    return '200 text/html'
  })

  await check('静态资源长缓存头', async () => {
    const page = await http('GET', '/')
    const m = page.text.match(/(?:src|href)="([^"]+\.[a-f0-9]{8,}\.(?:js|css))"/)
    assert(m, 'index.html 未找到带哈希的静态资源引用')
    const r = await http('GET', m[1])
    assert(r.status === 200, `资源 ${m[1]} 期望 200，实际 ${r.status}`)
    const cc = r.headers.get('cache-control') ?? ''
    assert(cc.includes('immutable'), `cache-control 缺少 immutable：${cc || '(空)'}`)
    return `${m[1].split('/').pop()} 命中长缓存`
  })

  await check('运营后台 /admin/ 可达', async () => {
    const r = await http('GET', '/admin/')
    assert(r.status === 200, `期望 200，实际 ${r.status}`)
    assert((r.headers.get('content-type') ?? '').includes('text/html'), '响应非 HTML')
    return '200'
  })
}

await check('游客登录签发 token', async () => {
  const r = await http('POST', '/auth/guest', {
    body: { deviceId: `acceptance-${runId}-device`, nickname: `验收-${runId}` },
  })
  assert(r.status === 201 || r.status === 200, `期望 200/201，实际 ${r.status}：${r.text.slice(0, 120)}`)
  assert(r.json?.token, '响应缺少 token 字段')
  assert(r.json?.id, '响应缺少用户 id')
  token = r.json.token
  return `user ${r.json.id}`
})

await check('登录态查询 /auth/me', async () => {
  const r = await http('GET', '/auth/me', { headers: { Authorization: `Bearer ${token}` } })
  assert(r.status === 200, `期望 200，实际 ${r.status}`)
  assert(r.json?.id, '响应缺少用户 id')
  return `user ${r.json.id}`
})

await check('工坊已上架列表 /pieces/approved', async () => {
  const r = await http('GET', '/pieces/approved')
  assert(r.status === 200, `期望 200，实际 ${r.status}：${r.text.slice(0, 120)}`)
  assert(Array.isArray(r.json), '响应应为数组')
  return `${r.json.length} 个棋子卡`
})

await check('战绩统计 /game/stats/:id（真人/人机分桶）', async () => {
  const r = await http('GET', `/game/stats/acceptance-${runId}`)
  assert(r.status === 200, `期望 200，实际 ${r.status}`)
  for (const bucket of ['pvp', 'ai']) {
    const b = r.json?.[bucket]
    assert(b != null && typeof b === 'object', `响应缺少 ${bucket} 桶`)
    for (const k of ['wins', 'losses', 'draws', 'total']) {
      assert(k in b, `${bucket} 桶缺少字段 ${k}`)
    }
  }
  return `pvp=${r.json.pvp.total} ai=${r.json.ai.total}`
})

await check('历史对局 /game/history/:id', async () => {
  const r = await http('GET', `/game/history/acceptance-${runId}`)
  assert(r.status === 200, `期望 200，实际 ${r.status}`)
  assert(Array.isArray(r.json?.items), '响应缺少 items 数组')
  return `${r.json.items.length} 条记录`
})

await check('上传路由经反代可达（空请求应 400 而非 404/502）', async () => {
  const r = await http('POST', '/pieces/image', { headers: { Authorization: `Bearer ${token}` } })
  assert(r.status === 400, `期望 400（未带文件的参数错误），实际 ${r.status}——若为 404/502/504 说明反代配置有问题`)
  return '400 参数错误（路由正常）'
})

await check('安全响应头经反代透传', async () => {
  const r = await http('GET', `/game/stats/acceptance-${runId}`)
  const nosniff = r.headers.get('x-content-type-options')
  assert(nosniff === 'nosniff', `X-Content-Type-Options 期望 nosniff，实际 ${nosniff ?? '(缺失)'}`)
  return 'X-Content-Type-Options: nosniff'
})

await check('uploads 静态服务（不存在文件应 404 而非 502）', async () => {
  const r = await http('GET', `/uploads/__not_exist_${runId}__.png`)
  assert(r.status === 404, `期望 404，实际 ${r.status}——若为 502/504 说明 /uploads 反代异常；若 200 说明命中了错误的静态目录`)
  return '404（代理健康）'
})

// ---------- WS：快速匹配开局 ----------
await check('WS 快速匹配开局（双端收 match:started + game:state）', async () => {
  const a = wsClient('A')
  const b = wsClient('B')
  await Promise.all([a.open(), b.open()])
  try {
    const startedA = a.wait('match:started')
    a.send('queue:join', { playerId: `ac-a-${runId}`, name: '验收甲' })
    b.send('queue:join', { playerId: `ac-b-${runId}`, name: '验收乙' })
    const sa = await startedA
    await b.wait('match:started')
    const st = sa.youAre === 'red' ? a : b
    const view = await st.wait('game:state')
    assert(view?.state?.turnCount === 1, `game:state 数据异常：${JSON.stringify(view).slice(0, 120)}`)
    // 让对局正常收尾（双方退出队列由断线超时兜底，无需等待）
    return `youAre=${sa.youAre}，首回合发牌 ${view.state?.hands?.red?.length ?? '?'} 张`
  } finally {
    a.close()
    b.close()
  }
})

// ---------- WS：房间创建 ----------
await check('WS 房间创建（room:created 房间码 6 位且不含易混淆字符）', async () => {
  const c = wsClient('C')
  await c.open()
  try {
    c.send('room:create', { token, playerId: `ac-c-${runId}`, name: '验收房主' })
    const res = await c.wait('room:created')
    assert(res?.ok !== false, `创建失败：${JSON.stringify(res).slice(0, 120)}`)
    const code = res?.data?.roomId ?? ''
    assert(/^[2-9A-HJ-NP-Z]{6}$/.test(code), `房间码 ${code} 不合法（应 6 位且不含 0/O/1/I）`)
    return `房间码 ${code}`
  } finally {
    c.close()
  }
})

// ---------- 端口收敛 ----------
if (!directBackend) {
  await check('3000 端口不对公网暴露（期望连接失败）', async () => {
    const probe = new URL(base)
    probe.port = '3000'
    try {
      const r = await fetch(probe, { signal: AbortSignal.timeout(5000) })
      // 能连上但返回非 2xx 也算暴露（能建立 TCP + HTTP 会话）
      throw new Error(`${probe} 可达（HTTP ${r.status}）——server 容器 3000 端口疑似映射到了宿主机，请检查 docker-compose.yml 的 ports`)
    } catch (err) {
      if (err.message.includes('可达')) throw err
      return '不可达（端口收敛正常）'
    }
  })
}

// ---------- 汇总 ----------
console.log(`\n────────────────────────────────`)
console.log(`合计 ${results.length} 项：通过 ${results.length - failed}，失败 ${failed}`)
if (failed > 0) {
  console.log('\n失败项：')
  for (const r of results.filter(x => !x.ok)) console.log(`  - ${r.label}：${r.detail}`)
  process.exit(1)
}
console.log('全部通过，部署验收成功。')
process.exit(0)
