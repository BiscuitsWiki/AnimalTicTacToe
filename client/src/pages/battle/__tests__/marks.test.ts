/**
 * "最近一手"标记判定单元测试（vitest）。
 * 核心回归：盖住对方最近一手 → 双方标记落在同一格（lastBoth），
 * 渲染层据此错开角标（红左上/蓝左下）并显示红蓝双环光晕。
 */
import { describe, expect, it } from 'vitest'
import { lastMarks } from '../marks'
import type { Side } from '../../../core/types'

const L = (red: number | null, blue: number | null): Record<Side, number | null> => ({ red, blue })

describe('lastMarks 最近一手标记判定', () => {
  it('开局双方未落子：任何格都无标记', () => {
    const lp = L(null, null)
    for (let idx = 0; idx < 9; idx++) {
      expect(lastMarks(lp, idx)).toEqual({ isLastRed: false, isLastBlue: false, lastBoth: false })
    }
  })

  it('仅红方最近一手', () => {
    expect(lastMarks(L(3, null), 3)).toEqual({ isLastRed: true, isLastBlue: false, lastBoth: false })
  })

  it('仅蓝方最近一手', () => {
    expect(lastMarks(L(null, 5), 5)).toEqual({ isLastRed: false, isLastBlue: true, lastBoth: false })
  })

  it('盖住对方最近一手：双方标记同格 → lastBoth（本次修复核心场景）', () => {
    expect(lastMarks(L(4, 4), 4)).toEqual({ isLastRed: true, isLastBlue: true, lastBoth: true })
  })

  it('双方标记在不同格：各自单侧标记，lastBoth 恒 false', () => {
    const lp = L(2, 6)
    for (let idx = 0; idx < 9; idx++) {
      const m = lastMarks(lp, idx)
      expect(m.lastBoth).toBe(false)
      expect(m.isLastRed).toBe(idx === 2)
      expect(m.isLastBlue).toBe(idx === 6)
    }
  })

  it('同格交锋后红方落向他处：原格只剩蓝标记（标记分离）', () => {
    const lp = L(1, 4)   // 原同格 4，红方移到 1
    expect(lastMarks(lp, 4)).toEqual({ isLastRed: false, isLastBlue: true, lastBoth: false })
    expect(lastMarks(lp, 1)).toEqual({ isLastRed: true, isLastBlue: false, lastBoth: false })
  })
})
