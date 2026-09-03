/**
 * 运营后台 API：GET /admin/stats 概览统计（管理端鉴权）。
 */
import { Controller, Get, Headers } from '@nestjs/common'
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
      },
      matches: { total: matchTotal, today: matchToday },
      reports: { total: reportTotal, today: reportToday },
    }
  }
}

function startOfToday(): Date {
  const d = new Date()
  d.setHours(0, 0, 0, 0)
  return d
}
