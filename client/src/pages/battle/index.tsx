import { useEffect, useMemo, useRef, useState } from 'react'
import { Button, View, Text } from '@tarojs/components'
import Taro, { useShareAppMessage, useUnload } from '@tarojs/taro'
import {
  canPlace, cloneState, createMatch, legalCells, place, resign, sideNameZh, skip, topSide,
} from '../../core/engine'
import { ELEMENT_COLORS, ELEMENT_NAMES_ZH } from '../../core/elements'
import { aiChoosePlacement } from '../../core/ai'
import { STACK_LIMIT } from '../../core/types'
import type { MatchState, PlaceEvent, Side } from '../../core/types'
import { buildDeckFromServer } from '../../services/deckSource'
import type { DeckSource } from '../../services/deckSource'
import { REPORT_REASONS, reportAiResult, reportPiece } from '../../services/api'
import { GameSocket } from '../../services/ws'
import { ensureLogin, getAuthUser, getToken, getUserId } from '../../services/auth'
import './index.scss'

type BattleMode = 'ai' | 'pvp' | 'room'

/** room 模式坐席角色 */
type RoomRole = 'host' | 'guest' | 'spectator'

/** 服务端房间状态视图 */
interface RoomStateView {
  roomId: string
  phase: 'waiting' | 'playing'
  hostName: string
  guestName: string | null
  /** 红/蓝坐席昵称（房主换边后随之互换） */
  redName: string
  blueName: string | null
  spectatorCount: number
}

interface PvpContext {
  socket: GameSocket
  youAre: Side
  opponentName: string
}

const sleep = (ms: number) => new Promise(r => setTimeout(r, ms))
const RECONNECT_MAX_TRIES = 8
const RECONNECT_WAIT_MS = 3000

function matchFrom(src: DeckSource): MatchState {
  return createMatch({ deck: src.deck })
}

function eventToText(e: PlaceEvent): string {
  const pos = (i: number) => `(${Math.floor(i / 3) + 1},${(i % 3) + 1})`
  switch (e.type) {
    case 'placed':
      return e.stacked
        ? `${sideNameZh(e.side)}用「${e.piece.name}」叠放占领了${pos(e.cellIdx)}！`
        : `${sideNameZh(e.side)}在${pos(e.cellIdx)}放下了「${e.piece.name}」`
    case 'dealt':
      return `${sideNameZh(e.side)}抽到 ${e.pieces.length} 张手牌`
    case 'pending_win':
      return `${sideNameZh(e.side)}三连！${sideNameZh(e.side === 'red' ? 'blue' : 'red')}有一回合的阻断机会`
    case 'blocked':
      return `${sideNameZh(e.bySide)}成功阻断了三连！`
    case 'win':
      return `${sideNameZh(e.winner)}获胜！`
    case 'draw':
      return '对局结束，平局'
    case 'resigned':
      return `${sideNameZh(e.side)}认输，${sideNameZh(e.side === 'red' ? 'blue' : 'red')}获胜！`
    case 'skipped':
      return `${sideNameZh(e.side)}跳过了本回合`
  }
}

export default function Battle () {
  const router = Taro.getCurrentInstance().router
  const mode: BattleMode = (router?.params?.mode as BattleMode) || 'ai'
  /** room 模式角色：host 建房等待 / join 通过房间码或链接加入 */
  const role: 'host' | 'join' = router?.params?.role === 'join' ? 'join' : 'host'
  /** join 时携带的房间码（链接或输入传入） */
  const joinRoomId = String(router?.params?.room ?? '').trim().toUpperCase()
  /** resume=1：主菜单探测到未完成对局后跳入，仅恢复不进匹配队列 */
  const resumeOnly = router?.params?.resume === '1'

  const [match, setMatch] = useState<MatchState | null>(null)
  const [selected, setSelected] = useState<number | null>(null)
  const [log, setLog] = useState<string[]>(['正在组建牌堆…'])
  const [waiting, setWaiting] = useState(mode !== 'ai')      // pvp：匹配中 / room：大厅（等待开局）
  const [mySide, setMySide] = useState<Side>('red')
  const [oppoName, setOppoName] = useState(mode === 'ai' ? '电脑' : '对手')
  const [connLost, setConnLost] = useState(false)
  /** pvp 终局标记：占位屏显示"再来一局/返回主菜单"，不自动重新匹配 */
  const [ended, setEnded] = useState(false)
  /** room 模式：房间状态（坐席/观战人数） */
  const [roomState, setRoomState] = useState<RoomStateView | null>(null)
  /** room 模式：本端坐席角色 */
  const [myRole, setMyRole] = useState<RoomRole | null>(null)
  /** myRole 的 ref 镜像（socket 回调里同步读取） */
  const myRoleRef = useRef<RoomRole | null>(null)
  /** room 模式：观战中标记（只读视图） */
  const [spectating, setSpectating] = useState(false)
  /** room 模式：观战者视角的双方昵称 */
  const [specNames, setSpecNames] = useState<{ red: string; blue: string }>({ red: '红方', blue: '蓝方' })
  /** room 模式：加入失败/房间解散等错误信息 */
  const [joinError, setJoinError] = useState('')
  /** room 模式：当前房间码（建房成功/入房成功后写入） */
  const [roomId, setRoomId] = useState('')
  const pvpRef = useRef<PvpContext | null>(null)
  /** 当前活跃 socket（等待阶段也持有，卸载时统一关闭） */
  const sockRef = useRef<GameSocket | null>(null)
  /** 对局已结束（含超时判负）标记：停止自动重连 */
  const endedRef = useRef(false)
  /** 人机终局上报标记：每局只报一次（"再来一局"时重置） */
  const aiReportedRef = useRef(false)
  /** 重连代际号：restart/unload 时递增使旧重试链失效 */
  const genRef = useRef(0)
  /** 举报面板：正在举报的棋子（棋盘/手牌上的顶层棋子） */
  const [reportTarget, setReportTarget] = useState<{ pieceId: string; name: string } | null>(null)
  /** 认输确认弹窗 */
  const [resignOpen, setResignOpen] = useState(false)

  const pushLog = (lines: string[]) => {
    setLog(prev => [...lines, ...prev].slice(0, 30))
  }

  /** 长按棋子弹出举报面板（占位棋子不可举报） */
  const onPieceLongPress = (piece: { id: string; name: string }) => {
    if (piece.id.startsWith('sys') || piece.id.startsWith('hidden-')) return
    Taro.vibrateShort?.({ type: 'light' }).catch(() => {})
    setReportTarget({ pieceId: piece.id, name: piece.name })
  }

  /** 提交举报 */
  const doReport = async (reason: string) => {
    const target = reportTarget
    setReportTarget(null)
    if (!target) return
    try {
      const res = await reportPiece(target.pieceId, reason)
      if (res.duplicated) pushLog([`「${target.name}」已举报过，无需重复举报`])
      else if (res.takedown) pushLog([`「${target.name}」已被举报下架，等待审核`])
      else pushLog([`「${target.name}」举报已提交`])
    } catch (e) {
      pushLog([`举报失败：${e instanceof Error ? e.message : '网络错误'}`])
    }
  }

  /** 对局过程事件绑定（初始连接与重连 socket 复用） */
  const bindGameEvents = (socket: GameSocket) => {
    socket.on('game:state', (d: { state: MatchState; events: PlaceEvent[] }) => {
      setMatch(d.state)
      if (d.state.result) endedRef.current = true
      if (d.events?.length) pushLog(d.events.map(eventToText))
    })
    socket.on('match:ended', (d: { reason?: string }) => {
      endedRef.current = true
      if (d?.reason === 'opponent_disconnect') {
        pushLog(['对手断线未归，你获胜！'])
      }
    })
    socket.on('opponent:disconnected', () => {
      pushLog(['对手连接中断，等待对方重连…'])
    })
    socket.on('opponent:reconnected', () => {
      pushLog(['对手已重新连接，对局继续'])
    })
  }

  /** pvp 断线自动重连：新建 socket 发 match:reconnect，失败则退避重试 */
  const attemptReconnect = async (gen: number, triesLeft = RECONNECT_MAX_TRIES) => {
    if (gen !== genRef.current || endedRef.current) return
    const socket = new GameSocket()
    try {
      await socket.connect()
    } catch {
      socket.close()
      if (triesLeft > 0) {
        await sleep(RECONNECT_WAIT_MS)
        return attemptReconnect(gen, triesLeft - 1)
      }
      setConnLost(true)
      pushLog(['重连失败，请检查网络后返回'])
      return
    }

    let settled = false
    socket.on('match:reconnected', (d: { youAre: Side; opponentName: string }) => {
      settled = true
      if (pvpRef.current) {
        pvpRef.current.socket = socket
        pvpRef.current.youAre = d.youAre
        pvpRef.current.opponentName = d.opponentName
      }
      setConnLost(false)
      pushLog(['已重新连接，对局继续'])
    })
    socket.on('match:reconnect', (d: { ok: boolean; error?: string }) => {
      if (d?.ok) return
      // 房间已销毁（宽限期超时被判负等）
      settled = true
      endedRef.current = true
      socket.close()
      setConnLost(true)
      pushLog(['重连失败：对局已结束（宽限期超时判负）'])
    })
    bindGameEvents(socket)
    socket.send('match:reconnect', { token: getToken(), playerId: getUserId() })

    await sleep(RECONNECT_WAIT_MS)
    if (settled) return
    if (gen !== genRef.current || endedRef.current) {
      socket.close()
      return
    }
    socket.close()
    if (triesLeft > 0) return attemptReconnect(gen, triesLeft - 1)
    setConnLost(true)
    pushLog(['重连失败，请检查网络后返回'])
  }

  /**
   * 开局前探测：恢复未完成对局或所在房间（页面刷新/重进场景）。
   * 命中对局 → 恢复视角返回 resumed；未命中 → 返回所在房间 id（若有）供房间重进。
   */
  const probeResume = (socket: GameSocket): Promise<{ resumed: boolean; inRoom?: string }> => {
    return new Promise(resolve => {
      let settled = false
      const finish = (r: { resumed: boolean; inRoom?: string }) => {
        if (settled) return
        settled = true
        resolve(r)
      }
      socket.on('match:reconnected', (d: { youAre: Side; opponentName: string }) => {
        pvpRef.current = { socket, youAre: d.youAre, opponentName: d.opponentName }
        setMySide(d.youAre)
        setOppoName(d.opponentName)
        setWaiting(false)
        setConnLost(false)
        setLog(['检测到进行中的对局，已恢复棋局'])
        finish({ resumed: true })
      })
      socket.on('match:reconnect', (d: { ok: boolean; inRoom?: string }) => {
        if (d?.ok) return   // 成功由 match:reconnected 事件处理
        finish({ resumed: false, inRoom: d?.inRoom })
      })
      socket.send('match:reconnect', { token: getToken(), playerId: getUserId() })
      setTimeout(() => finish({ resumed: false }), 8000)   // 无应答兜底
    })
  }

  /** AI 模式开局 */
  const startAiMatch = async () => {
    setSelected(null)
    setMatch(null)
    const src = await buildDeckFromServer()
    setMatch(matchFrom(src))
    setMySide('red')
    setLog(['对局开始，红方先行'])
    aiReportedRef.current = false   // 新一局：重置上报标记
  }

  /** 取消匹配：退出队列、断开连接、返回上级菜单 */
  const cancelMatch = () => {
    endedRef.current = true   // 标记已结束，阻断断线自动重连
    sockRef.current?.send('queue:leave', { playerId: getUserId() })
    sockRef.current?.close()
    sockRef.current = null
    Taro.navigateBack()
  }

  /** pvp 模式：登录 → 连接 WS 进入匹配；restart=true 为终局后"再来一局"主动重开 */
  const startPvpMatch = async (restart = false) => {
    endedRef.current = false
    // 先确保登录（游客登录失败也允许以游客身份匹配旧行为降级）
    const user = await ensureLogin()
    const socket = new GameSocket()
    try {
      await socket.connect(undefined, () => {
        // 对局中断线且未终局：自动重连
        if (pvpRef.current && !endedRef.current) attemptReconnect(++genRef.current)
      })
    } catch {
      setConnLost(true)
      setWaiting(false)
      setLog(['无法连接服务器，请确认后端已启动（server: pnpm run start:dev）'])
      return
    }
    sockRef.current = socket
    bindGameEvents(socket)

    // 刷新/重进恢复：命中未完成对局则直接续玩，跳过匹配
    const probe = await probeResume(socket)
    if (probe.resumed) return
    // 主菜单恢复入口跳入但未命中对局（刚好结束/超时判负）：不进匹配队列，直接返回
    // （终局后"再来一局"主动重开时不受此限制，正常进入匹配队列）
    if (resumeOnly && !restart) {
      endedRef.current = true
      sockRef.current = null
      socket.close()
      setWaiting(false)
      setLog(['未找到进行中的对局'])
      Taro.navigateBack()
      return
    }

    socket.on('queue:waiting', () => {
      setLog(['匹配中，等待其他玩家加入…'])
    })
    socket.on('match:started', (d: { youAre: Side; opponentName: string }) => {
      setWaiting(false)
      setMySide(d.youAre)
      setOppoName(d.opponentName)
      pvpRef.current = { socket, youAre: d.youAre, opponentName: d.opponentName }
      setLog([`匹配成功！你是${sideNameZh(d.youAre)}，对手：${d.opponentName}`])
    })
    // 登录态：token 优先；登录失败降级为游客身份匹配
    socket.send('queue:join', {
      token: getToken(),
      playerId: getUserId(),
      name: user?.nickname ?? '玩家',
    })
  }

  /** room 模式（P4.1 坐席制）：建房入座 / 输码或链接加入（入座或观战），房主点开始才开局 */
  const startRoomMatch = async () => {
    endedRef.current = false
    if (role === 'join' && !/^[2-9A-HJ-NP-Z]{6}$/.test(joinRoomId)) {
      setJoinError('链接无效：缺少房间码')
      setWaiting(false)
      return
    }
    const user = await ensureLogin()
    const socket = new GameSocket()
    try {
      await socket.connect(undefined, () => {
        if (pvpRef.current && !endedRef.current) attemptReconnect(++genRef.current)
      })
    } catch {
      setConnLost(true)
      setWaiting(false)
      setLog(['无法连接服务器，请确认后端已启动（server: pnpm run start:dev）'])
      return
    }
    sockRef.current = socket
    bindGameEvents(socket)

    // room:joined 统一处理（正常加入 / 刷新重进复用）
    const onRoomJoined = (d: { ok: boolean; data?: { role: RoomRole; room: RoomStateView }; error?: string }) => {
      if (d.ok && d.data) {
        setMyRole(d.data.role)
        setRoomState(d.data.room)
        setRoomId(d.data.room.roomId)
        if (d.data.role === 'host') {
          setLog(['已恢复房间（你是房主）'])
        } else if (d.data.role === 'guest') {
          setLog(['已入座，等待房主开始对局…'])
        } else {
          setLog(['已进入观战席，等待房主开始对局…'])
        }
      } else {
        const msg =
          d.error === 'room_not_found' ? '房间不存在，请核对房间码' :
          d.error === 'already_in_room' ? '你已在其他房间中' :
          d.error === 'in_match' ? '你还在另一场对局中，先结束再加入' :
          d.error === 'spectator_full' ? '观战席已满' :
          `加入失败（${d.error ?? '未知错误'}）`
        setJoinError(msg)
        setWaiting(false)
      }
    }

    // 刷新/重进恢复：命中对局直接续玩；命中房间则重进恢复席位/观战
    const probe = await probeResume(socket)
    if (probe.resumed) return
    if (probe.inRoom) {
      socket.on('room:joined', onRoomJoined)
      socket.send('room:join', {
        roomId: probe.inRoom,
        token: getToken(),
        playerId: getUserId(),
        name: user?.nickname ?? '玩家',
      })
      return
    }

    // 对局开局推送：坐席玩家（红/蓝）或观战者
    socket.on('match:started', (d: { youAre: Side | 'spectator'; opponentName?: string; redName?: string; blueName?: string }) => {
      if (d.youAre === 'spectator') {
        setSpectating(true)
        setMySide('red')   // 观战视角无阵营，仅作渲染兜底
        setSpecNames({ red: d.redName ?? '红方', blue: d.blueName ?? '蓝方' })
        setOppoName(`${d.redName ?? '红方'} vs ${d.blueName ?? '蓝方'}`)
        setLog(['观战中：双方手牌隐藏'])
      } else {
        setMySide(d.youAre)
        setOppoName(d.opponentName ?? '对手')
        pvpRef.current = { socket, youAre: d.youAre, opponentName: d.opponentName ?? '对手' }
        setLog([`对局开始！你是${sideNameZh(d.youAre)}，对手：${d.opponentName ?? '对手'}`])
      }
      setWaiting(false)
    })

    // 房间状态变化（坐席/观战人数/房主变更/回合到 waiting）
    socket.on('room:state', (d: RoomStateView) => {
      setRoomState(d)
      // 本端角色随房主变更自动调整（主动转让/退出自动转让后座位互换）
      const me = user?.nickname ?? '玩家'
      if (d.hostName === me) {
        if (myRoleRef.current !== 'host') setMyRole('host')
      } else if (d.guestName === me) {
        if (myRoleRef.current !== 'guest') setMyRole('guest')
      } else if (myRoleRef.current === 'host') {
        setMyRole('guest')
      }
    })

    // 转让房主失败提示（非房主操作/蓝方未入座等）
    socket.on('room:transferred', (d: { ok: boolean; error?: string }) => {
      if (d.ok) return
      Taro.showToast({ title: d.error === 'no_guest' ? '对方尚未入座' : '暂时无法转让', icon: 'none' })
    })

    // 换边失败提示（非房主操作/对局进行中等）
    socket.on('room:swapped', (d: { ok: boolean; error?: string }) => {
      if (d.ok) return
      Taro.showToast({ title: d.error === 'match_running' ? '对局中不可换边' : '暂时无法换边', icon: 'none' })
    })

    // 房间解散（房主退出无坐席/TTL）
    socket.on('room:closed', (d: { reason?: string }) => {
      if (pvpRef.current || spectating) return   // 对局中断线由宽限逻辑处理
      setJoinError(d?.reason === 'ttl_expired' ? '房间超时未活动，已自动解散' : '房间已解散')
      setWaiting(false)
    })

    // 开始对局失败（网络竞争等）
    socket.on('room:started', (d: { ok: boolean; error?: string }) => {
      if (d.ok) return
      Taro.showToast({ title: d.error === 'no_guest' ? '对方尚未入座' : '暂时无法开始', icon: 'none' })
    })

    if (role === 'host') {
      socket.on('room:created', (d: { ok: boolean; data?: { roomId: string }; error?: string }) => {
        if (d.ok && d.data?.roomId) {
          setMyRole('host')
          setRoomId(d.data.roomId)
          setLog([`房间已创建，房间码 ${d.data.roomId}，等待好友入座…`])
        } else {
          setJoinError(`创建房间失败（${d.error ?? '未知错误'}）`)
          setWaiting(false)
        }
      })
      socket.send('room:create', {
        token: getToken(),
        playerId: getUserId(),
        name: user?.nickname ?? '玩家',
      })
    } else {
      socket.on('room:joined', onRoomJoined)
      socket.send('room:join', {
        roomId: joinRoomId,
        token: getToken(),
        playerId: getUserId(),
        name: user?.nickname ?? '玩家',
      })
    }
  }

  useEffect(() => {
    if (mode === 'pvp') startPvpMatch()
    else if (mode === 'room') startRoomMatch()
    else startAiMatch()
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [])

  // P4.3 小程序分享卡片：room 模式携带房间码直达；其他模式分享游戏首页
  useShareAppMessage(() => {
    if (mode === 'room' && roomId) {
      return {
        title: `来下精灵井字棋！房间码 ${roomId}`,
        path: `/pages/battle/index?mode=room&role=join&room=${roomId}`,
      }
    }
    return { title: '精灵井字棋', path: '/pages/index/index' }
  })

  // myRole 变化同步到 ref（socket 回调读取最新值）
  useEffect(() => {
    myRoleRef.current = myRole
  }, [myRole])

  // 页面卸载：断开 WS 并终止重连（等待房间随断线自动解散）
  useUnload(() => {
    genRef.current++
    sockRef.current?.close()
    sockRef.current = null
    pvpRef.current?.socket.close()
  })

  const myTurn = !spectating && !!match && match.turnSide === mySide && match.phase !== 'FINISHED'

  /** 已选手牌的可落点（用于高亮） */
  const highlightCells = useMemo<number[]>(() => {
    if (!match || !myTurn || match.phase !== 'TURN_ACTION' || selected === null) return []
    const piece = match.hands[mySide][selected]
    if (!piece) return []
    return legalCells(match, mySide, piece)
  }, [match, selected, myTurn, mySide])

  /** AI 回合（仅 ai 模式）：回合发牌制下直接行动；无合法落子时自动跳过 */
  useEffect(() => {
    if (mode !== 'ai' || !match || match.phase === 'FINISHED' || match.turnSide !== 'blue') return
    const timer = setTimeout(() => {
      const ns = cloneState(match)
      const { handIdx, cellIdx } = aiChoosePlacement(ns)
      // 引擎不再自动判平局：AI 无处可落时主动跳过（连续双方跳过由引擎判平）
      const events = handIdx >= 0
        ? place(ns, 'blue', handIdx, cellIdx)
        : skip(ns, 'blue')
      setMatch(ns)
      setSelected(null)
      pushLog(events.map(eventToText))
    }, 700)
    return () => clearTimeout(timer)
  }, [match, mode])

  /**
   * 人机终局上报：本地结算结果落库（mode='ai'，与真人对战分开统计）。
   * 每局只报一次；未登录或服务不可达时静默放弃（离线人机可玩，战绩丢失可接受）。
   */
  useEffect(() => {
    if (mode !== 'ai' || !match?.result || aiReportedRef.current) return
    aiReportedRef.current = true
    const user = getAuthUser()
    if (!user) return
    reportAiResult({
      playerId: user.id,
      playerName: user.nickname,
      mySide,
      winnerSide: match.result.winner,
      reason: match.result.reason,
    }).catch(() => { /* 静默：上报失败不干扰对局体验 */ })
  }, [match, mode, mySide])

  const onSelectCard = (idx: number) => {
    if (!match || !myTurn || match.phase !== 'TURN_ACTION') return
    setSelected(prev => (prev === idx ? null : idx))
  }

  const onCellTap = (cellIdx: number) => {
    if (!match || !myTurn || match.phase !== 'TURN_ACTION' || selected === null) return
    if (!canPlace(match, mySide, selected, cellIdx)) return
    if (mode !== 'ai') {
      pvpRef.current?.socket.send('game:place', { handIdx: selected, cellIdx })
      setSelected(null)
      return
    }
    const ns = cloneState(match)
    const events = place(ns, mySide, selected, cellIdx)
    setMatch(ns)
    setSelected(null)
    pushLog(events.map(eventToText))
  }

  /**
   * 跳过回合：不出牌，正常换边抽牌。
   * 人机本地结算；联机/房间发 game:skip 由服务端权威裁决。
   */
  const handleSkip = () => {
    if (!match || !myTurn || match.phase !== 'TURN_ACTION') return
    if (mode !== 'ai') {
      pvpRef.current?.socket.send('game:skip', {})
      setSelected(null)
      return
    }
    const ns = cloneState(match)
    const events = skip(ns, mySide)
    setMatch(ns)
    setSelected(null)
    pushLog(events.map(eventToText))
  }

  /** 确认认输：本地（人机）直接结算；联机/房间发服务端裁决 */
  const confirmResign = () => {
    setResignOpen(false)
    if (!match || match.phase === 'FINISHED' || spectating) return
    if (mode === 'ai') {
      const ns = cloneState(match)
      const events = resign(ns, mySide)
      setMatch(ns)
      setSelected(null)
      pushLog(events.map(eventToText))
    } else {
      pvpRef.current?.socket.send('game:resign', {})
    }
  }

  const restart = () => {
    genRef.current++
    setConnLost(false)
    if (mode === 'room') {
      // 坐席制房间终局不解散：回房间大厅，房主可再次开局
      pvpRef.current = null
      setMatch(null)
      setSelected(null)
      setSpectating(false)
      setWaiting(true)
      setLog(['对局结束，已回到房间大厅'])
      return
    }
    pvpRef.current?.socket.close()
    pvpRef.current = null
    if (mode === 'pvp') {
      // 先回结束页（点"再来一局"才重新进队列），不自动开局
      setWaiting(true)
      setEnded(true)
      setMatch(null)
      setSelected(null)
      setLog(['对局结束'])
    } else {
      startAiMatch()
    }
  }

  /** 终局退出：断开连接返回主菜单 */
  const quitToMenu = () => {
    genRef.current++
    endedRef.current = true
    pvpRef.current?.socket.close()
    pvpRef.current = null
    sockRef.current?.close()
    sockRef.current = null
    Taro.navigateBack()
  }

  /** 房主取消等待返回 */
  const exitRoom = () => {
    genRef.current++
    sockRef.current?.send('room:leave', {})
    sockRef.current?.close()
    sockRef.current = null
    Taro.navigateBack()
  }

  /** 房主开始对局（蓝方坐席入座后可点） */
  const startRoomGame = () => {
    sockRef.current?.send('room:start', { roomId, token: getToken(), playerId: getUserId() })
  }

  /** 房主转让所有权给蓝方坐席玩家 */
  const transferRoomHost = () => {
    sockRef.current?.send('room:host:transfer', { roomId, token: getToken(), playerId: getUserId() })
  }

  /** 房主换边：红蓝坐席互换（选择先后手），仅等待阶段 */
  const swapRoomSeats = () => {
    sockRef.current?.send('room:swap', { roomId, token: getToken(), playerId: getUserId() })
  }

  /** H5 邀请链接（小程序端无 location，P4.3 换分享卡片） */
  const shareUrl = () => {
    if (typeof location === 'undefined' || !roomId) return ''
    return `${location.origin}${location.pathname}#/pages/battle/index?mode=room&role=join&room=${roomId}`
  }

  const copyText = (data: string, title: string) => {
    Taro.setClipboardData({ data })
      .then(() => Taro.showToast({ title, icon: 'none' }))
      .catch(() => {})
  }

  const statusText = () => {
    if (connLost && !match?.result) return '连接中断，正在重连…'
    if (connLost) return '连接已断开'
    if (waiting) return '匹配中…'
    if (!match) return '牌堆组建中…'
    if (spectating) {
      if (match.result) {
        if (match.result.winner === 'draw') return '平局'
        return `${match.result.winner === 'red' ? specNames.red : specNames.blue}获胜`
      }
      return `${match.turnSide === 'red' ? specNames.red : specNames.blue}行动中（观战）`
    }
    if (match.result) {
      if (match.result.winner === 'draw') return '平局'
      return match.result.winner === mySide ? '你赢了！' : '你输了'
    }
    if (match.turnSide !== mySide) return `${oppoName}思考中…`
    return selected === null ? '你的回合：选择手牌或跳过' : '请点击棋盘落子'
  }

  const pendingBanner = () => {
    if (!match?.pendingWin) return null
    if (spectating) {
      return (
        <View className='banner banner--win'>
          <Text>{sideNameZh(match.pendingWin.winnerSide)}三连！等待阻断…</Text>
        </View>
      )
    }
    const isMine = match.pendingWin.winnerSide === mySide
    return (
      <View className={`banner ${isMine ? 'banner--mine' : 'banner--foe'}`}>
        <Text>
          {isMine
            ? '你已达成三连！等待对手阻断…'
            : '对手三连！你必须在本回合内叠放打断'}
        </Text>
      </View>
    )
  }

  const connLostBanner = () => {
    if (!connLost || !match || match.result) return null
    return (
      <View className='banner banner--danger'>
        <Text>连接中断，正在尝试重新连接…</Text>
      </View>
    )
  }

  // 匹配中 / 房间等待 / 加载中：占位屏
  if (waiting || !match) {
    // 加入失败/建房失败：错误提示 + 返回
    if (joinError) {
      return (
        <View className='battle battle--loading'>
          <Text className='battle__loading-text'>{joinError}</Text>
          <View className='battle__back' onClick={() => Taro.navigateBack()}>
            <Text>返回</Text>
          </View>
        </View>
      )
    }

    // room 模式：房间大厅（坐席展示 + 房主开始/换边/转让 + 观战等待）
    if (mode === 'room') {
      const isHost = myRole === 'host'
      const guestSeated = !!roomState?.guestName
      /** 坐席卡按红/蓝坐席昵称渲染（房主换边后随 room:state 互换）；房主标签跟所有权 */
      const redSeated = !!roomState?.redName
      const blueSeated = !!roomState?.blueName
      return (
        <View className='battle battle--lobby'>
          <Text className='battle__lobby-title'>
            {roomId ? `房间 ${roomId}` : role === 'host' ? '正在创建房间…' : `正在加入房间 ${joinRoomId}…`}
          </Text>
          {roomId && (
            <>
              <View className='battle__seats'>
                <View className='battle__seat battle__seat--red'>
                  <Text className='battle__seat-side'>红方坐席（先手）</Text>
                  <Text className={`battle__seat-name ${redSeated ? '' : 'battle__seat-name--empty'}`}>
                    {roomState?.redName || '等待入座…'}
                  </Text>
                  {roomState?.hostName === roomState?.redName && redSeated && (
                    <Text className='battle__seat-tag'>房主</Text>
                  )}
                </View>
                <View className='battle__seat battle__seat--blue'>
                  <Text className='battle__seat-side'>蓝方坐席（后手）</Text>
                  <Text className={`battle__seat-name ${blueSeated ? '' : 'battle__seat-name--empty'}`}>
                    {roomState?.blueName || '等待入座…'}
                  </Text>
                  {roomState?.hostName === roomState?.blueName && blueSeated && (
                    <Text className='battle__seat-tag'>房主</Text>
                  )}
                </View>
              </View>
              <Text className='battle__room-hint'>
                观战席：{roomState?.spectatorCount ?? 0} 人
                {roomState?.phase === 'playing' ? ' · 对局进行中' : ''}
              </Text>
              {isHost ? (
                <View className='battle__room-actions'>
                  <View
                    className={`btn btn--draw ${guestSeated ? '' : 'btn--disabled'}`}
                    onClick={guestSeated ? startRoomGame : undefined}
                  >
                    <Text>开始对局</Text>
                  </View>
                  <View className='btn btn--skip' onClick={swapRoomSeats}>
                    <Text>换边</Text>
                  </View>
                  {guestSeated && (
                    <View className='btn btn--skip' onClick={transferRoomHost}>
                      <Text>转让房主</Text>
                    </View>
                  )}
                </View>
              ) : (
                <Text className='battle__loading-text'>
                  {myRole === 'guest' ? '已入座，等待房主开始对局…' : '观战席就绪，等待房主开始对局…'}
                </Text>
              )}
              {(isHost || myRole === 'guest') && roomId && (
                Taro.getEnv() === Taro.ENV_TYPE.WEAPP ? (
                  /* 小程序：转发卡片直达房间 + 复制房间码兜底 */
                  <View className='battle__room-actions'>
                    <Button className='btn btn--draw battle__share-btn' openType='share'>
                      <Text>邀请好友</Text>
                    </Button>
                    <View
                      className='btn btn--skip'
                      onClick={() => copyText(roomId, '房间码已复制')}
                    >
                      <Text>复制房间码</Text>
                    </View>
                  </View>
                ) : (
                  /* H5：复制邀请链接 */
                  shareUrl() && (
                    <View className='battle__room-actions'>
                      <View
                        className='btn btn--skip'
                        onClick={() => copyText(shareUrl(), '邀请链接已复制')}
                      >
                        <Text>复制邀请链接</Text>
                      </View>
                      <View
                        className='btn btn--skip'
                        onClick={() => copyText(roomId, '房间码已复制')}
                      >
                        <Text>复制房间码</Text>
                      </View>
                    </View>
                  )
                )
              )}
            </>
          )}
          <View className='battle__back' onClick={exitRoom}>
            <Text>退出房间</Text>
          </View>
        </View>
      )
    }

    return (
      <View className='battle battle--loading'>
        <Text className='battle__loading-text'>
          {connLost
            ? '服务器连接失败'
            : ended && mode === 'pvp'
              ? '对局结束'
              : mode === 'pvp'
                ? '匹配中，等待其他玩家…'
                : '牌堆组建中…'}
        </Text>
        {connLost ? (
          <View className='battle__back' onClick={() => Taro.navigateBack()}>
            <Text>返回</Text>
          </View>
        ) : ended && mode === 'pvp' ? (
          <View className='battle__room-actions'>
            <View
              className='btn btn--draw'
              onClick={() => { setEnded(false); startPvpMatch(true) }}
            >
              <Text>再来一局</Text>
            </View>
            <View className='btn btn--skip' onClick={quitToMenu}>
              <Text>返回主菜单</Text>
            </View>
          </View>
        ) : mode === 'pvp' ? (
          <View className='battle__back' onClick={cancelMatch}>
            <Text>取消匹配</Text>
          </View>
        ) : null}
      </View>
    )
  }

  const hand = match.hands[mySide]

  return (
    <View className='battle'>
      {/* 顶栏：对手信息 + 牌堆（观战者显示红蓝双方） */}
      <View className='battle__topbar'>
        {mode === 'ai' && (
          <View className='battle__exit' onClick={() => Taro.navigateBack()}>
            <Text>退出</Text>
          </View>
        )}
        <View className='battle__oppo'>
          <View className={`avatar ${spectating ? 'avatar--red' : mySide === 'red' ? 'avatar--blue' : 'avatar--red'}`}>
            <Text>{mode === 'ai' ? 'AI' : oppoName.slice(0, 1)}</Text>
          </View>
          <Text className='battle__oppo-name'>
            {spectating
              ? `观战 · ${specNames.red} vs ${specNames.blue}`
              : `${sideNameZh(mySide === 'red' ? 'blue' : 'red')} · ${oppoName}`}
          </Text>
        </View>
        <View className='battle__deck'>
          <Text className='battle__deck-count'>{match.deck.length}</Text>
          <Text className='battle__deck-label'>牌堆</Text>
        </View>
      </View>

      {pendingBanner()}
      {connLostBanner()}

      {/* 棋盘 */}
      <View className='board'>
        {match.board.map((cell, idx) => {
          const top = cell.stack[cell.stack.length - 1]
          const side = topSide(cell)
          const canDrop = highlightCells.includes(idx)
          const isLastRed = match.lastPlaced.red === idx
          const isLastBlue = match.lastPlaced.blue === idx
          return (
            <View
              key={idx}
              className={[
                'board__cell',
                side === 'red' ? 'board__cell--red' : '',
                side === 'blue' ? 'board__cell--blue' : '',
                canDrop ? 'board__cell--ok' : '',
                isLastRed ? 'board__cell--last-red' : '',
                isLastBlue ? 'board__cell--last-blue' : '',
              ].join(' ')}
              onClick={() => onCellTap(idx)}
              onLongPress={() => top && onPieceLongPress(top.piece)}
            >
              {isLastRed && <View className='board__last-tag board__last-tag--red'><Text>红最近</Text></View>}
              {isLastBlue && <View className='board__last-tag board__last-tag--blue'><Text>蓝最近</Text></View>}
              {top && (
                <View className='piece' style={`border-color: ${ELEMENT_COLORS[top.piece.element]}`}>
                  <Text
                    className='piece__element'
                    style={`background: ${ELEMENT_COLORS[top.piece.element]}`}
                  >
                    {ELEMENT_NAMES_ZH[top.piece.element]}
                  </Text>
                  <Text className='piece__name'>{top.piece.name}</Text>
                </View>
              )}
              {cell.stack.length > 1 && (
                <View
                  className={`board__stack-count ${cell.stack.length >= STACK_LIMIT ? 'board__stack-count--full' : ''}`}
                >
                  <Text>×{cell.stack.length}</Text>
                </View>
              )}
            </View>
          )
        })}
      </View>

      {/* 状态栏 + 跳过/认输入口 */}
      <View className='battle__status'>
        <Text className='battle__status-text'>{statusText()}</Text>
        {!match.result && !spectating && myTurn && (
          <View className='battle__skip' onClick={handleSkip}>
            <Text>跳过</Text>
          </View>
        )}
        {!match.result && !spectating && (
          <View className='battle__resign' onClick={() => setResignOpen(true)}>
            <Text>认输</Text>
          </View>
        )}
      </View>

      {/* 手牌（观战者只读：双方手牌隐藏） */}
      <View className='hand'>
        <View className='hand__title'>
          <Text>
            {spectating
              ? `观战中 · ${specNames.red}手牌 ${match.hands.red.length} 张 / ${specNames.blue}手牌 ${match.hands.blue.length} 张（内容隐藏）`
              : `你的手牌（${hand.length} 张）· 你是${sideNameZh(mySide)}`}
          </Text>
        </View>
        {!spectating && (
          <View className='hand__cards'>
            {hand.length === 0 && (
              <Text className='hand__empty'>手牌为空</Text>
            )}
            {hand.map((piece, idx) => (
              <View
                key={`${piece.id}-${idx}`}
                className={[
                  'card',
                  selected === idx ? 'card--selected' : '',
                  !myTurn || match.phase !== 'TURN_ACTION' ? 'card--disabled' : '',
                ].join(' ')}
                style={`border-color: ${ELEMENT_COLORS[piece.element]}`}
                onClick={() => onSelectCard(idx)}
              >
                <Text
                  className='card__element'
                  style={`background: ${ELEMENT_COLORS[piece.element]}`}
                >
                  {ELEMENT_NAMES_ZH[piece.element]}
                </Text>
                <Text className='card__name'>{piece.name}</Text>
              </View>
            ))}
          </View>
        )}
      </View>

      {/* 战报 */}
      <View className='log'>
        {log.slice(0, 4).map((line, i) => (
          <Text key={i} className={`log__line ${i === 0 ? 'log__line--latest' : ''}`}>{line}</Text>
        ))}
      </View>

      {/* 举报面板 */}
      {reportTarget && (
        <View className='mask' onClick={() => setReportTarget(null)}>
          <View className='mask__panel' onClick={e => e.stopPropagation()}>
            <Text className='mask__title'>举报「{reportTarget.name}」</Text>
            <Text className='mask__desc'>选择举报理由</Text>
            <View className='report__grid'>
              {REPORT_REASONS.map(r => (
                <View
                  key={r.value}
                  className='report__item'
                  onClick={() => doReport(r.value)}
                >
                  <Text>{r.label}</Text>
                </View>
              ))}
            </View>
            <View className='btn btn--skip' onClick={() => setReportTarget(null)}>
              <Text>取消</Text>
            </View>
          </View>
        </View>
      )}

      {/* 认输确认弹窗 */}
      {resignOpen && (
        <View className='mask' onClick={() => setResignOpen(false)}>
          <View className='mask__panel' onClick={e => e.stopPropagation()}>
            <Text className='mask__title'>认输</Text>
            <Text className='mask__desc'>确认认输？认输后将直接判负，对方获胜</Text>
            <View className='battle__room-actions'>
              <View className='btn btn--draw' onClick={confirmResign}>
                <Text>确认认输</Text>
              </View>
              <View className='btn btn--skip' onClick={() => setResignOpen(false)}>
                <Text>取消</Text>
              </View>
            </View>
          </View>
        </View>
      )}

      {/* 终局遮罩 */}
      {match.result && (
        <View className='mask' onClick={restart}>
          <View className='mask__panel'>
            <Text className='mask__title'>
              {match.result.winner === 'draw'
                ? '平局'
                : spectating
                  ? `${match.result.winner === 'red' ? specNames.red : specNames.blue} 获胜`
                  : match.result.winner === mySide ? '胜利！' : '惜败'}
            </Text>
            <Text className='mask__desc'>
              {match.result.reason === 'line'
                ? '三连达成'
                : match.result.reason === 'resign'
                  ? '认输'
                  : match.result.reason === 'both_skip'
                    ? '双方连续跳过'
                    : match.result.reason === 'opponent_disconnect'
                      ? '对手断线未归'
                      : '棋盘叠满且无三连'}
            </Text>
            <View className='btn btn--restart' onClick={restart}>
              <Text>
                {mode === 'ai' ? '再来一局' : mode === 'pvp' ? '继续' : '返回房间'}
              </Text>
            </View>
            {mode === 'ai' && (
              <View
                className='btn btn--restart battle__menu-btn'
                onClick={quitToMenu}
              >
                <Text>返回主菜单</Text>
              </View>
            )}
          </View>
        </View>
      )}
    </View>
  )
}
