import { BadRequestException, Injectable, Logger, NotFoundException } from '@nestjs/common'
import { unlink } from 'node:fs/promises'
import { join } from 'node:path'
import type { Card, Skin, SkinReport } from '@prisma/client'
import { PrismaService } from '../prisma.service.js'
import { ContentSecurityService } from './content-security.service.js'
import { ELEMENTS, ELEMENT_NAMES_ZH } from '../game/core/elements.js'
import type { Element } from '../game/core/elements.js'
import { PRESET_DECK } from '../game/core/pieces.js'
import type { CardWithSkins, DeckSkin } from '../game/core/deck.js'

/** 18 属性白名单（单一来源：core/elements.ts，与客户端保持一致） */
const ELEMENT_SET = new Set<string>(ELEMENTS)

/** 旧宝可梦属性 ID → 洛克王国属性（历史数据迁移，启动时执行、幂等） */
const ELEMENT_ALIASES: Record<string, string> = {
  fighting: 'martial', ground: 'earth', flying: 'wing', psychic: 'illusion',
  steel: 'machine', fairy: 'cute', rock: 'earth',
}

const NAME_MAX_LEN = 12

/** 同名不同属性统一的驳回/拒绝文案（创作提交与数据归并共用） */
export const CARD_CONFLICT_REASON = '与同名卡牌属性不一致，请修改名称或属性后重新提交'

/** 有效举报数达到阈值自动下架重审 */
export const REPORT_THRESHOLD = 3

/** 回收区保留天数：超过仍未恢复上架则销毁数据 */
export const RECYCLE_DAYS = 30

/** 举报理由白名单（与客户端选项一致） */
export const REPORT_REASONS = new Set([
  'porn', 'violence', 'politics', 'infringement', 'ad', 'other',
])

type SkinWithCard = Skin & { card: Card }
type SkinWithReports = SkinWithCard & { reports: SkinReport[] }

/** 属性中文文案（如 火 / 火+萌），用于提示文案 */
function elementLabel(element: string, element2?: string | null): string {
  const zh = (e: string) => ELEMENT_NAMES_ZH[e as Element] ?? e
  return element2 ? `${zh(element)}/${zh(element2)}` : zh(element)
}

/**
 * 属性组合是否相同（主/副顺序无关）：进攻择优、防守连乘均与顺序无关，
 * 「幻/电」与「电/幻」是同一组合，不视为同名卡属性冲突。
 */
function sameElementCombo(
  a: { element: string; element2?: string | null },
  b: { element: string; element2?: string | null },
): boolean {
  const combo = (x: { element: string; element2?: string | null }) =>
    [x.element, ...(x.element2 ? [x.element2] : [])].sort().join('|')
  return combo(a) === combo(b)
}

@Injectable()
export class PieceService {
  private readonly logger = new Logger(PieceService.name)

  constructor(
    private readonly prisma: PrismaService,
    private readonly sec: ContentSecurityService,
  ) {}

  /** 启动迁移：旧属性 ID 洗成洛克王国属性 + 预设卡 seed + 回收区过期巡检 */
  async onModuleInit() {
    for (const [from, to] of Object.entries(ELEMENT_ALIASES)) {
      await this.prisma.card.updateMany({ where: { element: from }, data: { element: to } })
    }
    await this.seedPresetCards()
    // 回收区过期销毁巡检：每天清理一次（unref 避免阻塞进程退出）
    const timer = setInterval(() => {
      this.cleanupExpiredRecycled().catch(() => {})
    }, 24 * 60 * 60 * 1000)
    timer.unref()
  }

  /**
   * 预设卡 seed（幂等）：51 张预设卡入库为 Card（source=preset），卡牌 id 固定为 pc-<预设 id>。
   * 同名卡已存在时以预设定义为准：属性一致则收编为预设卡（保留其卡牌 id 与皮肤），
   * 属性不一致则改回预设属性并驳回其皮肤（预设卡是卡池属性覆盖的保证）。
   */
  private async seedPresetCards(): Promise<void> {
    for (const preset of PRESET_DECK) {
      const existing = await this.prisma.card.findUnique({ where: { cardName: preset.name } })
      if (!existing) {
        await this.prisma.card.create({
          data: {
            cardId: `pc-${preset.id}`,
            cardName: preset.name,
            element: preset.element,
            element2: preset.element2 ?? null,
            source: 'preset',
          },
        })
        continue
      }
      const sameElement = sameElementCombo(existing, preset)
      if (sameElement) {
        const canonicalOrder =
          existing.element === preset.element && (existing.element2 ?? null) === (preset.element2 ?? null)
        if (existing.source !== 'preset' || !canonicalOrder) {
          // 收编为预设卡：属性以预设定义为准（含主/副顺序规范化）
          await this.prisma.card.update({
            where: { cardId: existing.cardId },
            data: {
              element: preset.element,
              element2: preset.element2 ?? null,
              source: 'preset',
            },
          })
          this.logger.log(
            `预设卡收编同名卡牌「${preset.name}」(${existing.cardId})：属性规范为 ${elementLabel(preset.element, preset.element2)}`,
          )
        }
        continue
      }
      // 同名不同属性：预设定义权威，改回预设属性并驳回该卡全部皮肤
      await this.prisma.card.update({
        where: { cardId: existing.cardId },
        data: {
          element: preset.element,
          element2: preset.element2 ?? null,
          source: 'preset',
        },
      })
      const rejected = await this.prisma.skin.updateMany({
        where: { cardId: existing.cardId },
        data: { status: 'rejected', rejectReason: CARD_CONFLICT_REASON },
      })
      this.logger.warn(
        `预设卡「${preset.name}」与原工坊卡属性冲突（${elementLabel(existing.element, existing.element2)} → ${elementLabel(preset.element, preset.element2)}），已驳回其 ${rejected.count} 个皮肤`,
      )
    }
  }

  /**
   * 提交创作（同名即同一张卡）：
   * - 名称未占用 → 建卡牌（工坊来源）+ 皮肤（待审核）
   * - 名称已占用 → 属性必须与既有卡牌一致，仅新增皮肤；不一致直接拒绝
   */
  async submit(dto: { name: string; element: string; element2?: string | null; imageUrl: string; authorId?: string }) {
    const name = dto.name?.trim() ?? ''
    if (name.length === 0 || name.length > NAME_MAX_LEN) {
      throw new BadRequestException(`棋子名需为 1~${NAME_MAX_LEN} 个字符`)
    }
    if (!ELEMENT_SET.has(dto.element)) {
      throw new BadRequestException('非法属性')
    }
    const element2 = dto.element2 || null
    if (element2) {
      if (!ELEMENT_SET.has(element2)) {
        throw new BadRequestException('非法副属性')
      }
      if (element2 === dto.element) {
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

    const card = await this.resolveCard({ name, element: dto.element, element2 })
    return this.prisma.skin.create({
      data: {
        cardId: card.cardId,
        imageUrl: dto.imageUrl,
        authorId: dto.authorId ?? 'guest',
        status: 'pending',
      },
    })
  }

  /** 取（或建）卡牌：同名卡属性为权威，提交属性不一致直接拒绝 */
  private async resolveCard(input: { name: string; element: string; element2: string | null }): Promise<Card> {
    const existing = await this.prisma.card.findUnique({ where: { cardName: input.name } })
    if (existing) return this.assertCardElement(existing, input)
    try {
      return await this.prisma.card.create({
        data: {
          cardName: input.name,
          element: input.element,
          element2: input.element2,
          source: 'workshop',
        },
      })
    } catch (e) {
      // 并发提交同名卡：唯一约束兜底，改为复用已建卡牌
      if ((e as { code?: string }).code === 'P2002') {
        const card = await this.prisma.card.findUnique({ where: { cardName: input.name } })
        if (card) return this.assertCardElement(card, input)
      }
      throw e
    }
  }

  private assertCardElement(card: Card, input: { element: string; element2: string | null }): Card {
    // 主/副顺序不敏感：「幻/电」提交到「电/幻」的卡视为同一组合，不拒绝
    if (!sameElementCombo(card, input)) {
      throw new BadRequestException(
        `该名称已有卡牌（${elementLabel(card.element, card.element2)}），属性需与之一致；如需不同属性请改名`,
      )
    }
    return card
  }

  /** 按名称查卡牌（工坊提交时的"同名卡"提示用）；不存在返回 null */
  async lookupCard(name: string) {
    const cardName = name?.trim() ?? ''
    if (!cardName) return null
    const card = await this.prisma.card.findUnique({ where: { cardName } })
    if (!card) return null
    const approvedSkinCount = await this.prisma.skin.count({
      where: { cardId: card.cardId, status: 'approved' },
    })
    return {
      cardId: card.cardId,
      name: card.cardName,
      element: card.element,
      element2: card.element2,
      source: card.source,
      approvedSkinCount,
    }
  }

  /** 公共池（审核通过的皮肤；含所属卡牌的名称与属性） */
  async listApproved(limit = 100) {
    const rows = await this.prisma.skin.findMany({
      where: { status: 'approved' },
      orderBy: { createdAt: 'desc' },
      take: limit,
      include: { card: true },
    })
    return rows.map(s => this.publicView(s))
  }

  /**
   * 对局卡池：预设卡（内置无图外观 + 库中同名卡的上架皮肤）+ 有 ≥1 上架皮肤的工坊卡。
   * 属性以卡牌为准（预设卡以代码定义为权威）。
   */
  async listPlayableCards(): Promise<CardWithSkins[]> {
    const [cards, skins] = await Promise.all([
      this.prisma.card.findMany({
        select: { cardId: true, cardName: true, element: true, element2: true },
      }),
      this.prisma.skin.findMany({
        where: { status: 'approved' },
        select: { skinId: true, cardId: true, imageUrl: true },
        orderBy: { createdAt: 'desc' },
      }),
    ])
    const skinsByCard = new Map<string, DeckSkin[]>()
    for (const s of skins) {
      const list = skinsByCard.get(s.cardId) ?? []
      list.push({ skinId: s.skinId, ...(s.imageUrl ? { imageUrl: s.imageUrl } : {}) })
      skinsByCard.set(s.cardId, list)
    }
    const cardByName = new Map(cards.map(c => [c.cardName, c]))
    const pool: CardWithSkins[] = []
    const used = new Set<string>()

    // 预设卡：代码为权威（内置外观恒可用，库中同名卡的上架皮肤并入）
    for (const preset of PRESET_DECK) {
      const row = cardByName.get(preset.name)
      const cardId = row?.cardId ?? `pc-${preset.id}`
      const skinList = [...(skinsByCard.get(cardId) ?? [])]
      used.add(cardId)
      pool.push({
        cardId,
        name: preset.name,
        element: preset.element,
        ...(preset.element2 ? { element2: preset.element2 } : {}),
        skins: [{ skinId: preset.id }, ...skinList.filter(s => s.skinId !== preset.id)],
      })
    }
    // 工坊卡：有上架皮肤才参战
    for (const c of cards) {
      if (used.has(c.cardId)) continue
      const played = skinsByCard.get(c.cardId) ?? []
      if (played.length === 0) continue
      pool.push({
        cardId: c.cardId,
        name: c.cardName,
        element: c.element as Element,
        ...(c.element2 ? { element2: c.element2 as Element } : {}),
        skins: played,
      })
    }
    return pool
  }

  /** 我的皮肤（登录态下按当前用户查询；含所属卡牌名称与属性） */
  async listMine(authorId: string) {
    const rows = await this.prisma.skin.findMany({
      where: { authorId },
      orderBy: { createdAt: 'desc' },
      include: { card: true },
    })
    return rows.map(s => this.mineView(s))
  }

  /** 上架中皮肤队列（管理端，全字段供后台展示/下架） */
  async listApprovedFull() {
    const rows = await this.prisma.skin.findMany({
      where: { status: 'approved' },
      orderBy: { createdAt: 'desc' },
      include: { card: true },
    })
    return rows.map(s => this.adminView(s))
  }

  /** 待审核队列（管理端） */
  async listPending() {
    const rows = await this.prisma.skin.findMany({
      where: { status: 'pending' },
      orderBy: { createdAt: 'asc' },
      include: { card: true },
    })
    return rows.map(s => this.adminView(s))
  }

  /** 已驳回队列（管理端） */
  async listRejected() {
    const rows = await this.prisma.skin.findMany({
      where: { status: 'rejected' },
      orderBy: { updatedAt: 'desc' },
      include: { card: true },
    })
    return rows.map(s => this.adminView(s))
  }

  /** 回收区队列（管理端：手动下架的皮肤，30 天未恢复则销毁） */
  async listRecycled() {
    const rows = await this.prisma.skin.findMany({
      where: { status: 'recycled' },
      orderBy: { recycledAt: 'desc' },
      include: { card: true },
    })
    // 附带剩余保留时间（供后台展示距销毁的天数）
    return rows.map(s => ({
      ...this.adminView(s),
      recycledRemainDays: s.recycledAt
        ? Math.max(0, RECYCLE_DAYS - Math.floor((Date.now() - s.recycledAt.getTime()) / 86_400_000))
        : RECYCLE_DAYS,
    }))
  }

  /** 清理回收区中超期未恢复的皮肤（销毁数据：皮肤 + 举报明细 + 图片文件；空卡牌一并回收） */
  async cleanupExpiredRecycled() {
    const deadline = new Date(Date.now() - RECYCLE_DAYS * 86_400_000)
    const expired = await this.prisma.skin.findMany({
      where: { status: 'recycled', recycledAt: { lt: deadline } },
      select: { skinId: true, cardId: true, imageUrl: true },
    })
    if (expired.length === 0) return 0
    const ids = expired.map(s => s.skinId)
    await this.prisma.skinReport.deleteMany({ where: { skinId: { in: ids } } })
    await this.prisma.skin.deleteMany({ where: { skinId: { in: ids } } })
    // 工坊卡若已无任何皮肤（名称可重新使用），回收卡牌行；预设卡恒保留
    await this.prisma.card.deleteMany({
      where: {
        cardId: { in: [...new Set(expired.map(s => s.cardId))] },
        source: 'workshop',
        skins: { none: {} },
      },
    })
    // 尽力清理已上传的图片文件（资源隔离，失败静默）
    for (const s of expired) {
      const m = /^\/uploads\/([^/]+)$/.exec(s.imageUrl)
      if (m) await unlink(join(process.cwd(), 'uploads', m[1])).catch(() => {})
    }
    return expired.length
  }

  /** 撤回待审核提交（仅作者本人；pending 状态可撤回，撤回即删除皮肤记录） */
  async withdraw(skinId: string, authorId: string) {
    const skin = await this.prisma.skin.findUnique({ where: { skinId } })
    if (!skin) throw new NotFoundException('棋子不存在')
    if (!authorId || skin.authorId !== authorId) {
      throw new BadRequestException('只能撤回自己提交的棋子')
    }
    if (skin.status !== 'pending') {
      throw new BadRequestException('仅待审核的棋子可撤回')
    }
    await this.prisma.skin.delete({ where: { skinId } })
    // 工坊卡若已无任何皮肤（名称可重新使用），回收卡牌行；预设卡恒保留
    await this.prisma.card.deleteMany({
      where: { cardId: skin.cardId, source: 'workshop', skins: { none: {} } },
    })
    // 尽力清理已上传的图片文件（资源隔离，失败静默）
    const m = /^\/uploads\/([^/]+)$/.exec(skin.imageUrl)
    if (m) await unlink(join(process.cwd(), 'uploads', m[1])).catch(() => {})
    return { ok: true }
  }

  /**
   * 审核操作（管理端，按皮肤粒度）：
   * - approve 通过 / reject 驳回（pending / reported 状态可裁决）
   * - takedown 手动下架上架中皮肤 → 回收区（recycled），30 天未恢复则销毁
   * - restore 回收区恢复上架（recycled → approved）
   */
  async review(skinId: string, action: 'approve' | 'reject' | 'takedown' | 'restore', rejectReason?: string) {
    const skin = await this.prisma.skin.findUnique({ where: { skinId } })
    if (!skin) throw new NotFoundException('棋子不存在')

    if (action === 'takedown') {
      if (skin.status !== 'approved') {
        throw new BadRequestException('仅上架中的棋子可下架')
      }
      return this.prisma.skin.update({
        where: { skinId },
        data: { status: 'recycled', recycledAt: new Date(), rejectReason: null },
      })
    }

    if (action === 'restore') {
      if (skin.status !== 'recycled') {
        throw new BadRequestException('仅回收区中的棋子可恢复上架')
      }
      return this.prisma.skin.update({
        where: { skinId },
        data: { status: 'approved', recycledAt: null, reportCount: 0, rejectReason: null },
      })
    }

    if (skin.status !== 'pending' && skin.status !== 'reported') {
      throw new BadRequestException('该棋子不在待审核/被举报状态')
    }
    return this.prisma.skin.update({
      where: { skinId },
      data:
        action === 'approve'
          ? { status: 'approved', rejectReason: null, reportCount: 0 }
          : { status: 'rejected', rejectReason: rejectReason ?? '内容不合规' },
    })
  }

  /**
   * 举报皮肤（P3：对局内举报可疑 UGC，按皮肤粒度）。
   * 同一玩家对同一皮肤去重（唯一索引兜底）；达到阈值自动下架转 reported 等待人工裁决。
   */
  async report(dto: { skinId: string; reporterId: string; matchId?: string; reason: string }) {
    if (!dto.reporterId) throw new BadRequestException('缺少举报者标识')
    if (!REPORT_REASONS.has(dto.reason)) throw new BadRequestException('非法举报理由')
    const skin = await this.prisma.skin.findUnique({ where: { skinId: dto.skinId } })
    if (!skin) throw new NotFoundException('棋子不存在')
    if (skin.status !== 'approved' && skin.status !== 'reported') {
      throw new BadRequestException('该棋子不在上架状态，无需举报')
    }

    // 去重：重复举报幂等返回
    const dup = await this.prisma.skinReport.findUnique({
      where: { skinId_reporterId: { skinId: dto.skinId, reporterId: dto.reporterId } },
    })
    if (dup) {
      return { ok: true, duplicated: true, reportCount: skin.reportCount }
    }

    await this.prisma.skinReport.create({
      data: {
        skinId: dto.skinId,
        reporterId: dto.reporterId,
        matchId: dto.matchId ?? null,
        reason: dto.reason,
      },
    })

    // 有效举报 +1；达到阈值自动下架（approved -> reported，退出公共池等待人工裁决）
    const reportCount = skin.reportCount + 1
    const takedown = reportCount >= REPORT_THRESHOLD && skin.status === 'approved'
    await this.prisma.skin.update({
      where: { skinId: dto.skinId },
      data: takedown ? { reportCount, status: 'reported' } : { reportCount },
    })
    return { ok: true, duplicated: false, reportCount, takedown }
  }

  /** 被举报下架队列（管理端，举报链路） */
  async listReported() {
    const rows = await this.prisma.skin.findMany({
      where: { status: 'reported' },
      orderBy: { updatedAt: 'asc' },
      include: { card: true },
    })
    // 附带举报明细
    return Promise.all(rows.map(async s => ({
      ...this.adminView(s as SkinWithReports),
      reports: await this.prisma.skinReport.findMany({
        where: { skinId: s.skinId },
        orderBy: { createdAt: 'desc' },
        select: { reporterId: true, reason: true, matchId: true, createdAt: true },
      }),
    })))
  }

  // ---------- 视图映射（对外字段名沿用 REST 既有契约：id = skinId、name/属性取卡牌） ----------

  private publicView(s: SkinWithCard) {
    return {
      id: s.skinId,
      cardId: s.cardId,
      name: s.card.cardName,
      element: s.card.element,
      element2: s.card.element2,
      imageUrl: s.imageUrl,
    }
  }

  private mineView(s: SkinWithCard) {
    return {
      ...this.publicView(s),
      status: s.status,
      rejectReason: s.rejectReason,
      createdAt: s.createdAt,
    }
  }

  private adminView(s: SkinWithCard) {
    return {
      ...this.mineView(s),
      reportCount: s.reportCount,
      authorId: s.authorId,
      recycledAt: s.recycledAt,
      updatedAt: s.updatedAt,
    }
  }
}