/**
 * 本地预设棋子池（离线/工坊池不足时的兜底牌堆）。
 * 从 client/src/core/pieces.ts 同步拷贝（服务端权威裁决）。
 * 共 36 张：18 属性 × 各 2 张，保证克制关系完整覆盖。
 */
import type { Piece } from './types.js'
import { shuffle } from './engine.js'

export const PRESET_DECK: Piece[] = [
  { id: 'd01', name: '炎尾狐', element: 'fire' },
  { id: 'd02', name: '熔岩龟', element: 'fire' },
  { id: 'd03', name: '水沫蛙', element: 'water' },
  { id: 'd04', name: '潮汐鲤', element: 'water' },
  { id: 'd05', name: '叶刃虫', element: 'grass' },
  { id: 'd06', name: '藤蔓蛇', element: 'grass' },
  { id: 'd07', name: '电光鼠', element: 'electric' },
  { id: 'd08', name: '雷纹鸟', element: 'electric' },
  { id: 'd09', name: '霜绒兔', element: 'ice' },
  { id: 'd10', name: '冰晶鹿', element: 'ice' },
  { id: 'd11', name: '拳甲熊', element: 'fighting' },
  { id: 'd12', name: '武斗猫', element: 'fighting' },
  { id: 'd13', name: '毒刺蜂', element: 'poison' },
  { id: 'd14', name: '沼泽蟾', element: 'poison' },
  { id: 'd15', name: '沙丘鼠', element: 'ground' },
  { id: 'd16', name: '碎岩蟹', element: 'rock' },
  { id: 'd17', name: '云翎燕', element: 'flying' },
  { id: 'd18', name: '旋风隼', element: 'flying' },
  { id: 'd19', name: '幻梦猫', element: 'psychic' },
  { id: 'd20', name: '念力豚', element: 'psychic' },
  { id: 'd21', name: '荧甲虫', element: 'bug' },
  { id: 'd22', name: '织网蛛', element: 'bug' },
  { id: 'd23', name: '磐石蜥', element: 'rock' },
  { id: 'd24', name: '夜影灯', element: 'ghost' },
  { id: 'd25', name: '鳞角蛟', element: 'dragon' },
  { id: 'd26', name: '云海龙', element: 'dragon' },
  { id: 'd27', name: '暗月鸦', element: 'dark' },
  { id: 'd28', name: '影刃豹', element: 'dark' },
  { id: 'd29', name: '镀钢犀', element: 'steel' },
  { id: 'd30', name: '星屑鹿', element: 'fairy' },
  { id: 'd31', name: '震地鼹', element: 'ground' },
  { id: 'd32', name: '浮游灵', element: 'ghost' },
  { id: 'd33', name: '齿轮獾', element: 'steel' },
  { id: 'd34', name: '铃铛狐', element: 'fairy' },
  { id: 'd35', name: '绒球鼠', element: 'normal' },
  { id: 'd36', name: '团子雀', element: 'normal' },
]

/** 生成一副洗好的 36 张共用牌堆 */
export function freshDeck(): Piece[] {
  return shuffle([...PRESET_DECK])
}
