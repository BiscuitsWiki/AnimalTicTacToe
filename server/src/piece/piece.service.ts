import { BadRequestException, Injectable, NotFoundException } from '@nestjs/common'
import { unlink } from 'node:fs/promises'
import { join } from 'node:path'
import { PrismaService } from '../prisma.service.js'
import { ContentSecurityService } from './content-security.service.js'
import { ELEMENTS } from '../game/core/elements.js'

/** 18 属性白名单（单一来源：core/elements.ts，与客户端保持一致） */
const ELEMENT_SET = new Set<string>(ELEMENTS)

/** 旧宝可梦属性 ID → 洛克王国属性（历史棋子数据迁移，启动时执行、幂等） */
const ELEMENT_ALIASES: Record<string, string> = {
  fighting: 'martial', ground: 'earth', flying: 'wing', psychic: 'illusion',
  steel: 'machine', fairy: 'cute', rock: 'earth',
}

const NAME_MAX_LEN = 12

/** 有效举报数达到阈值自动下架重审 */
export const REPORT_THRESHOLD = 3

/** 回收区保留天数：超过仍未恢复上架则销毁数据 */
export const RECYCLE_DAYS = 30

/** 举报理由白名单（与客户端选项一致） */
export const REPORT_REASONS = new Set([
  'porn', 'violence', 'politics', 'infringement', 'ad', 'other',
])

@Injectable()
export class PieceService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly sec: ContentSecurityService,
  ) {}

  /** 启动迁移：把宝可梦时代的旧属性 ID 洗成洛克王国属性（无匹配行时为空操作） */
  async onModuleInit() {
    for (const [from, to] of Object.entries(ELEMENT_ALIASES)) {
      await this.prisma.piece.updateMany({ where: { element: from }, data: { element: to } })
    }
    // 回收区过期销毁巡检：每天清理一次（unref 避免阻塞进程退出）
    const timer = setInterval(() => {
      this.cleanupExpiredRecycled().catch(() => {})
    }, 24 * 60 * 60 * 1000)
    timer.unref()
  }

  /** 提交创作棋子（进入待审核；配置腾讯云密钥时先机器送检，Block 直接拒绝） */
  async submit(dto: { name: string; element: string; element2?: string | null; imageUrl: string; authorId?: string }) {
    const name = dto.name?.trim() ?? ''
    if (name.length === 0 || name.length > NAME_MAX_LEN) {
      throw new BadRequestException(`棋子名需为 1~${NAME_MAX_LEN} 个字符`)
    }
    if (!ELEMENT_SET.has(dto.element)) {
      throw new BadRequestException('非法属性')
    }
    if (dto.element2 != null && dto.element2 !== '') {
      if (!ELEMENT_SET.has(dto.element2)) {
        throw new BadRequestException('非法副属性')
      }
      if (dto.element2 === dto.element) {
        throw new BadRequestException('副属性需与主属性不同')
      }
    }
    if (!dto.imageUrl) {
      throw new BadRequestException('缺少棋子图片')
    }
    if (!/^\/uploads\//.test(dto.imageUrl)) {
      throw new BadRequestException('图片地址非法')
    }

    // 机器初审（fail-open：未配置/异常放行，管理后台人工兜底）
    const verdict = await this.sec.checkPieceImage(dto.imageUrl)
    if (verdict.verdict === 'block') {
      throw new BadRequestException(`图片内容不合规（${verdict.label}），请更换图片`)
    }

    return this.prisma.piece.create({
      data: {
        name,
        element: dto.element,
        element2: dto.element2 || null,
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
      select: { id: true, name: true, element: true, element2: true, imageUrl: true },
    })
  }

  /** 上架中队列（管理端全字段，含作者/举报计数） */
  async listApprovedFull() {
    return this.prisma.piece.findMany({
      where: { status: 'approved' },
      orderBy: { createdAt: 'desc' },
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

  /** 已驳回队列（管理端） */
  async listRejected() {
    return this.prisma.piece.findMany({
      where: { status: 'rejected' },
      orderBy: { updatedAt: 'desc' },
    })
  }

  /** 回收区队列（管理端：手动下架的棋子，30 天未恢复则销毁） */
  async listRecycled() {
    const pieces = await this.prisma.piece.findMany({
      where: { status: 'recycled' },
      orderBy: { recycledAt: 'desc' },
    })
    // 附带剩余保留时间（供后台展示距销毁的天数）
    return pieces.map(p => ({
      ...p,
      recycledRemainDays: p.recycledAt
        ? Math.max(0, RECYCLE_DAYS - Math.floor((Date.now() - p.recycledAt.getTime()) / 86_400_000))
        : RECYCLE_DAYS,
    }))
  }

  /** 清理回收区中超期未恢复的棋子（销毁数据：记录 + 举报明细 + 图片文件） */
  async cleanupExpiredRecycled() {
    const deadline = new Date(Date.now() - RECYCLE_DAYS * 86_400_000)
    const expired = await this.prisma.piece.findMany({
      where: { status: 'recycled', recycledAt: { lt: deadline } },
      select: { id: true, imageUrl: true },
    })
    if (expired.length === 0) return 0
    const ids = expired.map(p => p.id)
    await this.prisma.pieceReport.deleteMany({ where: { pieceId: { in: ids } } })
    await this.prisma.piece.deleteMany({ where: { id: { in: ids } } })
    // 尽力清理已上传的图片文件（资源隔离，失败静默）
    for (const p of expired) {
      const m = /^\/uploads\/([^/]+)$/.exec(p.imageUrl)
      if (m) await unlink(join(process.cwd(), 'uploads', m[1])).catch(() => {})
    }
    return expired.length
  }

  /** 撤回待审核提交（仅作者本人；pending 状态可撤回，撤回即删除记录） */
  async withdraw(id: string, authorId: string) {
    const piece = await this.prisma.piece.findUnique({ where: { id } })
    if (!piece) throw new NotFoundException('棋子不存在')
    if (!authorId || piece.authorId !== authorId) {
      throw new BadRequestException('只能撤回自己提交的棋子')
    }
    if (piece.status !== 'pending') {
      throw new BadRequestException('仅待审核的棋子可撤回')
    }
    await this.prisma.piece.delete({ where: { id } })
    // 尽力清理已上传的图片文件（资源隔离，失败静默）
    const m = /^\/uploads\/([^/]+)$/.exec(piece.imageUrl)
    if (m) await unlink(join(process.cwd(), 'uploads', m[1])).catch(() => {})
    return { ok: true }
  }

  /**
   * 审核操作（管理端）：
   * - approve 通过 / reject 驳回（pending / reported 状态可裁决）
   * - takedown 手动下架上架中棋子 → 回收区（recycled），30 天未恢复则销毁
   * - restore 回收区恢复上架（recycled → approved）
   */
  async review(id: string, action: 'approve' | 'reject' | 'takedown' | 'restore', rejectReason?: string) {
    const piece = await this.prisma.piece.findUnique({ where: { id } })
    if (!piece) throw new NotFoundException('棋子不存在')

    if (action === 'takedown') {
      if (piece.status !== 'approved') {
        throw new BadRequestException('仅上架中的棋子可下架')
      }
      return this.prisma.piece.update({
        where: { id },
        data: { status: 'recycled', recycledAt: new Date(), rejectReason: null },
      })
    }

    if (action === 'restore') {
      if (piece.status !== 'recycled') {
        throw new BadRequestException('仅回收区中的棋子可恢复上架')
      }
      return this.prisma.piece.update({
        where: { id },
        data: { status: 'approved', recycledAt: null, reportCount: 0, rejectReason: null },
      })
    }

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
