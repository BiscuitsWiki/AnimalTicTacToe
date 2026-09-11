/**
 * 战绩统计 API：
 * - GET  /game/stats/:playerId          分模式胜负平统计（pvp / ai）
 * - GET  /game/history/:playerId?mode=  最近对局（mode=pvp|ai，缺省全部）
 * - POST /game/ai-result                人机对局结果上报（本地结算 → 落库）
 * P2.3：基于已落库的 Match 记录聚合；P6 数据落库补全历史查询。
 */
import { BadRequestException, Body, Controller, Get, Param, Post, Query } from '@nestjs/common'
import { PrismaService } from '../prisma.service.js'

/** 单模式的胜负平小计 */
export interface ModeStats {
  wins: number
  losses: number
  draws: number
  total: number
}

export interface StatsDto {
  playerId: string
  /** 真人对战（匹配 + 房间） */
  pvp: ModeStats
  /** 人机对战（客户端上报） */
  ai: ModeStats
}

export interface HistoryItemDto {
  matchId: string
  /** 我的阵营 */
  mySide: 'red' | 'blue'
  /** 对手昵称 */
  opponentName: string
  /** 我方结果 */
  result: 'win' | 'lose' | 'draw'
  /** 结束原因：line=三连 board_full/both_skip=平 resign=认输 opponent_disconnect=对手超时 */
  reason: string
  /** 对局模式：pvp=真人 ai=人机 */
  mode: string
  /** 结束时间 */
  endedAt: string
}

export interface HistoryDto {
  playerId: string
  items: HistoryItemDto[]
}

/** 人机上报的合法值白名单（人机局不存在断线判负） */
const AI_WINNER_SIDES = new Set(['red', 'blue', 'draw'])
const AI_REASONS = new Set(['line', 'board_full', 'both_skip', 'resign'])
/** 人机对手的固定身份 */
const AI_PLAYER_ID = 'ai'
const AI_NAME = '电脑'

@Controller('game')
export class GameStatsController {
  constructor(private readonly prisma: PrismaService) {}

  @Get('stats/:playerId')
  async stats(@Param('playerId') playerId: string): Promise<StatsDto> {
    const matches = await this.prisma.match.findMany({
      where: { OR: [{ redPlayerId: playerId }, { bluePlayerId: playerId }] },
      select: { redPlayerId: true, winnerSide: true, mode: true },
    })
    const empty: ModeStats = { wins: 0, losses: 0, draws: 0, total: 0 }
    const agg = (filter: (mode: string) => boolean): ModeStats => {
      const acc = { ...empty }
      for (const m of matches) {
        if (!filter(m.mode)) continue
        acc.total++
        if (m.winnerSide === 'draw') acc.draws++
        else {
          const mySide = m.redPlayerId === playerId ? 'red' : 'blue'
          if (m.winnerSide === mySide) acc.wins++
          else acc.losses++
        }
      }
      return acc
    }
    return {
      playerId,
      pvp: agg(mode => mode !== 'ai'),
      ai: agg(mode => mode === 'ai'),
    }
  }

  /** 最近对局列表（按结束时间倒序，默认 20 条，上限 50；mode 过滤：pvp|ai，缺省全部） */
  @Get('history/:playerId')
  async history(
    @Param('playerId') playerId: string,
    @Query('limit') limit?: string,
    @Query('mode') mode?: string,
  ): Promise<HistoryDto> {
    const n = Math.min(Math.max(Number(limit) || 20, 1), 50)
    const modeFilter = mode === 'ai' ? 'ai' : mode === 'pvp' ? { not: 'ai' } : undefined
    const matches = await this.prisma.match.findMany({
      where: {
        OR: [{ redPlayerId: playerId }, { bluePlayerId: playerId }],
        ...(modeFilter ? { mode: modeFilter } : {}),
      },
      orderBy: { endedAt: 'desc' },
      take: n,
    })
    return {
      playerId,
      items: matches.map(m => {
        const mySide: HistoryItemDto['mySide'] = m.redPlayerId === playerId ? 'red' : 'blue'
        const result: HistoryItemDto['result'] =
          m.winnerSide === 'draw' ? 'draw' : (m.winnerSide === mySide ? 'win' : 'lose')
        return {
          matchId: m.id,
          mySide,
          opponentName: mySide === 'red' ? m.blueName : m.redName,
          result,
          reason: m.reason,
          mode: m.mode,
          endedAt: m.endedAt.toISOString(),
        }
      }),
    }
  }

  /**
   * 人机对局结果上报：人机局在客户端本地结算，终局时上报落库（mode='ai'）。
   * 上报结果不可信但无利益可图（人机战绩与真人对战分开统计展示）。
   */
  @Post('ai-result')
  async reportAiResult(
    @Body() body: { playerId?: string; playerName?: string; mySide?: string; winnerSide?: string; reason?: string },
  ): Promise<{ ok: true; matchId: string }> {
    const { playerId, playerName, mySide, winnerSide, reason } = body
    if (!playerId) throw new BadRequestException('缺少 playerId')
    if (mySide !== 'red' && mySide !== 'blue') throw new BadRequestException('mySide 非法')
    if (!AI_WINNER_SIDES.has(winnerSide ?? '')) throw new BadRequestException('winnerSide 非法')
    if (!AI_REASONS.has(reason ?? '')) throw new BadRequestException('reason 非法')

    const humanName = playerName?.trim() || '玩家'
    const now = new Date()
    const created = await this.prisma.match.create({
      data: {
        redPlayerId: mySide === 'red' ? playerId : AI_PLAYER_ID,
        bluePlayerId: mySide === 'blue' ? playerId : AI_PLAYER_ID,
        redName: mySide === 'red' ? humanName : AI_NAME,
        blueName: mySide === 'blue' ? humanName : AI_NAME,
        winnerSide: winnerSide!,
        reason: reason!,
        mode: 'ai',
        createdAt: now,
        endedAt: now,
      },
    })
    return { ok: true, matchId: created.id }
  }
}
