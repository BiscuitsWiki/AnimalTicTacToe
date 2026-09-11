/**
 * 分模式战绩单元测试：
 * - stats：pvp/ai 双桶聚合、存量无 mode 记录归真人（向后兼容）、红蓝阵营判定
 * - history：mode 过滤（ai/pvp/全部）、字段映射、limit 钳制
 * - ai-result：落库映射（玩家/AI 执方、昵称默认值）、载荷白名单校验
 * PrismaService 用内存行替身，只实现控制器用到的 findMany / create 查询形态。
 */
import { BadRequestException } from '@nestjs/common'
import { beforeEach, describe, expect, it, vi } from 'vitest'
import { GameStatsController } from './game.stats.controller.js'
import type { PrismaService } from '../prisma.service.js'

/** 与 Prisma Match 行等价的最小内存行（mode 可空：存量数据无该列值） */
interface MatchRow {
  id: string
  redPlayerId: string
  bluePlayerId: string
  redName: string
  blueName: string
  winnerSide: string
  reason: string
  mode?: string | null
  createdAt: Date
  endedAt: Date
}

/** 内存版 Prisma 替身：实现控制器使用的 where/OR/mode/orderBy/take/select 形态 */
class FakePrisma {
  rows: MatchRow[] = []
  private seq = 0
  match = {
    findMany: vi.fn(async (args: {
      where: { OR: { redPlayerId?: string; bluePlayerId?: string }[]; mode?: string | { not: string } }
      orderBy?: { endedAt?: string }
      take?: number
      select?: Record<string, boolean>
    }) => {
      const pid = args.where.OR[0].redPlayerId as string
      let out = this.rows.filter(r => r.redPlayerId === pid || r.bluePlayerId === pid)
      const mode = args.where.mode
      if (mode !== undefined) {
        if (typeof mode === 'string') out = out.filter(r => r.mode === mode)
        else out = out.filter(r => r.mode !== mode.not)
      }
      if (args.orderBy?.endedAt === 'desc') {
        out = [...out].sort((a, b) => b.endedAt.getTime() - a.endedAt.getTime())
      }
      if (args.take !== undefined) out = out.slice(0, args.take)
      if (args.select) {
        return out.map(r => {
          const o: Record<string, unknown> = {}
          for (const k of Object.keys(args.select)) o[k] = (r as unknown as Record<string, unknown>)[k]
          return o
        })
      }
      return out
    }),
    create: vi.fn(async ({ data }: { data: Omit<MatchRow, 'id'> }) => {
      const row = { id: `m${++this.seq}`, ...data } as MatchRow
      this.rows.push(row)
      return row
    }),
  }

  /** 测试辅助：直接塞一行 */
  add(row: Omit<MatchRow, 'id'>): MatchRow {
    const full = { id: `m${++this.seq}`, ...row } as MatchRow
    this.rows.push(full)
    return full
  }
}

const t0 = new Date('2026-09-11T12:00:00Z')

/** 造一行对局记录的便捷工厂 */
function row(partial: Partial<MatchRow> & { redPlayerId: string; bluePlayerId: string }): Omit<MatchRow, 'id'> {
  return {
    redName: '红方',
    blueName: '蓝方',
    winnerSide: 'draw',
    reason: 'line',
    mode: 'pvp',
    createdAt: t0,
    endedAt: t0,
    ...partial,
  }
}

describe('GameStatsController（分模式战绩）', () => {
  let prisma: FakePrisma
  let controller: GameStatsController

  beforeEach(() => {
    prisma = new FakePrisma()
    controller = new GameStatsController(prisma as unknown as PrismaService)
  })

  describe('stats 分桶聚合', () => {
    it('真人+人机混合记录分别计入 pvp / ai 桶', async () => {
      prisma.add(row({ redPlayerId: 'u1', bluePlayerId: 'ai', winnerSide: 'red', mode: 'ai' }))
      prisma.add(row({ redPlayerId: 'u1', bluePlayerId: 'ai', winnerSide: 'blue', mode: 'ai' }))
      prisma.add(row({ redPlayerId: 'u1', bluePlayerId: 'ai', winnerSide: 'draw', reason: 'both_skip', mode: 'ai' }))
      prisma.add(row({ redPlayerId: 'u1', bluePlayerId: 'u2', winnerSide: 'red', mode: 'pvp' }))
      prisma.add(row({ redPlayerId: 'u2', bluePlayerId: 'u1', winnerSide: 'red', mode: 'pvp' }))
      const s = await controller.stats('u1')
      expect(s.pvp).toEqual({ wins: 1, losses: 1, draws: 0, total: 2 })
      expect(s.ai).toEqual({ wins: 1, losses: 1, draws: 1, total: 3 })
    })

    it('存量无 mode 记录（undefined/null）归入真人战绩（向后兼容）', async () => {
      prisma.add(row({ redPlayerId: 'u1', bluePlayerId: 'u2', winnerSide: 'red', mode: undefined }))
      prisma.add(row({ redPlayerId: 'u1', bluePlayerId: 'u2', winnerSide: 'red', mode: null }))
      const s = await controller.stats('u1')
      expect(s.pvp.total).toBe(2)
      expect(s.ai.total).toBe(0)
    })

    it('红蓝阵营判定：执红胜=win、执蓝对手胜=lose、draw=draw', async () => {
      prisma.add(row({ redPlayerId: 'u1', bluePlayerId: 'ai', winnerSide: 'red', mode: 'ai' }))
      prisma.add(row({ redPlayerId: 'ai', bluePlayerId: 'u1', winnerSide: 'red', mode: 'ai' }))
      prisma.add(row({ redPlayerId: 'ai', bluePlayerId: 'u1', winnerSide: 'draw', mode: 'ai' }))
      const s = await controller.stats('u1')
      expect(s.ai).toEqual({ wins: 1, losses: 1, draws: 1, total: 3 })
    })

    it('只统计本人参与的对局', async () => {
      prisma.add(row({ redPlayerId: 'u9', bluePlayerId: 'ai', winnerSide: 'red', mode: 'ai' }))
      const s = await controller.stats('u1')
      expect(s.pvp.total).toBe(0)
      expect(s.ai.total).toBe(0)
    })
  })

  describe('history 模式过滤与映射', () => {
    beforeEach(() => {
      prisma.add(row({
        redPlayerId: 'u1', bluePlayerId: 'u2', redName: '我', blueName: '路人',
        winnerSide: 'red', mode: 'pvp', endedAt: new Date('2026-09-11T10:00:00Z'),
      }))
      prisma.add(row({
        redPlayerId: 'u1', bluePlayerId: 'ai', redName: '我', blueName: '电脑',
        winnerSide: 'blue', reason: 'resign', mode: 'ai', endedAt: new Date('2026-09-11T11:00:00Z'),
      }))
      prisma.add(row({
        redPlayerId: 'u2', bluePlayerId: 'u1', redName: '旧局', blueName: '我',
        winnerSide: 'draw', reason: 'board_full', mode: undefined, endedAt: new Date('2026-09-10T09:00:00Z'),
      }))
    })

    it('缺省不过滤：返回全部模式（按时间倒序）', async () => {
      const h = await controller.history('u1')
      expect(h.items).toHaveLength(3)
      expect(h.items.map(i => i.reason)).toEqual(['resign', 'line', 'board_full'])
    })

    it('mode=ai：只返回人机局', async () => {
      const h = await controller.history('u1', undefined, 'ai')
      expect(h.items).toHaveLength(1)
      expect(h.items[0].mode).toBe('ai')
      expect(h.items[0].opponentName).toBe('电脑')
    })

    it('mode=pvp：返回非人机局（含存量无 mode 记录）', async () => {
      const h = await controller.history('u1', undefined, 'pvp')
      expect(h.items).toHaveLength(2)
      expect(h.items.every(i => i.mode !== 'ai')).toBe(true)
    })

    it('字段映射：mySide/opponentName/result/mode/endedAt（ISO）', async () => {
      const h = await controller.history('u1', undefined, 'ai')
      const item = h.items[0]
      expect(item.mySide).toBe('red')
      expect(item.opponentName).toBe('电脑')
      expect(item.result).toBe('lose')
      expect(item.reason).toBe('resign')
      expect(item.mode).toBe('ai')
      expect(item.endedAt).toBe(new Date('2026-09-11T11:00:00Z').toISOString())
    })

    it('limit 钳制：上限 50、下限 1', async () => {
      await controller.history('u1', '100')
      expect(prisma.match.findMany).toHaveBeenLastCalledWith(expect.objectContaining({ take: 50 }))
      await controller.history('u1', '-5')
      expect(prisma.match.findMany).toHaveBeenLastCalledWith(expect.objectContaining({ take: 1 }))
    })
  })

  describe('ai-result 人机对局上报', () => {
    it('mySide=red：玩家执红、AI 执蓝，mode=ai 落库', async () => {
      const r = await controller.reportAiResult({
        playerId: 'u1', playerName: '小明', mySide: 'red', winnerSide: 'red', reason: 'line',
      })
      expect(r.ok).toBe(true)
      expect(prisma.rows).toHaveLength(1)
      const m = prisma.rows[0]
      expect(m.redPlayerId).toBe('u1')
      expect(m.redName).toBe('小明')
      expect(m.bluePlayerId).toBe('ai')
      expect(m.blueName).toBe('电脑')
      expect(m.mode).toBe('ai')
      expect(m.winnerSide).toBe('red')
      expect(m.reason).toBe('line')
      expect(m.createdAt).toEqual(m.endedAt)
    })

    it('mySide=blue：玩家执蓝、AI 执红', async () => {
      await controller.reportAiResult({
        playerId: 'u1', playerName: '小明', mySide: 'blue', winnerSide: 'draw', reason: 'both_skip',
      })
      const m = prisma.rows[0]
      expect(m.redPlayerId).toBe('ai')
      expect(m.redName).toBe('电脑')
      expect(m.bluePlayerId).toBe('u1')
      expect(m.blueName).toBe('小明')
    })

    it('playerName 空/空白 → 默认"玩家"', async () => {
      await controller.reportAiResult({
        playerId: 'u1', playerName: '   ', mySide: 'red', winnerSide: 'red', reason: 'line',
      })
      expect(prisma.rows[0].redName).toBe('玩家')
    })

    it('上报后人机战绩立即可见（stats 联动）', async () => {
      await controller.reportAiResult({
        playerId: 'u1', playerName: '小明', mySide: 'red', winnerSide: 'red', reason: 'line',
      })
      const s = await controller.stats('u1')
      expect(s.ai).toEqual({ wins: 1, losses: 0, draws: 0, total: 1 })
      expect(s.pvp.total).toBe(0)
    })

    it('缺 playerId → 400', async () => {
      await expect(controller.reportAiResult({
        mySide: 'red', winnerSide: 'red', reason: 'line',
      })).rejects.toBeInstanceOf(BadRequestException)
    })

    it('mySide 非法 → 400', async () => {
      await expect(controller.reportAiResult({
        playerId: 'u1', mySide: 'green', winnerSide: 'red', reason: 'line',
      })).rejects.toBeInstanceOf(BadRequestException)
    })

    it('winnerSide 非法 → 400', async () => {
      await expect(controller.reportAiResult({
        playerId: 'u1', mySide: 'red', winnerSide: 'purple', reason: 'line',
      })).rejects.toBeInstanceOf(BadRequestException)
    })

    it('reason 非法（人机局不存在的 opponent_disconnect）→ 400', async () => {
      await expect(controller.reportAiResult({
        playerId: 'u1', mySide: 'red', winnerSide: 'red', reason: 'opponent_disconnect',
      })).rejects.toBeInstanceOf(BadRequestException)
      expect(prisma.rows).toHaveLength(0)
    })
  })
})
