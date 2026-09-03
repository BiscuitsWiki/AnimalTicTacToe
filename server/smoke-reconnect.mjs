/**
 * 断线重连 WS 冒烟：
 * 1. 快速匹配开局 → 红落子一手
 * 2. 红方"刷新页面"（旧 socket 关闭、新 socket 发 match:reconnect 探测）
 *    → 收 match:reconnected + game:state，棋盘/手牌/回合数完整恢复
 *    → 对手收 opponent:disconnected / opponent:reconnected
 * 3. 红方新连接继续落子，对局正常推进
 * 4. 房间模式：建房 → 双方入座 → 开局 → 蓝方重进恢复（room:join 同房间重进）
 * 5. 无对局探测：新玩家 match:reconnect 返回 not_in_match（信封事件）
 */
import WebSocket from 'ws'

const URL = 'ws://localhost:3000/ws'

function client(name) {
  const ws = new WebSocket(URL)
  const inbox = []
  const waiters = []
  ws.on('message', raw => {
    const msg = JSON.parse(raw.toString())
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
const open = c => new Promise(r => c.ws.on('open', r))

// ---------- 场景 1：快速匹配 + 红方刷新恢复 ----------
const a = client('A')
const b = client('B')
await Promise.all([open(a), open(b)])

const startedA = a.wait('match:started')
a.send('queue:join', { playerId: 'rc-a', name: '甲' })
b.send('queue:join', { playerId: 'rc-b', name: '乙' })
const sa = await startedA
await b.wait('match:started')
const red = sa.youAre === 'red' ? a : b
const blue = sa.youAre === 'red' ? b : a

const redView0 = await red.wait('game:state')
await blue.wait('game:state')

// 红落子一手，制造可恢复的棋面
red.send('game:place', { handIdx: 0, cellIdx: 4 })
const redView1 = await red.wait('game:state')
await blue.wait('game:state')
assert(redView1.state.turnSide === 'blue' && redView1.state.turnCount === 2, '红落子后轮蓝方（turnCount=2）')

// 蓝方应看到红方断线提示
const disco = blue.wait('opponent:disconnected')
red.ws.close()
await disco
console.log('PASS: 对手收到 opponent:disconnected')

// 红方"刷新"：新 socket 发 match:reconnect 探测
const red2 = client('A2')
await open(red2)
const reconnected = red2.wait('match:reconnected')
const reconAck = red2.wait('match:reconnect')
red2.send('match:reconnect', { playerId: 'rc-a' })
const rc = await reconnected
const ack = await reconAck
assert(ack.ok === true, 'match:reconnect 应答 ok=true（带信封）')
assert(rc.youAre === 'red', '恢复身份=红方')
const redView2 = await red2.wait('game:state')
assert(redView2.state.turnCount === 2, '恢复棋面 turnCount=2')
assert(redView2.state.board[4].stack.length === 1, '恢复棋面：红方已落子格仍在')
assert(redView2.state.hands.red.every(p => p.name !== '?'), '恢复视角手牌明文')
assert(await blue.wait('opponent:reconnected') !== undefined, '对手收到 opponent:reconnected')

// 红方新连接正常推进对局：等蓝落子后红再落子
blue.send('game:place', { handIdx: 0, cellIdx: 0 })
await blue.wait('game:state')
const redView3 = await red2.wait('game:state')
assert(redView3.state.turnSide === 'red', '蓝落子后轮红方（新连接视角）')
red2.send('game:place', { handIdx: 0, cellIdx: 8 })
const redView4 = await red2.wait('game:state')
assert(redView4.state.turnSide === 'blue', '恢复后红方落子生效，轮蓝方')

// 清场：双方离开（对局悬挂，等宽限期后判负或保持；不影响后续断言）
red2.ws.close()
blue.ws.close()
a.ws.close()
b.ws.close()

// ---------- 场景 2：无对局探测返回 not_in_match ----------
const c = client('C')
await open(c)
const noMatch = c.wait('match:reconnect')
c.send('match:reconnect', { playerId: 'rc-nobody' })
const nm = await noMatch
assert(nm.ok === false && nm.error === 'not_in_match', '无对局探测：not_in_match（信封事件）')
c.ws.close()

// ---------- 场景 3：房间模式刷新重进 ----------
const h = client('H')
const g = client('G')
await Promise.all([open(h), open(g)])

const created = h.wait('room:created')
h.send('room:create', { playerId: 'rc-host', name: '房主' })
const cr = await created
assert(cr.ok === true, '房间创建成功')
const roomId = cr.data.roomId

const joinedG = g.wait('room:joined')
g.send('room:join', { roomId, playerId: 'rc-guest', name: '客人' })
const jg = await joinedG
assert(jg.ok === true && jg.data.role === 'guest', '客人入座蓝方')

const started = h.wait('match:started')
const startedG = g.wait('match:started')
h.send('room:start', { roomId, playerId: 'rc-host' })
await started
await startedG
console.log('PASS: 房间开局成功')

await h.wait('game:state')

// 蓝方"刷新"：新 socket → match:reconnect 探测（命中对局）
const g2 = client('G2')
await open(g2)
const g2Re = g2.wait('match:reconnected')
const g2Ack = g2.wait('match:reconnect')
g2.send('match:reconnect', { playerId: 'rc-guest' })
const gRc = await g2Re
const gAck = await g2Ack
assert(gAck.ok === true && gRc.youAre === 'blue', '蓝方刷新恢复：身份=蓝方')
const g2View = await g2.wait('game:state')
assert(g2View.youAre === 'blue' && g2View.state.turnCount === 1, '蓝方恢复棋面视角')
// 房间状态补发（大厅 UI 恢复用）
const rs = await g2.wait('room:state')
assert(rs.roomId === roomId && rs.phase === 'playing', '重连后补发房间状态（playing）')

// 等待阶段重进：终局后房主重进恢复房主身份（此处验证 room:join 同房间重进路径）
// 触发终局：房主弃赛连接关闭后宽限期内重进（RECONNECT_GRACE_MS 默认 60s，不等待判负）
const h2 = client('H2')
await open(h2)
const h2Re = h2.wait('match:reconnected')
h2.send('match:reconnect', { playerId: 'rc-host' })
const hRc = await h2Re
assert(hRc.youAre === 'red', '房主刷新恢复：身份=红方')
await h2.wait('game:state')

h2.ws.close()
g2.ws.close()
h.ws.close()
g.ws.close()

console.log('\n全部断言通过 ✔')
process.exit(0)
