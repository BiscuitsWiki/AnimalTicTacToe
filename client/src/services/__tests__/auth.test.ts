/**
 * 随机昵称单元测试（vitest）。
 * randomNickname 为纯本地拼接（不走网络），覆盖：
 * - 词表组合合法性（形容词+动物，48 种组合）
 * - 长度满足服务端昵称约束（1~12 字符）
 * - 可控随机下按索引取词（首项/末项边界）
 * - 多次采样覆盖全部形容词与动物（词表无死词）
 */
import { describe, expect, it, vi } from 'vitest'

// auth.ts 顶层 import 了 @tarojs/taro；randomNickname 不依赖它，stub 掉避免引入 H5 运行时
vi.mock('@tarojs/taro', () => ({
  default: {
    getStorageSync: () => '',
    setStorageSync: () => {},
    request: async () => { throw new Error('not used in unit test') },
  },
}))

import { randomNickname } from '../auth'

/** 与实现保持一致的词表镜像（镜像漂移会被"合法组合/全覆盖"用例捕获） */
const ADJECTIVES = ['机灵的', '勇敢的', '神秘的', '欢快的', '沉稳的', '悠闲的']
const ANIMALS = ['小狐狸', '小柴犬', '橘猫', '兔兔', '小熊', '水獭', '鹦鹉', '刺猬']
const ALL_NAMES = new Set(ADJECTIVES.flatMap(a => ANIMALS.map(b => a + b)))

describe('randomNickname 随机昵称', () => {
  it('返回词表内的合法组合（形容词+动物）', () => {
    for (let i = 0; i < 200; i++) {
      expect(ALL_NAMES.has(randomNickname())).toBe(true)
    }
  })

  it('长度满足昵称约束（1~12 字符）', () => {
    for (let i = 0; i < 100; i++) {
      const len = randomNickname().length
      expect(len).toBeGreaterThanOrEqual(1)
      expect(len).toBeLessThanOrEqual(12)
    }
  })

  it('可控随机：Math.random=0 → 词表首项拼接', () => {
    vi.spyOn(Math, 'random').mockReturnValue(0)
    expect(randomNickname()).toBe(`${ADJECTIVES[0]}${ANIMALS[0]}`)
    vi.restoreAllMocks()
  })

  it('可控随机：Math.random→1 → 词表末项拼接（floor 边界）', () => {
    vi.spyOn(Math, 'random').mockReturnValue(0.999999)
    expect(randomNickname()).toBe(
      `${ADJECTIVES[ADJECTIVES.length - 1]}${ANIMALS[ANIMALS.length - 1]}`,
    )
    vi.restoreAllMocks()
  })

  it('多次采样覆盖全部形容词与动物（词表无死词）', () => {
    const seenA = new Set<string>()
    const seenB = new Set<string>()
    for (let i = 0; i < 1000; i++) {
      const name = randomNickname()
      const a = ADJECTIVES.find(x => name.startsWith(x))
      const b = ANIMALS.find(x => name.endsWith(x))
      expect(a).toBeTruthy()
      expect(b).toBeTruthy()
      seenA.add(a!)
      seenB.add(b!)
    }
    // 1000 次采样下漏掉任一词的概率 < 1e-50，断言稳定
    expect(seenA.size).toBe(ADJECTIVES.length)
    expect(seenB.size).toBe(ANIMALS.length)
  })
})
