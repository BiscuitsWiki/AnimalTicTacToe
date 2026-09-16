/**
 * 运营后台 API：GET /admin/stats 概览统计（管理端鉴权）。
 */
import { Controller, Get, Headers, Query } from '@nestjs/common'
import { ConfigService } from '@nestjs/config'
import { PrismaService } from '../prisma.service.js'
import { assertAdmin } from '../common/admin-auth.js'

@Controller('admin')
export class AdminController {
  constructor(
    private readonly prisma: PrismaService,
    private readonly config: ConfigService,
  ) {}

  private assertAdmin(headers: Record<string, string>) {
    assertAdmin(this.config, headers)
  }

  @Get('stats')
  async stats(@Headers() headers: Record<string, string>) {
    this.assertAdmin(headers)

    const [skinsByStatus, cardsBySource, matchTotal, matchToday, reportTotal, reportToday] = await Promise.all([
      this.prisma.skin.groupBy({ by: ['status'], _count: { _all: true } }),
      this.prisma.card.groupBy({ by: ['source'], _count: { _all: true } }),
      this.prisma.match.count(),
      this.prisma.match.count({ where: { createdAt: { gte: startOfToday() } } }),
      this.prisma.skinReport.count(),
      this.prisma.skinReport.count({ where: { createdAt: { gte: startOfToday() } } }),
    ])
    const pieceCount = (status: string) =>
      skinsByStatus.find(g => g.status === status)?._count._all ?? 0
    const cardCount = (source: string) =>
      cardsBySource.find(g => g.source === source)?._count._all ?? 0

    return {
      // pieces = 皮肤（审核粒度），cards = 卡牌（同名即同一张卡）
      pieces: {
        pending: pieceCount('pending'),
        approved: pieceCount('approved'),
        reported: pieceCount('reported'),
        rejected: pieceCount('rejected'),
        recycled: pieceCount('recycled'),
      },
      cards: {
        total: cardsBySource.reduce((n, g) => n + g._count._all, 0),
        preset: cardCount('preset'),
        workshop: cardCount('workshop'),
      },
      matches: { total: matchTotal, today: matchToday },
      reports: { total: reportTotal, today: reportToday },
    }
  }

  /** 对局列表（管理端子页，按结束时间倒序） */
  @Get('matches')
  async matches(@Headers() headers: Record<string, string>, @Query('limit') limit?: string) {
    this.assertAdmin(headers)
    const n = Math.min(Math.max(Number(limit) || 50, 1), 200)
    const list = await this.prisma.match.findMany({
      orderBy: { endedAt: 'desc' },
      take: n,
    })
    return list.map(m => ({
      ...m,
      endedAt: m.endedAt.toISOString(),
      createdAt: m.createdAt.toISOString(),
    }))
  }

  /** 举报明细列表（管理端子页，按时间倒序，附带皮肤信息） */
  @Get('reports')
  async reports(@Headers() headers: Record<string, string>, @Query('limit') limit?: string) {
    this.assertAdmin(headers)
    const n = Math.min(Math.max(Number(limit) || 50, 1), 200)
    const list = await this.prisma.skinReport.findMany({
      orderBy: { createdAt: 'desc' },
      take: n,
    })
    const skins = await this.prisma.skin.findMany({
      where: { skinId: { in: [...new Set(list.map(r => r.skinId))] } },
      select: { skinId: true, status: true, card: { select: { cardName: true } } },
    })
    const skinMap = new Map(skins.map(s => [s.skinId, s]))
    return list.map(r => ({
      ...r,
      createdAt: r.createdAt.toISOString(),
      pieceName: skinMap.get(r.skinId)?.card.cardName ?? '(已删除)',
      pieceStatus: skinMap.get(r.skinId)?.status ?? 'deleted',
    }))
  }
}

function startOfToday(): Date {
  const d = new Date()
  d.setHours(0, 0, 0, 0)
  return d
}
