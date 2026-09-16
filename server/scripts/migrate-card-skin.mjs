#!/usr/bin/env node
/**
 * 卡牌/皮肤数据迁移（Piece -> Skin + 新增 Card），幂等可重复执行。
 *
 * 背景：同名卡牌本质上是同一张卡（Card：cardName 唯一、属性由卡持有），
 * 图片/审核/下架/举报降级为皮肤（Skin：skinId 主键、cardId 外键）。
 *
 * 执行流程（单条命令，步骤内部自洽）：
 *   1. 导出：读取遗留表 Piece / PieceReport 到内存，并落一份 .migration-backup.json 备份
 *   2. 结构：prisma db push 按新 schema 建 Card / Skin / SkinReport
 *           （有遗留数据时带 --accept-data-loss：旧表不在新 schema 中会被丢弃，数据已备份）
 *   3. 归并：按 name 归并为 Card，皮肤行挂 cardId；同名不同属性的皮肤自动驳回并写入原因
 *   4. 清理：备份文件删除（失败时保留并在日志中提示路径）
 *
 * 用法：
 *   node scripts/migrate-card-skin.mjs --dry-run   # 仅预览：输出将执行的步骤与归并/冲突清单（不写库、不落备份）
 *   node scripts/migrate-card-skin.mjs             # 实际迁移
 */
import { spawnSync } from 'node:child_process'
import { existsSync, rmSync, writeFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { PrismaClient } from '@prisma/client'

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..')
const BACKUP_FILE = join(ROOT, '.migration-backup.json')
const DRY_RUN = process.argv.includes('--dry-run')

/** 同名不同属性的皮肤：驳回原因（与管理端文案一致） */
const CONFLICT_REASON = '与同名卡牌属性不一致，请修改名称或属性后重新提交'

const prisma = new PrismaClient()

async function tableExists(name) {
  const rows = await prisma.$queryRawUnsafe(
    `SELECT name FROM sqlite_master WHERE type = 'table' AND name = ?`, name,
  )
  return rows.length > 0
}

/** 结构同步：prisma db push（有遗留数据时旧表会被丢弃，故需 --accept-data-loss） */
function dbPush(acceptDataLoss) {
  const args = ['exec', 'prisma', 'db', 'push', '--skip-generate']
  if (acceptDataLoss) args.push('--accept-data-loss')
  const isWin = process.platform === 'win32'
  const cmd = isWin ? 'pnpm.cmd' : 'pnpm'
  let res = spawnSync(cmd, args, { cwd: ROOT, stdio: 'inherit', shell: isWin })
  if (res.error || res.status !== 0) {
    res = spawnSync(isWin ? 'npx.cmd' : 'npx', ['prisma', ...args.slice(1)], {
      cwd: ROOT, stdio: 'inherit', shell: isWin,
    })
  }
  if (res.status !== 0) throw new Error('prisma db push 失败，迁移中止')
}

/** 导出遗留数据（Piece 时代）；无遗留表返回 null */
async function exportLegacy() {
  const hasPiece = await tableExists('Piece')
  if (!hasPiece) return null
  const pieces = await prisma.$queryRawUnsafe(
    `SELECT id, name, element, element2, imageUrl, status, rejectReason, reportCount,
            authorId, recycledAt, createdAt, updatedAt
       FROM "Piece" ORDER BY createdAt ASC`,
  )
  const reports = (await tableExists('PieceReport'))
    ? await prisma.$queryRawUnsafe(
      `SELECT id, pieceId, reporterId, matchId, reason, createdAt FROM "PieceReport"`,
    )
    : []
  return { pieces, reports }
}

/** 属性组合是否相同（主/副顺序无关：进攻择优、防守连乘均与顺序无关） */
function sameElementCombo(a, b) {
  const combo = x => [x.element, ...(x.element2 ? [x.element2] : [])].sort().join('|')
  return combo(a) === combo(b)
}

/** 按名称归并：最早的皮肤行作为卡牌属性权威 */
function plan(legacy) {
  const groups = new Map()
  for (const r of legacy.pieces) {
    const name = String(r.name ?? '').trim()
    if (!groups.has(name)) groups.set(name, [])
    groups.get(name).push(r)
  }
  const conflicts = []
  for (const [name, list] of groups) {
    const head = list[0]
    for (const r of list.slice(1)) {
      if (!sameElementCombo(r, head)) {
        conflicts.push({
          name,
          skinId: r.id,
          element: r.element,
          element2: r.element2 ?? null,
          cardElement: head.element,
          cardElement2: head.element2 ?? null,
        })
      }
    }
  }
  return { groups, conflicts }
}

/** 写入 Card / Skin / SkinReport */
async function apply(legacy) {
  const { groups, conflicts } = plan(legacy)
  const conflictIds = new Set(conflicts.map(c => c.skinId))

  for (const [name, list] of groups) {
    const head = list[0]
    const card = await prisma.card.create({
      data: {
        cardName: name,
        element: head.element,
        element2: head.element2 ?? null,
        source: 'workshop',
        createdAt: new Date(head.createdAt),
      },
    })
    for (const r of list) {
      const conflict = conflictIds.has(r.id)
      await prisma.skin.create({
        data: {
          skinId: r.id,
          cardId: card.cardId,
          imageUrl: r.imageUrl,
          status: conflict ? 'rejected' : r.status,
          rejectReason: conflict ? CONFLICT_REASON : (r.rejectReason ?? null),
          reportCount: r.reportCount ?? 0,
          authorId: r.authorId ?? 'guest',
          recycledAt: r.recycledAt ? new Date(r.recycledAt) : null,
          createdAt: new Date(r.createdAt),
          updatedAt: new Date(r.updatedAt),
        },
      })
    }
  }
  for (const r of legacy.reports) {
    await prisma.skinReport.create({
      data: {
        id: r.id,
        skinId: r.pieceId,
        reporterId: r.reporterId,
        matchId: r.matchId ?? null,
        reason: r.reason,
        createdAt: new Date(r.createdAt),
      },
    })
  }
  return { cardCount: groups.size, skinCount: legacy.pieces.length, conflictCount: conflicts.length, conflicts }
}

async function main() {
  console.log(DRY_RUN ? '=== 迁移预览（dry-run，不写库） ===' : '=== 卡牌/皮肤数据迁移 ===')
  const legacy = await exportLegacy()
  if (!legacy) {
    console.log('[1/4] 无遗留数据（Piece 表不存在），仅同步表结构')
    if (!DRY_RUN) {
      dbPush(false)
      console.log('[2/4] 结构已同步（Card / Skin / SkinReport）')
    }
    console.log(DRY_RUN ? '=== 预览结束（未做任何改动） ===' : '=== 迁移完成 ===')
    return
  }

  const { groups, conflicts } = plan(legacy)
  console.log(`[1/4] 遗留数据：${groups.size} 张卡牌 / ${legacy.pieces.length} 个皮肤 / ${legacy.reports.length} 条举报`)
  if (conflicts.length > 0) {
    console.warn(`      同名不同属性待驳回 ${conflicts.length} 个：`)
    for (const c of conflicts) {
      console.warn(`      - 「${c.name}」${c.element}${c.element2 ? `+${c.element2}` : ''}（卡牌属性权威：${c.cardElement}${c.cardElement2 ? `+${c.cardElement2}` : ''}）`)
    }
  }
  if (DRY_RUN) {
    console.log('[2/4] 将执行 prisma db push --accept-data-loss 建 Card / Skin / SkinReport（旧表丢弃）')
    console.log('[3/4] 将按名称归并卡牌与皮肤（冲突皮肤自动驳回）')
    console.log('=== 预览结束（未做任何改动） ===')
    return
  }

  writeFileSync(BACKUP_FILE, JSON.stringify(legacy, null, 2), 'utf8')
  console.log(`[1/4] 已备份遗留数据 -> ${BACKUP_FILE}`)

  dbPush(true)
  console.log('[2/4] 结构已同步（Card / Skin / SkinReport）')

  const res = await apply(legacy)
  console.log(`[3/4] 归并完成：${res.cardCount} 张卡牌 / ${res.skinCount} 个皮肤（驳回 ${res.conflictCount} 个）`)

  rmSync(BACKUP_FILE, { force: true })
  console.log('[4/4] 备份文件已清理')
  console.log('=== 迁移完成 ===')
}

main()
  .catch(e => {
    console.error(`迁移失败：${e?.message ?? e}`)
    if (!DRY_RUN && existsSync(BACKUP_FILE)) {
      console.error(`遗留数据备份保留在：${BACKUP_FILE}（重跑本脚本前可从中恢复）`)
    }
    process.exitCode = 1
  })
  .finally(() => prisma.$disconnect())