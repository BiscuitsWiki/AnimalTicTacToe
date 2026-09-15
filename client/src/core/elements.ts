/**
 * 洛克王国 18 属性体系。
 * 属性名与克制关系参照《洛克王国：世界》18 派系（玩法规则不受版权保护），棋子形象与命名全部自创。
 * 倍率体系：克制 = 2x；抵抗 = 0.5x（A 克 B 时，B 攻击 A 被减半抵抗）；
 * 互克对（龙/龙、幽/幽、光↔幽、冰↔地、恶↔萌）双向均按 2x（克制优先于抵抗）；其余 1x。
 * 棋子支持双属性（主 + 可选副）：进攻方从双属性中择优，防守方双属性连乘（见 captureMultiplier）。
 */

export type Element =
  | 'fire' | 'water' | 'grass' | 'electric' | 'ice' | 'poison' | 'bug' | 'dragon'
  | 'dark' | 'ghost' | 'normal' | 'martial' | 'earth' | 'wing' | 'illusion' | 'light'
  | 'machine' | 'cute'

export const ELEMENTS: Element[] = [
  'fire', 'water', 'grass', 'electric', 'ice', 'poison', 'bug', 'dragon',
  'dark', 'ghost', 'normal', 'martial', 'earth', 'wing', 'illusion', 'light',
  'machine', 'cute',
]

/** 中文属性名（UI 展示用） */
export const ELEMENT_NAMES_ZH: Record<Element, string> = {
  fire: '火', water: '水', grass: '草', electric: '电', ice: '冰', poison: '毒',
  bug: '虫', dragon: '龙', dark: '恶', ghost: '幽', normal: '普通', martial: '武',
  earth: '地', wing: '翼', illusion: '幻', light: '光', machine: '机械', cute: '萌',
}

/** 属性主题色（UI 展示用，对照《洛克王国：世界》官方派系色） */
export const ELEMENT_COLORS: Record<Element, string> = {
  fire: '#db5525', water: '#6aa9fe', grass: '#4ebc73', electric: '#e7c506', ice: '#5faddd',
  poison: '#ba62e0', bug: '#94c11f', dragon: '#ed4962', dark: '#cf467a', ghost: '#9446ec',
  normal: '#3f89b4', martial: '#ff9636', earth: '#9a7e3f', wing: '#3ec7ca', illusion: '#9198e2',
  light: '#4fc0ff', machine: '#40cba9', cute: '#fc7cac',
}

/**
 * 克制表：CHART[攻击方][防守方] -> 2（克制），未列出 = 无克制关系。
 * 对照《洛克王国：世界》18 派系克制关系：
 * 火克草/冰/虫/机械；水克火/地/机械；草克水/光/地；电克水/翼；冰克草/地/龙/翼；
 * 毒克草/萌；虫克草/恶/幻；龙克龙；恶克毒/萌/幽；幽克光/幽/幻；普通不克制任何属性；
 * 武克普通/地/冰/恶/机械；地克火/冰/电/毒；翼克草/虫/武；幻克毒/武；光克幽/恶；
 * 机械克地/冰/萌；萌克龙/武/恶。
 * 抵抗关系由克制表镜像推导：A 克 B ⟹ B 攻击 A 为 0.5x（见 effectiveness）。
 */
const CHART: Record<Element, Partial<Record<Element, number>>> = {
  fire:     { grass: 2, ice: 2, bug: 2, machine: 2 },
  water:    { fire: 2, earth: 2, machine: 2 },
  grass:    { water: 2, light: 2, earth: 2 },
  electric: { water: 2, wing: 2 },
  ice:      { grass: 2, earth: 2, dragon: 2, wing: 2 },
  poison:   { grass: 2, cute: 2 },
  bug:      { grass: 2, dark: 2, illusion: 2 },
  dragon:   { dragon: 2 },
  dark:     { poison: 2, cute: 2, ghost: 2 },
  ghost:    { light: 2, ghost: 2, illusion: 2 },
  normal:   {},
  martial:  { normal: 2, earth: 2, ice: 2, dark: 2, machine: 2 },
  earth:    { fire: 2, ice: 2, electric: 2, poison: 2 },
  wing:     { grass: 2, bug: 2, martial: 2 },
  illusion: { poison: 2, martial: 2 },
  light:    { ghost: 2, dark: 2 },
  machine:  { earth: 2, ice: 2, cute: 2 },
  cute:     { dragon: 2, martial: 2, dark: 2 },
}

/**
 * 单属性对单属性的进攻倍率：
 * - 攻击方克防守方 → 2（互克对双向均为 2，克制优先于抵抗）
 * - 防守方克攻击方 → 0.5（进攻被抵抗，受击减半）
 * - 其余 → 1
 */
export function effectiveness(atk: Element, def: Element): number {
  if (CHART[atk][def] === 2) return 2
  if (CHART[def][atk] === 2) return 0.5
  return 1
}

/** 双属性载体（判定所需最小结构；Piece 结构性兼容，避免与 types.ts 循环依赖） */
export interface ElementProfile {
  element: Element
  /** 副属性（可选）：进攻择优、防守连乘；与主属性相同时按单属性处理 */
  element2?: Element
}

/** 棋子的有效属性列表（去重，恒至少 1 项） */
function elementsOf(p: ElementProfile): Element[] {
  return p.element2 && p.element2 !== p.element
    ? [p.element, p.element2]
    : [p.element]
}

/**
 * 双属性进攻倍率（叠放占领判定基础）：
 * 进攻方从主/副属性中选择进攻优势更大的一者，对防守方两个属性分别计算倍率后连乘。
 * 例：翼+水 攻 火+草 → 翼 1×2=2，水 2×0.5=1 → 取 2（翼更优）。
 * 倍率 > 1 即克制，≤ 1（含抵抗抵消、双向抵抗）不属于克制。
 */
export function captureMultiplier(atk: ElementProfile, def: ElementProfile): number {
  const defEls = elementsOf(def)
  let best = 0
  for (const a of elementsOf(atk)) {
    let m = 1
    for (const d of defEls) m *= effectiveness(a, d)
    if (m > best) best = m
  }
  return best
}

/** 叠放占领判定：进攻方（双属性择优）对防守方（双属性连乘）倍率 > 1 才可叠放占领 */
export function canCapture(atk: ElementProfile, def: ElementProfile): boolean {
  return captureMultiplier(atk, def) > 1
}
