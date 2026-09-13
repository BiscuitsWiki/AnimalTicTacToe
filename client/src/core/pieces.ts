/**
 * P1 本地预设棋子池（占位数据 + 离线/工坊池不足时的兜底牌堆）。
 * P2 接入后端后，牌堆将来自"审核通过的公共棋子仓库"（含玩家自创素材）。
 * 共 51 张 = 36 张单属性（18 属性 × 各 2 张，命名自创，保证克制关系完整覆盖）
 *         + 15 张双属性（名字与属性组合抄录自《洛克王国：世界》现役双属性精灵，
 *           仅取名字与属性组合事实，不涉及形象与文本）。
 */
import type { Piece } from './types'
import { shuffle } from './engine'

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
  { id: 'd11', name: '拳甲熊', element: 'martial' },
  { id: 'd12', name: '武斗猫', element: 'martial' },
  { id: 'd13', name: '毒刺蜂', element: 'poison' },
  { id: 'd14', name: '沼泽蟾', element: 'poison' },
  { id: 'd15', name: '沙丘鼠', element: 'earth' },
  { id: 'd16', name: '震地鼹', element: 'earth' },
  { id: 'd17', name: '云翎燕', element: 'wing' },
  { id: 'd18', name: '旋风隼', element: 'wing' },
  { id: 'd19', name: '幻梦猫', element: 'illusion' },
  { id: 'd20', name: '蜃楼狸', element: 'illusion' },
  { id: 'd21', name: '荧甲虫', element: 'bug' },
  { id: 'd22', name: '织网蛛', element: 'bug' },
  { id: 'd23', name: '曦光蝶', element: 'light' },
  { id: 'd24', name: '晨曦雀', element: 'light' },
  { id: 'd25', name: '夜影灯', element: 'ghost' },
  { id: 'd26', name: '浮游灵', element: 'ghost' },
  { id: 'd27', name: '鳞角蛟', element: 'dragon' },
  { id: 'd28', name: '云海龙', element: 'dragon' },
  { id: 'd29', name: '暗月鸦', element: 'dark' },
  { id: 'd30', name: '影刃豹', element: 'dark' },
  { id: 'd31', name: '镀钢犀', element: 'machine' },
  { id: 'd32', name: '齿轮獾', element: 'machine' },
  { id: 'd33', name: '星屑鹿', element: 'cute' },
  { id: 'd34', name: '铃铛狐', element: 'cute' },
  { id: 'd35', name: '绒球鼠', element: 'normal' },
  { id: 'd36', name: '团子雀', element: 'normal' },
  // ---- 双属性棋子（名字与属性组合抄录《洛克王国：世界》现役双属性精灵）----
  { id: 'd37', name: '瞌睡王', element: 'normal', element2: 'martial' },     // 普通/武
  { id: 'd38', name: '粉粉星', element: 'electric', element2: 'illusion' },  // 电/幻
  { id: 'd39', name: '芋香巨角蛛', element: 'poison', element2: 'bug' },     // 毒/虫
  { id: 'd40', name: '黑羽夫人', element: 'wing', element2: 'dark' },        // 翼/恶
  { id: 'd41', name: '治愈兔', element: 'fire', element2: 'cute' },          // 火/萌
  { id: 'd42', name: '熔岩布丁', element: 'water', element2: 'fire' },       // 水/火
  { id: 'd43', name: '加尔', element: 'grass', element2: 'cute' },           // 草/萌
  { id: 'd44', name: '胡桃王子', element: 'machine', element2: 'martial' },  // 机械/武
  { id: 'd45', name: '月牙雪雪熊', element: 'ice', element2: 'illusion' },   // 冰/幻
  { id: 'd46', name: '燃薪虫', element: 'grass', element2: 'fire' },         // 草/火
  { id: 'd47', name: '贝古斯', element: 'machine', element2: 'fire' },       // 机械/火
  { id: 'd48', name: '窃光蚊', element: 'dark', element2: 'light' },         // 恶/光
  { id: 'd49', name: '利灯鱼', element: 'water', element2: 'electric' },     // 水/电
  { id: 'd50', name: '小皮球', element: 'electric', element2: 'illusion' },  // 电/幻
  { id: 'd51', name: '暗影冰龙王', element: 'ice', element2: 'ghost' },      // 冰/幽
]

/** 生成一副洗好的共用牌堆（51 张：36 单属性 + 15 双属性） */
export function freshDeck(): Piece[] {
  return shuffle([...PRESET_DECK])
}
