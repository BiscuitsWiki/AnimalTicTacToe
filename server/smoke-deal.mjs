/**
 * 回合发牌制 WS 冒烟：
 * 1. 双人匹配开局 → 初始红方 3 张、蓝 0 张、turnCount=1、phase=TURN_ACTION
 * 2. 红落子 → 蓝方自动发 4 张（dealt 事件）：蓝视角明文、红视角脱敏 '?'
 * 3. 蓝落子 → 红方自动发 5 张（第 3 回合）：红视角明文、蓝视角脱敏
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

const a = client('A')
const b = client('B')
await Promise.all([
  new Promise(r => a.ws.on('open', r)),
  new Promise(r => b.ws.on('open', r)),
])

const startedA = a.wait('match:started')
a.send('queue:join', { playerId: 'smoke-a', name: '甲' })
b.send('queue:join', { playerId: 'smoke-b', name: '乙' })
const sa = await startedA
await b.wait('match:started')

const isRed = sa.youAre === 'red'
const red = isRed ? a : b
const blue = isRed ? b : a
assert(red.name === (isRed ? 'A' : 'B'), `红方=${red.name}，蓝方=${blue.name}`)

// 初始视角
const redView0 = await red.wait('game:state')
const blueView0 = await blue.wait('game:state')
assert(redView0.state.turnCount === 1, '初始 turnCount=1')
assert(redView0.state.phase === 'TURN_ACTION', '开局即行动阶段（无抽牌阶段）')
assert(redView0.state.hands.red.length === 3, '红方开局自动发 3 张')
assert(redView0.state.hands.red.every(p => p.name !== '?'), '红方自己手牌明文')
assert(blueView0.state.hands.blue.length === 0, '蓝方开局 0 张')
assert(blueView0.state.hands.red.every(p => p.name === '?'), '蓝视角红方手牌隐藏')

// 红落子 → 蓝方回合开始：作废旧牌重发 4 张；红方剩余手牌保留
red.send('game:place', { handIdx: 0, cellIdx: 0 })
const redView1 = await red.wait('game:state')
const blueView1 = await blue.wait('game:state')
assert(redView1.state.turnCount === 2 && redView1.state.turnSide === 'blue', '换边后 turnCount=2 轮蓝方')
assert(blueView1.state.hands.blue.length === 4, '蓝方第 2 回合自动发 4 张')
assert(blueView1.state.hands.blue.every(p => p.name !== '?'), '蓝方自己发牌明文')
assert(redView1.state.hands.red.length === 2, '红方落子后剩余 2 张手牌保留（不立即作废）')
assert(redView1.state.lastPlaced.red === 0, 'lastPlaced 记录红方最近落子格')
assert(blueView1.state.lastPlaced.red === 0, '对手视角同步 lastPlaced')
const dealtRed = redView1.events.find(e => e.type === 'dealt')
assert(!!dealtRed && dealtRed.pieces.length === 4, '红视角收到蓝方 dealt 事件（4 张）')
assert(dealtRed.pieces.every(p => p.name === '?'), '红视角蓝方发牌内容脱敏为 ?')

// 蓝落子 → 红方回合开始（第 3 回合）：作废旧 2 张、重发 5 张
blue.send('game:place', { handIdx: 0, cellIdx: 3 })
const blueView2 = await blue.wait('game:state')
const redView2 = await red.wait('game:state')
assert(redView2.state.turnCount === 3 && redView2.state.turnSide === 'red', 'turnCount=3 轮红方')
assert(redView2.state.hands.red.length === 5, '红方第 3 回合开始作废旧牌后重发 5 张')
assert(redView2.state.lastPlaced.blue === 3, 'lastPlaced 记录蓝方最近落子格')
assert(blueView2.state.hands.blue.length === 3, '蓝方落子后剩余 3 张手牌保留')
const dealtBlue = blueView2.events.find(e => e.type === 'dealt')
assert(!!dealtBlue && dealtBlue.pieces.length === 5, '蓝视角收到红方 dealt 事件（5 张）')
assert(dealtBlue.pieces.every(p => p.name === '?'), '蓝视角红方发牌内容脱敏为 ?')

console.log('\nALL SMOKE TESTS PASSED')
a.ws.close()
b.ws.close()
await sleep(300)
process.exit(0)
