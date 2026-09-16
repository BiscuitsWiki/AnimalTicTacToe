/**
 * 工坊/后台共用的分类与检索逻辑（纯函数，便于单测）：
 * 同名卡牌本质上是同一张卡 —— 按卡牌聚合展示；检索按属性，主/副任一命中，组合为无序匹配。
 */
import { ELEMENT_NAMES_ZH } from '../../core/elements'

/** 属性中文文案（如 火 / 火+萌） */
export function elementLabel(element: string, element2?: string | null): string {
  const zh = (e: string) => (ELEMENT_NAMES_ZH as Record<string, string>)[e] ?? e
  return element2 ? `${zh(element)}/${zh(element2)}` : zh(element)
}

/** 皮肤行（含所属卡牌的名称与属性） */
export interface SkinLike {
  cardId?: string
  name: string
  element: string
  element2?: string | null
}

/** 一张卡牌及其皮肤 */
export interface CardGroup<T extends SkinLike> {
  /** 分组键：卡牌 id（缺省时退化为名称） */
  key: string
  name: string
  element: string
  element2?: string | null
  skins: T[]
}

/** 属性集合（去重，副属性与主属性相同按单属性处理） */
export function elementsOf(skin: SkinLike): string[] {
  return skin.element2 && skin.element2 !== skin.element ? [skin.element, skin.element2] : [skin.element]
}

/**
 * 检索：所选属性为空 = 全部；否则卡牌需包含全部所选属性（无序组合，主/副任一命中）。
 * 例：选「火」→ 炎尾狐(火)、治愈兔(火/萌)、熔岩布丁(水/火) 均命中；再选「萌」→ 仅 治愈兔。
 */
export function matchElements(skin: SkinLike, selected: string[]): boolean {
  if (selected.length === 0) return true
  const els = elementsOf(skin)
  return selected.every(el => els.includes(el))
}

/** 选择栏点击：已选则取消；未选则追加（最多 2 个属性，超出时滑动替换最早的一个） */
export function toggleElement(selected: string[], el: string): string[] {
  if (selected.includes(el)) return selected.filter(x => x !== el)
  const next = [...selected, el]
  return next.length > 2 ? next.slice(next.length - 2) : next
}

/** 检索 + 按卡牌聚合（同名即同一张卡） */
export function groupSkinsByCard<T extends SkinLike>(skins: T[], selected: string[] = []): CardGroup<T>[] {
  const groups = new Map<string, CardGroup<T>>()
  for (const skin of skins) {
    if (!matchElements(skin, selected)) continue
    const key = skin.cardId ?? `name:${skin.name}`
    const group = groups.get(key)
    if (group) {
      group.skins.push(skin)
      continue
    }
    groups.set(key, {
      key,
      name: skin.name,
      element: skin.element,
      element2: skin.element2,
      skins: [skin],
    })
  }
  return [...groups.values()]
}