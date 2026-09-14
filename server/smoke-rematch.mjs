/**
 * 冒烟：pvp 终局后"再来一局"流程（服务端视角）。
 * 1. 双人匹配开局 → 红方认输 → 对局结束销毁
 * 2. 双方各自新建 socket 发 match:reconnect（模拟客户端 startPvpMatch(true) 的 probeResume）
 *    → 应返回 not_in_match（不残留旧对局）
 * 3. 双方重新 queue:join → 应再次撮合并开局（蓝方首回合不再等待发牌验证见 smoke-deal）
 */
import WebSocket from 'ws'

const BASE = 'ws://localhost:3000/ws'
const sleep = (ms) => new Promise(r => setTimeout(r, ms))
let tagSeq = 0

function makeClient(name) {
  const tag = `${Date.now() % 100000}-${++tagSeq}`
  const ws = new WebSocket(BASE)
  const inbox = []
  let waitFn = null
  ws.on('message', raw => {
    const msg = JSON.parse(String(raw))
    // 被 waiter 消费的消息不再入 inbox，避免后续 wait 取到旧消息
    if (waitFn && waitFn.event === msg.event) {
      const fn = waitFn
      waitFn = null
      fn.resolve(msg.data)
      return
    }
    inbox.push(msg)
  })
  const opened = new Promise((resolve, reject) => {
    ws.on('open', resolve)
    ws.on('error', reject)
  })
  const wait = (event, timeout = 5000) => {
    const idx = inbox.findIndex(m => m.event === event)
    if (idx >= 0) return Promise.resolve(inbox.splice(idx, 1)[0].data)
    return new Promise((resolve, reject) => {
      const t = setTimeout(() => {
        waitFn = null
        reject(new Error(`wait ${event} timeout`))
      }, timeout)
      waitFn = {
        event,
        resolve: d => { clearTimeout(t); resolve(d) },
      }
    })
  }
  return {
    ws, name, tag, opened, wait, inbox,
    send: (event, data) => ws.send(JSON.stringify({ event, data })),
  }
}

function assert(cond, msg) {
  if (!cond) { console.error(`FAIL: ${msg}`); process.exit(1) }
  console.log(`PASS: ${msg}`)
}

// ---------- 局1：匹配 → 认输 → 终局 ----------
const a = makeClient('甲')
const b = makeClient('乙')
await a.opened
await b.opened

a.send('queue:join', { playerId: `rm-a-${a.tag}`, name: '甲' })
b.send('queue:join', { playerId: `rm-b-${b.tag}`, name: '乙' })
const sa = await a.wait('match:started')
const sb = await b.wait('match:started')
assert(sa.youAre !== sb.youAre, '局1: 撮合成功且双方阵营互补')
const red = sa.youAre === 'red' ? a : b
const blue = sa.youAre === 'red' ? b : a
await red.wait('game:state')
await blue.wait('game:state')

// 红方认输结束对局
red.send('game:resign', {})
const endedRed = await red.wait('game:state')
assert(endedRed.state.result?.reason === 'resign', '局1: 认输结算 result.resign')
await blue.wait('game:state')
await red.wait('match:ended')
await blue.wait('match:ended')
a.ws.close()
b.ws.close()
await sleep(300)

// ---------- 再来一局：新 socket probeResume（match:reconnect）→ 应 not_in_match ----------
const a2 = makeClient('甲')
const b2 = makeClient('乙')
await a2.opened
await b2.opened
for (const c of [a2, b2]) {
  const probe = await new Promise(resolve => {
    let done = false
    const fin = d => { if (!done) { done = true; resolve(d) } }
    c.ws.once('message', raw => {
      const msg = JSON.parse(String(raw))
      if (msg.event === 'match:reconnected') fin({ ok: true })
      else fin(msg.data)
    })
    c.send('match:reconnect', { token: null, playerId: `rm-${c.name === '甲' ? 'a' : 'b'}-${c.tag}` })
    setTimeout(() => fin({ timeout: true }), 5000)
  })
  assert(probe?.ok === false, `再来一局: ${c.name} probeResume 返回 not_in_match（无残留对局）`)
}

// ---------- 重新 queue:join → 应再次撮合 ----------
a2.send('queue:join', { playerId: `rm-a-${a2.tag}`, name: '甲' })
await a2.wait('queue:waiting')
b2.send('queue:join', { playerId: `rm-b-${b2.tag}`, name: '乙' })
const sa2 = await a2.wait('match:started')
const sb2 = await b2.wait('match:started')
assert(sa2.youAre !== sb2.youAre, '再来一局: 双方重新进队列并撮合成功')
const v = await a2.wait('game:state')
assert(v.state.turnCount === 1 && v.state.turnSide === 'red', '再来一局: 新对局正常开局红方先行')
a2.ws.close()
b2.ws.close()
await sleep(300)

console.log('\nALL SMOKE TESTS PASSED')
process.exit(0)
