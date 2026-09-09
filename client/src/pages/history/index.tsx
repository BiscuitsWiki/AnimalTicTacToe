/**
 * 战绩页（P6 数据落库）：胜负平统计卡 + 最近对局列表。
 */
import { useEffect, useState } from 'react'
import { View, Text } from '@tarojs/components'
import Taro, { useDidShow } from '@tarojs/taro'
import { fetchHistory, fetchStats } from '../../services/api'
import type { HistoryItem, PlayerStats } from '../../services/api'
import { ensureLogin } from '../../services/auth'
import './index.scss'

/** 结束原因文案 */
const reasonText = (r: string) =>
  r === 'line' ? '三连制胜' :
  r === 'board_full' ? '棋盘叠满' :
  r === 'both_skip' ? '双方连续跳过' :
  r === 'no_moves' ? '无处可落' :
  r === 'opponent_disconnect' ? '对手超时未归' : r

/** 相对时间：刚刚 / N 分钟前 / N 小时前 / M月D日 */
function timeAgo(iso: string): string {
  const diff = Date.now() - new Date(iso).getTime()
  const min = Math.floor(diff / 60_000)
  if (min < 1) return '刚刚'
  if (min < 60) return `${min} 分钟前`
  const hour = Math.floor(min / 60)
  if (hour < 24) return `${hour} 小时前`
  const d = new Date(iso)
  return `${d.getMonth() + 1}月${d.getDate()}日`
}

export default function History () {
  const [stats, setStats] = useState<PlayerStats | null>(null)
  const [items, setItems] = useState<HistoryItem[] | null>(null)
  const [failed, setFailed] = useState(false)

  const load = async () => {
    const user = await ensureLogin()
    if (!user) {
      setFailed(true)
      return
    }
    try {
      const [s, h] = await Promise.all([
        fetchStats(user.id),
        fetchHistory(user.id, 20),
      ])
      setStats(s)
      setItems(h.items)
    } catch {
      setFailed(true)
    }
  }

  useDidShow(() => { load() })
  useEffect(() => { load() }, [])

  return (
    <View className='history'>
      <View className='history__back' onClick={() => Taro.navigateBack()}>
        <Text>返回</Text>
      </View>

      {failed && (
        <Text className='history__empty'>加载失败，请确认后端已启动后返回重试</Text>
      )}

      {!failed && stats && (
        <View className='history__summary'>
          <View className='history__summary-item'>
            <Text className='history__summary-num history__summary-num--win'>{stats.wins}</Text>
            <Text className='history__summary-label'>胜</Text>
          </View>
          <View className='history__summary-item'>
            <Text className='history__summary-num'>{stats.losses}</Text>
            <Text className='history__summary-label'>负</Text>
          </View>
          <View className='history__summary-item'>
            <Text className='history__summary-num'>{stats.draws}</Text>
            <Text className='history__summary-label'>平</Text>
          </View>
          <View className='history__summary-item'>
            <Text className='history__summary-num history__summary-num--rate'>
              {stats.total > 0 ? Math.round((stats.wins / stats.total) * 100) : 0}%
            </Text>
            <Text className='history__summary-label'>胜率</Text>
          </View>
        </View>
      )}

      {!failed && items && items.length === 0 && (
        <Text className='history__empty'>还没有对局记录，快去开局吧</Text>
      )}

      {!failed && items && items.length > 0 && (
        <View className='history__list'>
          {items.map(m => (
            <View key={m.matchId} className={`history__item history__item--${m.result}`}>
              <View className='history__item-result'>
                <Text>
                  {m.result === 'win' ? '胜' : m.result === 'lose' ? '负' : '平'}
                </Text>
              </View>
              <View className='history__item-main'>
                <Text className='history__item-oppo'>
                  对手：{m.opponentName}
                </Text>
                <Text className='history__item-meta'>
                  {m.mySide === 'red' ? '红方' : '蓝方'} · {reasonText(m.reason)} · {timeAgo(m.endedAt)}
                </Text>
              </View>
            </View>
          ))}
        </View>
      )}
    </View>
  )
}
