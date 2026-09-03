/**
 * 战绩统计 API：GET /game/stats/:playerId
 * 历史对局 API：GET /game/history/:playerId?limit=20
 * P2.3：基于已落库的 Match 记录聚合；P6 数据落库补全历史查询。
 */
import { Controller, Get, Param, Query } from '@nestjs/common'
import { PrismaService } from '../prisma.service.js'

export interface StatsDto {
  playerId: string
  wins: number
  losses: number
  draws: number
  total: number
}

export interface HistoryItemDto {
  matchId: string
  /** 我的阵营 */
  mySide: 'red' | 'blue'
  /** 对手昵称 */
  opponentName: string
  /** 我方结果 */
  result: 'win' | 'lose' | 'draw'
  /** 结束原因：line=三连 board_full=平 opponent_disconnect=对手超时 */
  reason: string
  /** 结束时间 */
  endedAt: string
}

export interface HistoryDto {
  playerId: string
  items: HistoryItemDto[]
}

@Controller('game')
export class GameStatsController {
  constructor(private readonly prisma: PrismaService) {}

  @Get('stats/:playerId')
  async stats(@Param('playerId') playerId: string): Promise<StatsDto> {
    const matches = await this.prisma.match.findMany({
      where: { OR: [{ redPlayerId: playerId }, { bluePlayerId: playerId }] },
      select: { redPlayerId: true, winnerSide: true },
    })
    let wins = 0
    let losses = 0
    let draws = 0
    for (const m of matches) {
      if (m.winnerSide === 'draw') draws++
      else {
        const mySide = m.redPlayerId === playerId ? 'red' : 'blue'
        if (m.winnerSide === mySide) wins++
        else losses++
      }
    }
    return { playerId, wins, losses, draws, total: matches.length }
  }

  /** 最近对局列表（按结束时间倒序，默认 20 条，上限 50） */
  @Get('history/:playerId')
  async history(
    @Param('playerId') playerId: string,
    @Query('limit') limit?: string,
  ): Promise<HistoryDto> {
    const n = Math.min(Math.max(Number(limit) || 20, 1), 50)
    const matches = await this.prisma.match.findMany({
      where: { OR: [{ redPlayerId: playerId }, { bluePlayerId: playerId }] },
      orderBy: { endedAt: 'desc' },
      take: n,
    })
    return {
      playerId,
      items: matches.map(m => {
        const mySide: 'red' | 'blue' = m.redPlayerId === playerId ? 'red' : 'blue'
        const result: HistoryItemDto['result'] =
          m.winnerSide === 'draw' ? 'draw' : (m.winnerSide === mySide ? 'win' : 'lose')
        return {
          matchId: m.id,
          mySide,
          opponentName: mySide === 'red' ? m.blueName : m.redName,
          result,
          reason: m.reason,
          endedAt: m.endedAt.toISOString(),
        }
      }),
    }
  }
}
