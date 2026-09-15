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

    const piecesByStatus = await this.prisma.piece.groupBy({
      by: ['status'],
      _count: { _all: true },
    })
    const pieceCount = (status: string) =>
      piecesByStatus.find(g => g.status === status)?._count._all ?? 0

    const [matchTotal, matchToday, reportTotal, reportToday] = await Promise.all([
      this.prisma.match.count(),
      this.prisma.match.count({ where: { createdAt: { gte: startOfToday() } } }),
      this.prisma.pieceReport.count(),
      this.prisma.pieceReport.count({ where: { createdAt: { gte: startOfToday() } } }),
    ])

    return {
      pieces: {
        pending: pieceCount('pending'),
        approved: pieceCount('approved'),
        reported: pieceCount('reported'),
        rejected: pieceCount('rejected'),
        recycled: pieceCount('recycled'),
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

  /** 举报明细列表（管理端子页，按时间倒序，附带棋子信息） */
  @Get('reports')
  async reports(@Headers() headers: Record<string, string>, @Query('limit') limit?: string) {
    this.assertAdmin(headers)
    const n = Math.min(Math.max(Number(limit) || 50, 1), 200)
    const list = await this.prisma.pieceReport.findMany({
      orderBy: { createdAt: 'desc' },
      take: n,
    })
    const pieces = await this.prisma.piece.findMany({
      where: { id: { in: [...new Set(list.map(r => r.pieceId))] } },
      select: { id: true, name: true, status: true },
    })
    const pieceMap = new Map(pieces.map(p => [p.id, p]))
    return list.map(r => ({
      ...r,
      createdAt: r.createdAt.toISOString(),
      pieceName: pieceMap.get(r.pieceId)?.name ?? '(已删除)',
      pieceStatus: pieceMap.get(r.pieceId)?.status ?? 'deleted',
    }))
  }
}

function startOfToday(): Date {
  const d = new Date()
  d.setHours(0, 0, 0, 0)
  return d
}
