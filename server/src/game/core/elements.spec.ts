/**
 * 服务端属性/双属性判定单测（vitest）。
 * server/src/game/core/elements.ts 是双端同步拷贝中的权威裁决端（房间对局落子校验），
 * 本 spec 守护服务端副本不与客户端 client/src/core/elements.ts 漂移；
 * 判定用例与 client/src/core/__tests__/engine.test.ts 保持同步。
 */
import { describe, expect, it } from 'vitest';
import { canCapture, captureMultiplier, effectiveness, ELEMENTS } from './elements.js';
import { canPlace, place, topSide } from './engine.js';
import { PRESET_DECK } from './pieces.js';
import type { MatchState, Piece, Side } from './types.js';

const P = (id: string, element: Piece['element'], element2?: Piece['element']): Piece =>
  ({ id, name: id, element, ...(element2 && element2 !== element ? { element2 } : {}) });

/** 最小对局状态（空手牌/空牌堆，测试内自行注入） */
function makeState(opts: { turnSide?: Side } = {}): MatchState {
  return {
    phase: 'TURN_ACTION',
    board: Array.from({ length: 9 }, () => ({ stack: [] })),
    hands: { red: [], blue: [] },
    deck: [],
    turnCount: 1,
    turnSide: opts.turnSide ?? 'red',
    lastPlaced: { red: null, blue: null },
    lastSkipped: null,
    pendingWin: null,
    result: null,
  };
}

describe('属性克制与抵抗（服务端权威副本）', () => {
  it('基本克制 / 抵抗 0.5 / 互克对双向 2', () => {
    expect(effectiveness('fire', 'grass')).toBe(2);
    expect(effectiveness('grass', 'fire')).toBe(0.5); // 火克草 → 草攻火被抵抗
    expect(effectiveness('ice', 'earth')).toBe(2);
    expect(effectiveness('earth', 'ice')).toBe(2);
    expect(effectiveness('dragon', 'dragon')).toBe(2); // 龙克龙（自身互克）
    expect(effectiveness('ghost', 'ghost')).toBe(2); // 幽克幽（自身互克）
    expect(effectiveness('ice', 'ice')).toBe(0.5); // 官方同属性互抗：冰
    expect(effectiveness('machine', 'machine')).toBe(0.5); // 官方同属性互抗：机械
    expect(effectiveness('fire', 'fire')).toBe(1); // 官方火攻火中性（非互抗）
    expect(effectiveness('normal', 'normal')).toBe(1); // 普通同属性中性
    expect(effectiveness('normal', 'fire')).toBe(1); // 普通不克任何属性
  });

  it('官方系别表快照（BWiki 数据）：18×18 全表倍率逐格一致', () => {
    // [克制 2x 列表, 被抵抗 0.5x 列表]；与 core/elements.ts 的 CHART / RESIST 对拍（防单侧漂移）
    const OFF: Record<string, [string[], string[]]> = {
      normal: [[], ['earth', 'ghost', 'machine']],
      grass: [['light', 'earth', 'water'], ['machine', 'poison', 'fire', 'wing', 'bug', 'dragon']],
      fire: [['ice', 'machine', 'grass', 'bug'], ['earth', 'water', 'dragon']],
      water: [['earth', 'machine', 'fire'], ['ice', 'grass', 'dragon']],
      light: [['ghost', 'dark'], ['ice', 'grass']],
      earth: [['ice', 'poison', 'fire', 'electric'], ['martial', 'grass']],
      ice: [['earth', 'wing', 'grass', 'dragon'], ['ice', 'machine', 'fire']],
      dragon: [['dragon'], ['machine']],
      electric: [['water', 'wing'], ['earth', 'electric', 'grass', 'dragon']],
      poison: [['grass', 'cute'], ['earth', 'ghost', 'machine', 'poison']],
      bug: [['illusion', 'dark', 'grass'], ['ghost', 'machine', 'martial', 'poison', 'fire', 'wing', 'cute']],
      martial: [['ice', 'earth', 'dark', 'normal', 'machine'], ['illusion', 'ghost', 'poison', 'wing', 'cute', 'bug']],
      wing: [['martial', 'grass', 'bug'], ['earth', 'machine', 'electric', 'dragon']],
      cute: [['dark', 'martial', 'dragon'], ['machine', 'poison', 'fire']],
      ghost: [['light', 'illusion', 'ghost'], ['dark', 'normal']],
      dark: [['ghost', 'poison', 'cute'], ['light', 'dark', 'martial']],
      machine: [['ice', 'earth', 'cute'], ['machine', 'water', 'fire', 'electric']],
      illusion: [['martial', 'poison'], ['light', 'illusion', 'machine']],
    };
    const bad: string[] = [];
    for (const a of ELEMENTS) {
      for (const d of ELEMENTS) {
        const [beat, resist] = OFF[a];
        const want = beat.includes(d) ? 2 : resist.includes(d) ? 0.5 : 1;
        const got = effectiveness(a, d);
        if (got !== want) bad.push(`${a}攻${d} 官方${want}/实现${got}`);
      }
    }
    expect(bad).toEqual([]);
  });

  it('克制表健全性：互克仅限 光↔幽、冰↔地、恶↔萌（龙/幽自身不算互克对）', () => {
    const mutual: string[] = [];
    for (const a of ELEMENTS) {
      for (const b of ELEMENTS) {
        if (a !== b && canCapture({ element: a }, { element: b }) && canCapture({ element: b }, { element: a })) {
          mutual.push(`${a}|${b}`);
        }
      }
    }
    expect(mutual.sort()).toEqual([
      'cute|dark', 'dark|cute', 'earth|ice', 'ghost|light', 'ice|earth', 'light|ghost',
    ]);
  });

  it('全表值域不变量：任意单/双属性组合倍率 ∈ {0.25, 0.5, 1, 2, 4}', () => {
    const profiles = ELEMENTS.flatMap((x) => [
      { element: x },
      ...ELEMENTS.filter((y) => y !== x).map((y) => ({ element: x, element2: y })),
    ]);
    const ALLOWED = new Set([0.25, 0.5, 1, 2, 4]);
    const bad: string[] = [];
    for (const atk of profiles) {
      for (const def of profiles) {
        const m = captureMultiplier(atk, def);
        if (!ALLOWED.has(m)) {
          bad.push(`${atk.element}+${atk.element2 ?? '-'} 攻 ${def.element}+${def.element2 ?? '-'} = ${m}`);
        }
      }
    }
    expect(bad).toEqual([]);
  });
});

describe('双属性判定（服务端权威副本）', () => {
  it('用户示例：翼+水 攻 火+草 → 择翼（1×2=2 > 水 2×0.5=1）', () => {
    const atk = P('atk', 'wing', 'water');
    const def = P('def', 'fire', 'grass');
    expect(captureMultiplier(atk, def)).toBe(2);
    expect(canCapture(atk, def)).toBe(true);
  });

  it('单属性攻双属性：水 攻 火+草 → 2×0.5=1 不可占领', () => {
    expect(canCapture(P('a', 'water'), P('d', 'fire', 'grass'))).toBe(false);
  });

  it('官方同属性中性：火+水 攻 火+草 → 火 1×2=2、水 2×0.5=1 → 取 2 可占领', () => {
    const def = P('d', 'fire', 'grass');
    expect(captureMultiplier(P('a', 'fire', 'water'), def)).toBe(2); // 火攻火中性，火打草仍 2x
    expect(canCapture(P('a', 'fire', 'water'), def)).toBe(true);
    expect(canCapture(P('a', 'fire', 'wing'), def)).toBe(true); // 火+翼：翼 1×2=2 仍可占领
  });

  it('防守方双弱点 4x / 双向抵抗 0.25 / 择优后仍 1', () => {
    expect(captureMultiplier(P('a', 'cute'), P('d', 'dragon', 'martial'))).toBe(4);
    expect(captureMultiplier(P('a', 'fire'), P('d', 'water', 'earth'))).toBe(0.25);
    expect(captureMultiplier(P('a', 'fire', 'electric'), P('d', 'water', 'earth'))).toBe(1);
    expect(canCapture(P('a', 'fire', 'electric'), P('d', 'water', 'earth'))).toBe(false);
  });

  it('主副去重与交换等价（抽样）', () => {
    // 主副相同按单属性处理（P 助手会丢弃相同 element2，须用原生对象直测去重分支）
    expect(captureMultiplier({ element: 'fire', element2: 'fire' }, { element: 'water' })).toBe(0.5);
    expect(captureMultiplier({ element: 'water', element2: 'water' }, { element: 'fire' })).toBe(2);
    // 主副交换不改变判定
    const m1 = captureMultiplier(P('a', 'wing', 'water'), P('d', 'fire', 'grass'));
    const m2 = captureMultiplier(P('a', 'water', 'wing'), P('d', 'fire', 'grass'));
    expect(m1).toBe(m2);
  });

  it('引擎集成：翼+水 叠放 火+草 翻转归属，火+草 不可叠回（NOT_EFFECTIVE）', () => {
    const s = makeState({ turnSide: 'blue' });
    s.hands.red = [P('rw', 'wing', 'water')];
    s.hands.blue = [P('bf', 'fire', 'grass'), P('bf2', 'fire', 'grass')];
    place(s, 'blue', 0, 4); // blue 火+草 落空格 4
    const ev = place(s, 'red', 0, 4); // red 翼+水 叠放占领
    expect(ev.some((e) => e.type === 'placed' && e.stacked)).toBe(true);
    expect(topSide(s.board[4])).toBe('red');
    expect(s.board[4].stack[0].piece.element2).toBe('grass'); // 底层保留副属性
    expect(s.board[4].stack[1].piece.element2).toBe('water'); // 顶层
    // blue 火+草 攻 翼+水：火 1×0.5=0.5，草 0.5×2=1 → 择草 1 ≤ 1 不可叠
    expect(canPlace(s, 'blue', 0, 4)).toBe(false);
    expect(() => place(s, 'blue', 0, 4)).toThrow(/NOT_EFFECTIVE/);
  });
});

describe('预设卡池（服务端副本守护）', () => {
  it('51 张 = 36 单属性（18 属性 × 各 2 张）+ 15 双属性，双属性主副均合法且不同', () => {
    expect(PRESET_DECK).toHaveLength(51);
    expect(new Set(PRESET_DECK.map((p) => p.id)).size).toBe(51);
    const singles = PRESET_DECK.filter((p) => !p.element2);
    const duals = PRESET_DECK.filter((p) => p.element2);
    expect(singles).toHaveLength(36);
    expect(duals).toHaveLength(15);
    for (const p of duals) {
      expect(ELEMENTS).toContain(p.element);
      expect(ELEMENTS).toContain(p.element2!);
      expect(p.element2).not.toBe(p.element);
    }
    // 抽样：暗影冰龙王 冰+幽 克制 鳞角蛟 龙（冰克龙 2x）
    const king = PRESET_DECK.find((p) => p.name === '暗影冰龙王');
    const dragon = PRESET_DECK.find((p) => p.name === '鳞角蛟');
    expect(king && dragon).toBeTruthy();
    if (king && dragon) {
      expect(canCapture(king, dragon)).toBe(true);
    }
  });
});
