/**
 * 跳过与平局改版 WS 冒烟：
 * 局1：红跳过（换边抽牌 / lastSkipped 同步 / skipped 事件）→ 蓝跳过 → 双方连续跳过 both_skip 平局终局
 * 局2：红跳过 → 蓝落子（lastSkipped 重置、对局继续）→ 蓝非本回合跳过被忽略 → 红落子正常换边
 */
import WebSocket from 'ws'

const URL = 'ws://localhost:3000/ws'

function client(name) {
  const ws = new WebSocket(URL)
  const inbox = []
  const waiters = []
  ws.on('message', raw => {
    const msg = JSON.parse(raw.toString())
    // 被 waiter 消费的消息不再入 inbox，避免后续 wait 取到旧消息
    for (let i = waiters.length - 1; i >= 0; i--) {
      if (waiters[i].event === msg.event) {
        waiters.splice(i, 1)[0].resolve(msg.data)
        return
      }
    }
    inbox.push(msg)
  })
  const wait = (event, timeout = 5000) =>
    new Promise((resolve, reject) => {
      // 先查历史消息（可能早于 wait 注册到达）
      const idx = inbox.findIndex(m => m.event === event)
      if (idx >= 0) {
        resolve(inbox.splice(idx, 1)[0].data)
        return
      }
      const t = setTimeout(() => reject(new Error(`${name} timeout waiting ${event}`)), timeout)
      waiters.push({ event, resolve: d => { clearTimeout(t); resolve(d) } })
    })
  const send = (event, data) => ws.send(JSON.stringify({ event, data }))
  return { ws, name, wait, send, inbox }
}

const sleep = ms => new Promise(r => setTimeout(r, ms))
const assert = (cond, label) => {
  if (!cond) throw new Error(`FAIL: ${label}`)
  console.log(`PASS: ${label}`)
}

/** 建立一局双人匹配，返回 { a, b, red, blue } */
async function makeMatch(tag) {
  const a = client(`A${tag}`)
  const b = client(`B${tag}`)
  await Promise.all([
    new Promise(r => a.ws.on('open', r)),
    new Promise(r => b.ws.on('open', r)),
  ])
  const startedA = a.wait('match:started')
  a.send('queue:join', { playerId: `smoke-skip-${tag}-a`, name: '甲' })
  b.send('queue:join', { playerId: `smoke-skip-${tag}-b`, name: '乙' })
  const sa = await startedA
  await b.wait('match:started')
  const red = sa.youAre === 'red' ? a : b
  const blue = sa.youAre === 'red' ? b : a
  return { a, b, red, blue }
}

// ---------- 局1：双方连续跳过 → both_skip 平局 ----------
const m1 = await makeMatch('1')
await m1.red.wait('game:state')
await m1.blue.wait('game:state')

m1.red.send('game:skip', {})
const r1 = await m1.red.wait('game:state')
const b1 = await m1.blue.wait('game:state')
assert(r1.state.turnCount === 2 && r1.state.turnSide === 'blue', '局1: 红跳过后轮蓝方（turnCount=2）')
assert(r1.state.lastSkipped === 'red', '局1: lastSkipped=red 随状态同步')
assert(b1.state.lastSkipped === 'red', '局1: 对手视角 lastSkipped 同步')
assert(r1.state.hands.red.length === 3, '局1: 跳过不消耗红方手牌（仍 3 张）')
assert(b1.state.hands.blue.length === 3, '局1: 蓝方首回合正常发起始 3 张（摸牌正常）')
assert(r1.events.some(e => e.type === 'skipped' && e.side === 'red'), '局1: skipped 事件广播')
assert(r1.events.some(e => e.type === 'dealt' && e.pieces.length === 3), '局1: 蓝方发牌事件（3 张）')

m1.blue.send('game:skip', {})
const r2 = await m1.red.wait('game:state')
const b2 = await m1.blue.wait('game:state')
assert(r2.state.result?.winner === 'draw' && r2.state.result?.reason === 'both_skip', '局1: 双方连续跳过 → both_skip 平局')
assert(r2.state.phase === 'FINISHED', '局1: 终局 phase=FINISHED')
assert(b2.state.result?.reason === 'both_skip', '局1: 对手视角同步平局结果')
const ended1 = await m1.red.wait('match:ended')
assert(ended1.result?.reason === 'both_skip', '局1: match:ended 广播 both_skip')
await m1.blue.wait('match:ended')
m1.a.ws.close()
m1.b.ws.close()
await sleep(300)

// ---------- 局2：落子重置连续跳过 + 非本回合跳过被忽略 ----------
const m2 = await makeMatch('2')
await m2.red.wait('game:state')
await m2.blue.wait('game:state')

m2.red.send('game:skip', {})
await m2.red.wait('game:state')
await m2.blue.wait('game:state')      // 轮蓝方

m2.blue.send('game:place', { handIdx: 0, cellIdx: 0 })   // 蓝落子 → 重置跳过计数
const r3 = await m2.red.wait('game:state')
const b3 = await m2.blue.wait('game:state')   // 消费蓝方落子广播，避免残留旧状态干扰后续断言
assert(r3.state.turnCount === 3 && r3.state.turnSide === 'red', '局2: 蓝落子后轮红方（turnCount=3）')
assert(r3.state.lastSkipped === null, '局2: 落子重置 lastSkipped')
assert(r3.state.result === null, '局2: 未连续跳过 → 对局继续')

// 蓝方非本回合跳过：服务端静默忽略（无状态变化）
m2.blue.send('game:skip', {})
await sleep(300)
m2.red.send('game:place', { handIdx: 0, cellIdx: 1 })
const r4 = await m2.red.wait('game:state')
assert(r4.state.turnCount === 4 && r4.state.turnSide === 'blue', '局2: 非本回合跳过被忽略，红落子正常换边（turnCount=4）')
const b4 = await m2.blue.wait('game:state')
assert(b4.state.turnCount === 4, '局2: 蓝方视角同步')
m2.a.ws.close()
m2.b.ws.close()

console.log('\nALL SMOKE TESTS PASSED')
await sleep(300)
process.exit(0)
