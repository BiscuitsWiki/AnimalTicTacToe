/**
 * 工坊分类与检索逻辑测试：主/副任一命中、组合无序匹配、属性选择切换、按卡牌聚合（同名即同一张卡）。
 */
import { describe, expect, it } from 'vitest'
import { elementLabel, elementsOf, groupSkinsByCard, matchElements, toggleElement } from '../filter'

const fox = { id: 's1', cardId: 'c-fox', name: '炎尾狐', element: 'fire', element2: null }
const foxSkin2 = { id: 's2', cardId: 'c-fox', name: '炎尾狐', element: 'fire', element2: null }
const rabbit = { id: 's3', cardId: 'c-rabbit', name: '治愈兔', element: 'fire', element2: 'cute' }
const pudding = { id: 's4', cardId: 'c-pudding', name: '熔岩布丁', element: 'water', element2: 'fire' }
const list = [fox, foxSkin2, rabbit, pudding]

describe('属性检索', () => {
  it('空选择 = 全部', () => {
    expect(list.filter(s => matchElements(s, []))).toHaveLength(4)
  })

  it('单属性：主/副任一命中（火 → 炎尾狐、治愈兔、熔岩布丁）', () => {
    const names = list.filter(s => matchElements(s, ['fire'])).map(s => s.name)
    expect(names).toEqual(['炎尾狐', '炎尾狐', '治愈兔', '熔岩布丁'])
  })

  it('双属性组合：需全部命中且无序（火+萌 ≡ 萌+火；水+火 → 熔岩布丁）', () => {
    expect(list.filter(s => matchElements(s, ['fire', 'cute'])).map(s => s.name)).toEqual(['治愈兔'])
    expect(list.filter(s => matchElements(s, ['cute', 'fire'])).map(s => s.name)).toEqual(['治愈兔'])
    expect(list.filter(s => matchElements(s, ['water', 'fire'])).map(s => s.name)).toEqual(['熔岩布丁'])
  })

  it('组合未命中任何卡牌（火+幽）', () => {
    expect(list.filter(s => matchElements(s, ['fire', 'ghost']))).toHaveLength(0)
  })

  it('属性集合去重：副属性与主属性相同按单属性处理', () => {
    expect(elementsOf({ name: 'x', element: 'fire', element2: 'fire' })).toEqual(['fire'])
    expect(elementsOf({ name: 'x', element: 'fire', element2: 'cute' })).toEqual(['fire', 'cute'])
  })

  it('选择切换：已选取消；最多 2 个，超出时滑动替换最早的', () => {
    expect(toggleElement([], 'fire')).toEqual(['fire'])
    expect(toggleElement(['fire'], 'water')).toEqual(['fire', 'water'])
    expect(toggleElement(['fire', 'water'], 'grass')).toEqual(['water', 'grass'])
    expect(toggleElement(['fire', 'water'], 'fire')).toEqual(['water'])
  })

  it('按卡牌聚合：同名（同 cardId）的皮肤归到一组并带上卡牌属性', () => {
    const groups = groupSkinsByCard(list)
    expect(groups.map(g => g.name)).toEqual(['炎尾狐', '治愈兔', '熔岩布丁'])
    expect(groups[0].skins).toHaveLength(2)
    expect(groups[0].key).toBe('c-fox')
    expect(groups[1]).toMatchObject({ element: 'fire', element2: 'cute' })
  })

  it('聚合 + 检索：筛选后仅保留命中的卡牌分组', () => {
    const groups = groupSkinsByCard(list, ['cute'])
    expect(groups.map(g => g.name)).toEqual(['治愈兔'])
    expect(groups[0].skins).toHaveLength(1)
  })

  it('缺少 cardId 时以名称作为分组键（兼容旧数据）', () => {
    const groups = groupSkinsByCard([{ id: 'x1', name: '无卡 id', element: 'fire' }])
    expect(groups[0].key).toBe('name:无卡 id')
  })

  it('属性文案：单属性 / 双属性', () => {
    expect(elementLabel('fire')).toBe('火')
    expect(elementLabel('fire', 'cute')).toBe('火/萌')
  })
})