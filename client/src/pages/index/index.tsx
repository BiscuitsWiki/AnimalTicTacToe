import { useEffect, useState } from 'react'
import { View, Text, Input } from '@tarojs/components'
import Taro, { useDidShow } from '@tarojs/taro'
import { fetchStats } from '../../services/api'
import type { PlayerStats } from '../../services/api'
import { ensureLogin, getToken, getUserId } from '../../services/auth'
import { GameSocket } from '../../services/ws'
import './index.scss'

/** 会话级标记：仅本次会话首次进入主菜单时探测未完成对局（避免主动退出后被拉回） */
let resumeProbed = false

export default function Index () {
  const [stats, setStats] = useState<PlayerStats | null>(null)
  const [nickname, setNickname] = useState('')
  /** 加入房间弹层：是否显示 / 输入的房间码 */
  const [joinOpen, setJoinOpen] = useState(false)
  const [roomCode, setRoomCode] = useState('')

  // 每次回到主菜单刷新战绩（对局结束返回后能看到最新数据）
  useDidShow(() => {
    refresh()
  })

  const refresh = async () => {
    const user = await ensureLogin()
    setNickname(user?.nickname ?? '')
    if (user) fetchStats(user.id).then(setStats).catch(() => {})
  }

  /**
   * 断线重连探测：断开后重新进入页面时，若有未完成的对局直接续玩；
   * 若人在房间（未开局）则回到房间。仅会话首次进入时执行一次。
   */
  const probeUnfinished = async () => {
    const user = await ensureLogin()
    if (!user) return
    const socket = new GameSocket()
    try {
      await socket.connect()
    } catch {
      return   // 服务不可达：静默跳过
    }
    let settled = false
    const finish = () => {
      if (settled) return
      settled = true
      socket.close()
    }
    socket.on('match:reconnected', () => {
      finish()
      Taro.navigateTo({ url: '/pages/battle/index?mode=pvp&resume=1' })
    })
    socket.on('match:reconnect', (d: { ok: boolean; inRoom?: string }) => {
      if (d?.ok) return   // 成功由 match:reconnected 处理
      finish()
      if (d?.inRoom) {
        Taro.navigateTo({ url: `/pages/battle/index?mode=room&role=join&room=${d.inRoom}` })
      }
    })
    socket.send('match:reconnect', { token: getToken(), playerId: getUserId() })
    setTimeout(finish, 8000)   // 无应答兜底
  }

  useEffect(() => {
    refresh()
    if (!resumeProbed) {
      resumeProbed = true
      probeUnfinished()
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [])

  const startBattle = (mode: 'ai' | 'pvp') => {
    Taro.navigateTo({ url: `/pages/battle/index?mode=${mode}` })
  }

  const goWorkshop = () => {
    Taro.navigateTo({ url: '/pages/workshop/index' })
  }

  /** 战绩页：胜负平统计 + 最近对局列表 */
  const goHistory = () => {
    Taro.navigateTo({ url: '/pages/history/index' })
  }

  /** 创建房间：进入 battle 页 room 模式（房主） */
  const createRoom = () => {
    Taro.navigateTo({ url: '/pages/battle/index?mode=room&role=host' })
  }

  /** 提交房间码加入房间 */
  const confirmJoinRoom = () => {
    const code = roomCode.trim().toUpperCase()
    if (!/^[2-9A-HJ-NP-Z]{6}$/.test(code)) {
      Taro.showToast({ title: '请输入 6 位房间码', icon: 'none' })
      return
    }
    setJoinOpen(false)
    setRoomCode('')
    Taro.navigateTo({ url: `/pages/battle/index?mode=room&role=join&room=${code}` })
  }

  return (
    <View className='menu'>
      <View className='menu__title'>
        <Text className='menu__title-main'>动物井字棋</Text>
        <Text className='menu__title-sub'>属性克制 · 叠放占领 · 待胜阻断</Text>
      </View>

      <View className='menu__actions'>
        <View className='menu__btn menu__btn--primary' onClick={() => startBattle('pvp')}>
          <Text>匹配对战</Text>
        </View>
        <View className='menu__btn menu__btn--room' onClick={createRoom}>
          <Text>创建房间</Text>
        </View>
        <View className='menu__btn menu__btn--room' onClick={() => setJoinOpen(true)}>
          <Text>加入房间</Text>
        </View>
        <View className='menu__btn menu__btn--workshop' onClick={() => startBattle('ai')}>
          <Text>人机对战</Text>
        </View>
        <View className='menu__btn menu__btn--workshop' onClick={goWorkshop}>
          <Text>创作工坊</Text>
        </View>
        <View className='menu__btn menu__btn--workshop' onClick={goHistory}>
          <Text>我的战绩</Text>
        </View>
      </View>

      {/* 加入房间弹层：输入 6 位房间码 */}
      {joinOpen && (
        <View className='mask' onClick={() => setJoinOpen(false)}>
          <View className='mask__panel' onClick={e => e.stopPropagation()}>
            <Text className='mask__title'>加入房间</Text>
            <Text className='mask__desc'>输入好友分享的 6 位房间码</Text>
            <Input
              className='mask__input'
              type='text'
              maxlength={6}
              value={roomCode}
              placeholder='如：A3BK7M'
              onInput={e => setRoomCode(String(e.detail.value).toUpperCase())}
            />
            <View className='mask__actions'>
              <View className='menu__btn menu__btn--workshop mask__btn' onClick={() => setJoinOpen(false)}>
                <Text>取消</Text>
              </View>
              <View className='menu__btn menu__btn--primary mask__btn' onClick={confirmJoinRoom}>
                <Text>加入</Text>
              </View>
            </View>
          </View>
        </View>
      )}

      {stats && stats.total > 0 && (
        <View className='menu__stats' onClick={goHistory}>
          <Text className='menu__stats-title'>{nickname ? `${nickname} · ` : ''}我的战绩（点击查看历史对局）</Text>
          <View className='menu__stats-row'>
            <View className='menu__stats-item'>
              <Text className='menu__stats-num menu__stats-num--win'>{stats.wins}</Text>
              <Text className='menu__stats-label'>胜</Text>
            </View>
            <View className='menu__stats-item'>
              <Text className='menu__stats-num'>{stats.losses}</Text>
              <Text className='menu__stats-label'>负</Text>
            </View>
            <View className='menu__stats-item'>
              <Text className='menu__stats-num'>{stats.draws}</Text>
              <Text className='menu__stats-label'>平</Text>
            </View>
          </View>
        </View>
      )}

      <View className='menu__rules'>
        <Text className='menu__rules-title'>玩法速览</Text>
        <Text className='menu__rules-line'>· 3×3 棋盘，红蓝双方轮流落子</Text>
        <Text className='menu__rules-line'>· 落在空格，或用克制属性叠放在对方棋子上占领该格（单格最多 8 层）</Text>
        <Text className='menu__rules-line'>· 三连不立即获胜：对手有一整回合的机会叠放打断</Text>
        <Text className='menu__rules-line'>· 打不断则三连方获胜；棋盘下满无三连为平局</Text>
        <Text className='menu__rules-line'>· 起始手牌 3 张，此后每回合自动抽 1 张；牌堆抽完即止，不重洗</Text>
      </View>
    </View>
  )
}
