import { BadRequestException, Injectable, NotFoundException } from '@nestjs/common'
import { PrismaService } from '../prisma.service.js'

/** 18 属性白名单（与前端 core/elements.ts 保持一致） */
const ELEMENTS = new Set([
  'fire', 'water', 'grass', 'electric', 'ice', 'fighting', 'poison', 'ground',
  'flying', 'psychic', 'bug', 'rock', 'ghost', 'dragon', 'dark', 'steel',
  'fairy', 'normal',
])

const NAME_MAX_LEN = 12

/** 有效举报数达到阈值自动下架重审 */
export const REPORT_THRESHOLD = 3

/** 举报理由白名单（与客户端选项一致） */
export const REPORT_REASONS = new Set([
  'porn', 'violence', 'politics', 'infringement', 'ad', 'other',
])

@Injectable()
export class PieceService {
  constructor(private readonly prisma: PrismaService) {}

  /** 提交创作棋子（进入待审核） */
  async submit(dto: { name: string; element: string; imageUrl: string; authorId?: string }) {
    const name = dto.name?.trim() ?? ''
    if (name.length === 0 || name.length > NAME_MAX_LEN) {
      throw new BadRequestException(`棋子名需为 1~${NAME_MAX_LEN} 个字符`)
    }
    if (!ELEMENTS.has(dto.element)) {
      throw new BadRequestException('非法属性')
    }
    if (!dto.imageUrl) {
      throw new BadRequestException('缺少棋子图片')
    }
    return this.prisma.piece.create({
      data: {
        name,
        element: dto.element,
        imageUrl: dto.imageUrl,
        authorId: dto.authorId ?? 'guest',
        status: 'pending',
      },
    })
  }

  /** 公共池：审核通过的棋子（对局牌堆数据源） */
  async listApproved(limit = 100) {
    return this.prisma.piece.findMany({
      where: { status: 'approved' },
      orderBy: { createdAt: 'desc' },
      take: limit,
      select: { id: true, name: true, element: true, imageUrl: true },
    })
  }

  /** 某作者的棋子（含审核状态） */
  async listMine(authorId: string) {
    return this.prisma.piece.findMany({
      where: { authorId },
      orderBy: { createdAt: 'desc' },
    })
  }

  /** 待审核队列（管理端） */
  async listPending() {
    return this.prisma.piece.findMany({
      where: { status: 'pending' },
      orderBy: { createdAt: 'asc' },
    })
  }

  /** 审核操作（管理端）：通过 / 驳回；reported 状态的棋子也可审核（举报链路裁决） */
  async review(id: string, action: 'approve' | 'reject', rejectReason?: string) {
    const piece = await this.prisma.piece.findUnique({ where: { id } })
    if (!piece) throw new NotFoundException('棋子不存在')
    if (piece.status !== 'pending' && piece.status !== 'reported') {
      throw new BadRequestException('该棋子不在待审核/被举报状态')
    }
    return this.prisma.piece.update({
      where: { id },
      data:
        action === 'approve'
          ? { status: 'approved', rejectReason: null, reportCount: 0 }
          : { status: 'rejected', rejectReason: rejectReason ?? '内容不合规' },
    })
  }

  /**
   * 举报棋子（P3：对局内举报可疑 UGC）。
   * 同一玩家对同一棋子去重（唯一索引兜底）；达到阈值自动下架转 reported 等待人工裁决。
   */
  async report(dto: { pieceId: string; reporterId: string; matchId?: string; reason: string }) {
    if (!dto.reporterId) throw new BadRequestException('缺少举报者标识')
    if (!REPORT_REASONS.has(dto.reason)) throw new BadRequestException('非法举报理由')
    const piece = await this.prisma.piece.findUnique({ where: { id: dto.pieceId } })
    if (!piece) throw new NotFoundException('棋子不存在')
    if (piece.status !== 'approved' && piece.status !== 'reported') {
      throw new BadRequestException('该棋子不在上架状态，无需举报')
    }

    // 去重：重复举报幂等返回
    const dup = await this.prisma.pieceReport.findUnique({
      where: { pieceId_reporterId: { pieceId: dto.pieceId, reporterId: dto.reporterId } },
    })
    if (dup) {
      return { ok: true, duplicated: true, reportCount: piece.reportCount }
    }

    await this.prisma.pieceReport.create({
      data: {
        pieceId: dto.pieceId,
        reporterId: dto.reporterId,
        matchId: dto.matchId ?? null,
        reason: dto.reason,
      },
    })

    // 有效举报 +1；达到阈值自动下架（approved -> reported，退出公共池等待人工裁决）
    const reportCount = piece.reportCount + 1
    const takedown = reportCount >= REPORT_THRESHOLD && piece.status === 'approved'
    await this.prisma.piece.update({
      where: { id: dto.pieceId },
      data: takedown ? { reportCount, status: 'reported' } : { reportCount },
    })
    return { ok: true, duplicated: false, reportCount, takedown }
  }

  /** 被举报下架队列（管理端，举报链路） */
  async listReported() {
    const pieces = await this.prisma.piece.findMany({
      where: { status: 'reported' },
      orderBy: { updatedAt: 'asc' },
    })
    // 附带举报明细
    return Promise.all(pieces.map(async p => ({
      ...p,
      reports: await this.prisma.pieceReport.findMany({
        where: { pieceId: p.id },
        orderBy: { createdAt: 'desc' },
        select: { reporterId: true, reason: true, matchId: true, createdAt: true },
      }),
    })))
  }
}
