/**
 * 洛克王国 18 属性体系。
 * 属性名与克制关系参照《洛克王国：世界》18 派系（玩法规则不受版权保护），棋子形象与命名全部自创。
 * 倍率体系（2026-09-17 对齐官方《洛克王国：世界》系别表，数据来源：BWiki 系别关系模块）：
 * 克制 2x 与抵抗 0.5x 是两张**独立**的表——官方抵抗表并非克制表的镜像推导，
 * 含非镜像抵抗（如 萌攻火、幽攻普、龙攻火）与同属性互抗（冰/电/毒/恶/机械/幻 攻自身 0.5x）；
 * 同属性：冰/电/毒/恶/机械/幻 互抗 0.5x，龙/幽 自身互克 2x（克制优先），其余 1x。
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
  bug: '虫', dragon: '龙', dark: '恶', ghost: '幽', normal: '普', martial: '武',
  earth: '地', wing: '翼', illusion: '幻', light: '光', machine: '机', cute: '萌',
}

/** 属性主题色（UI 展示用，对照《洛克王国：世界》官方派系色） */
export const ELEMENT_COLORS: Record<Element, string> = {
  fire: '#db5525', water: '#6aa9fe', grass: '#4ebc73', electric: '#e7c506', ice: '#5faddd',
  poison: '#ba62e0', bug: '#94c11f', dragon: '#ed4962', dark: '#cf467a', ghost: '#9446ec',
  normal: '#3f89b4', martial: '#ff9636', earth: '#9a7e3f', wing: '#3ec7ca', illusion: '#9198e2',
  light: '#4fc0ff', machine: '#40cba9', cute: '#fc7cac',
}

/**
 * 克制表（官方「克制」列表）：CHART[攻击方][防守方] -> 2（克制），未列出 = 无克制关系。
 * 克制的 2x 关系与官方表逐格一致（已用全表快照单测守护）。
 * 对照《洛克王国：世界》18 派系克制关系：
 * 草克水/地/光；火克草/冰/虫/机械；水克火/地/机械；电克水/翼；冰克草/地/翼/龙；
 * 毒克草/萌；虫克草/恶/幻；龙克龙；恶克毒/幽/萌；幽克光/幽/幻；普通不克任何属性；
 * 武克普通/地/冰/恶/机械；地克火/冰/电/毒；翼克草/虫/武；幻克毒/武；光克幽/恶；
 * 机械克地/冰/萌；萌克龙/武/恶。
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
 * 抵抗表（官方「被抵抗」列表）：RESIST[攻击方][防守方] = 0.5（进攻被抵抗，受击减半）。
 * 与克制表独立——官方表中存在不互克的抵抗（如 萌攻火、幽攻普、龙攻机械、翼攻地）。
 * 同属性互抗只出现在 冰/电/毒/恶/机械/幻（表内自身项），龙/幽 走克制表的自身 2x。
 */
const RESIST: Record<Element, Partial<Record<Element, number>>> = {
  normal:   { earth: 0.5, ghost: 0.5, machine: 0.5 },
  grass:    { machine: 0.5, poison: 0.5, fire: 0.5, wing: 0.5, bug: 0.5, dragon: 0.5 },
  fire:     { earth: 0.5, water: 0.5, dragon: 0.5 },
  water:    { ice: 0.5, grass: 0.5, dragon: 0.5 },
  light:    { ice: 0.5, grass: 0.5 },
  earth:    { martial: 0.5, grass: 0.5 },
  ice:      { ice: 0.5, machine: 0.5, fire: 0.5 },
  dragon:   { machine: 0.5 },
  electric: { earth: 0.5, electric: 0.5, grass: 0.5, dragon: 0.5 },
  poison:   { earth: 0.5, ghost: 0.5, machine: 0.5, poison: 0.5 },
  bug:      { ghost: 0.5, machine: 0.5, martial: 0.5, poison: 0.5, fire: 0.5, wing: 0.5, cute: 0.5 },
  martial:  { illusion: 0.5, ghost: 0.5, poison: 0.5, wing: 0.5, cute: 0.5, bug: 0.5 },
  wing:     { earth: 0.5, machine: 0.5, electric: 0.5, dragon: 0.5 },
  cute:     { machine: 0.5, poison: 0.5, fire: 0.5 },
  ghost:    { dark: 0.5, normal: 0.5 },
  dark:     { light: 0.5, dark: 0.5, martial: 0.5 },
  machine:  { machine: 0.5, water: 0.5, fire: 0.5, electric: 0.5 },
  illusion: { light: 0.5, illusion: 0.5, machine: 0.5 },
}

/**
 * 单属性对单属性的进攻倍率（与官方系别表逐格一致）：
 * - 攻击方克防守方 → 2（含龙/幽自身互克；克制优先于同格的抵抗判定）
 * - 攻击方被防守方抵抗 → 0.5（官方抵抗表，含冰/电/毒/恶/机械/幻 的同属性互抗）
 * - 其余 → 1
 */
export function effectiveness(atk: Element, def: Element): number {
  if (CHART[atk][def] === 2) return 2
  if (RESIST[atk][def] === 0.5) return 0.5
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
 * 例：翼+水 攻 火+草 → 翼 1×2=2，水 2×0.5=1 → 取 2（翼更优）可占领。
 * 例：火+水 攻 火+草 → 火 1×2=2（火攻火官方为中性），水 2×0.5=1 → 取 2 可占领。
 * 倍率 > 1 即克制，≤ 1（含抵抗抵消、同属性互抗、双向抵抗）不属于克制。
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
