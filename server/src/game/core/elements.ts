/**
 * 宝可梦式 18 属性体系。
 * 属性名与克制关系参照宝可梦（玩法层面不受版权保护），我方棋子形象全部自创。
 */

export type Element =
  | 'fire' | 'water' | 'grass' | 'electric' | 'ice' | 'fighting' | 'poison' | 'ground'
  | 'flying' | 'psychic' | 'bug' | 'rock' | 'ghost' | 'dragon' | 'dark' | 'steel'
  | 'fairy' | 'normal'

export const ELEMENTS: Element[] = [
  'fire', 'water', 'grass', 'electric', 'ice', 'fighting', 'poison', 'ground',
  'flying', 'psychic', 'bug', 'rock', 'ghost', 'dragon', 'dark', 'steel',
  'fairy', 'normal',
]

/** 中文属性名（UI 展示用） */
export const ELEMENT_NAMES_ZH: Record<Element, string> = {
  fire: '火', water: '水', grass: '草', electric: '电', ice: '冰', fighting: '格斗',
  poison: '毒', ground: '地面', flying: '飞行', psychic: '超能', bug: '虫', rock: '岩石',
  ghost: '幽灵', dragon: '龙', dark: '恶', steel: '钢', fairy: '妖精', normal: '一般',
}

/** 属性主题色（UI 展示用） */
export const ELEMENT_COLORS: Record<Element, string> = {
  fire: '#f0803c', water: '#4f90e0', grass: '#5cb85c', electric: '#e8c531', ice: '#6fc7d4',
  fighting: '#d05048', poison: '#a050a8', ground: '#cfa452', flying: '#8f92e0',
  psychic: '#f06a92', bug: '#9ab028', rock: '#b0a048', ghost: '#7060a0', dragon: '#6858d8',
  dark: '#6f5a48', steel: '#8a97ad', fairy: '#ee9ab4', normal: '#a0a090',
}

/**
 * 克制倍率表：CHART[攻击方][防守方] -> 倍率（仅列出非 1x 关系，未列出 = 1x）。
 * 完整对照宝可梦第六世代起的 18 属性克制表。
 * 本游戏的占领判定只看倍率是否 > 1（canCapture），与具体数值无关。
 */
const CHART: Record<Element, Partial<Record<Element, number>>> = {
  normal:   { rock: 0.5, steel: 0.5, ghost: 0 },
  fire:     { grass: 2, ice: 2, bug: 2, steel: 2, fire: 0.5, water: 0.5, rock: 0.5, dragon: 0.5 },
  water:    { fire: 2, ground: 2, rock: 2, water: 0.5, grass: 0.5, dragon: 0.5 },
  electric: { water: 2, flying: 2, grass: 0.5, electric: 0.5, dragon: 0.5, ground: 0 },
  grass:    { water: 2, ground: 2, rock: 2, fire: 0.5, grass: 0.5, poison: 0.5, flying: 0.5, bug: 0.5, dragon: 0.5, steel: 0.5 },
  ice:      { grass: 2, ground: 2, flying: 2, dragon: 2, fire: 0.5, water: 0.5, ice: 0.5, steel: 0.5 },
  fighting: { normal: 2, ice: 2, rock: 2, dark: 2, steel: 2, poison: 0.5, flying: 0.5, psychic: 0.5, bug: 0.5, fairy: 0.5, ghost: 0 },
  poison:   { grass: 2, fairy: 2, poison: 0.5, ground: 0.5, rock: 0.5, ghost: 0.5, steel: 0 },
  ground:   { fire: 2, electric: 2, poison: 2, rock: 2, steel: 2, grass: 0.5, bug: 0.5, flying: 0 },
  flying:   { grass: 2, fighting: 2, bug: 2, electric: 0.5, rock: 0.5, steel: 0.5 },
  psychic:  { fighting: 2, poison: 2, psychic: 0.5, steel: 0.5, dark: 0 },
  bug:      { grass: 2, psychic: 2, dark: 2, fire: 0.5, fighting: 0.5, poison: 0.5, flying: 0.5, ghost: 0.5, steel: 0.5, fairy: 0.5 },
  rock:     { fire: 2, ice: 2, flying: 2, bug: 2, fighting: 0.5, ground: 0.5, steel: 0.5 },
  ghost:    { psychic: 2, ghost: 2, dark: 0.5, normal: 0 },
  dragon:   { dragon: 2, steel: 0.5, fairy: 0 },
  dark:     { psychic: 2, ghost: 2, fighting: 0.5, dark: 0.5, fairy: 0.5 },
  steel:    { ice: 2, rock: 2, fairy: 2, fire: 0.5, water: 0.5, electric: 0.5, steel: 0.5 },
  fairy:    { fighting: 2, dragon: 2, dark: 2, fire: 0.5, poison: 0.5, steel: 0.5 },
}

/** 攻击属性对防守属性的克制倍率，未声明的关系为 1x */
export function effectiveness(atk: Element, def: Element): number {
  return CHART[atk][def] ?? 1
}

/** 叠放占领判定：只有倍率 > 1（克制）才可以叠放占领对方格子 */
export function canCapture(atk: Element, def: Element): boolean {
  return effectiveness(atk, def) > 1
}
