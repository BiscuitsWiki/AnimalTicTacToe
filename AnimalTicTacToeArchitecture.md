# 动物井字棋（AnimalTicTacToe）项目架构设计

> 配套文档：《AinimalTicTacToeDesign.md》（玩法设计）
> 本文回答"怎么实现"：技术选型、目录结构、核心规则引擎、通信协议、数据模型、阶段规划。

***

## 一、总体架构

### 1.1 三端策略

一套 TypeScript 前端代码，逐阶段覆盖三个平台：

```
                ┌── H5 网页（第一时间上线，验证玩法）
Taro + React ──┼── 微信小程序（注册 AppID 后编译产出，复用 95%+ 代码）
                └── Steam 独立版（后期用 Tauri 打包 H5 版，Steamworks SDK 接 C++）
```

### 1.2 技术栈

| 层     | 选型                                                 | 版本               | 说明                          |
| ----- | -------------------------------------------------- | ---------------- | --------------------------- |
| 前端框架  | Taro + React + TypeScript                          | 4.2.1 / 18 / 5.x | 已初始化于 `client/`，编译 Webpack5 |
| 样式    | Sass（SCSS）                                         | -                | 尺寸单位用 `rpx`/`px` 按 Taro 规范  |
| 状态管理  | Zustand                                            | -                | 轻量，无样板代码，游戏状态天然适合单一 store   |
| 后端    | NestJS + TypeScript                                | 10.x             | 第二阶段初始化于 `server/`，与前端同语言   |
| 实时通信  | WebSocket（`@nestjs/websockets` + socket.io-client） | -                | 对局内全部动作走 WS                 |
| 数据库   | PostgreSQL + Prisma ORM                            | -                | 玩家 / 棋子 / 对局 / 审核记录         |
| 缓存/队列 | Redis（开发期用内存 Map 顶替）                               | -                | 匹配队列、30 枚牌堆缓存               |
| 对象存储  | 腾讯云 COS                                            | -                | 棋子素材图片                      |
| 内容审核  | 微信 imgSecCheck + 腾讯云天御                             | -                | UGC 素材机审 + 人审后台             |

### 1.3 服务端权威原则（最重要的架构决策）

所有胜负相关的判定**只发生在服务端**：

* 落子合法性、属性克制占领、三连检测、待胜阻断判定、牌堆组成、抽牌顺序，全部由服务端 `game-engine` 裁决；

* 客户端只负责展示、动画与操作收集，收到服务端事件后渲染；

* `client/src/core/` 与 `server` 共享同一份纯 TS 规则引擎源码（见 3.1），客户端用它做**本地预演/提示**（如高亮可占领格），但结果以服务端为准。

这与 UE 的 server-authoritative 思路一致，是防外挂的底线。

***

## 二、仓库结构

```
AnimalTicTacToe/
├── AinimalTicTacToeDesign.md        # 玩法设计文档（原始需求）
├── AnimalTicTacToeArchitecture.md   # 本文档
├── client/                          # Taro 前端（已初始化）
│   ├── config/                      # Taro 编译配置 dev/prod
│   ├── src/
│   │   ├── app.ts / app.config.ts   # 应用入口与页面注册
│   │   ├── pages/                   # 页面层
│   │   │   ├── index/               # 主菜单（开始对战/背包/战绩）
│   │   │   ├── battle/              # 对局页（棋盘+手牌+牌堆）
│   │   │   └── backpack/            # 背包：棋子管理+创作入口
│   │   ├── components/              # 展示组件（Board/Cell/PieceCard/DeckPile…）
│   │   ├── core/                    # ★ 纯 TS 规则引擎（无 React/Taro 依赖，可拷贝到 server 共享）
│   │   │   ├── elements.ts          # 18 属性定义与克制表
│   │   │   ├── types.ts             # 领域类型（Piece/Board/MatchState…）
│   │   │   ├── engine.ts            # 回合状态机与落子结算
│   │   │   └── ai.ts               # 人机对战 AI
│   │   ├── stores/                  # Zustand stores（matchStore/userStore…）
│   │   ├── services/                # api.ts（REST）+ socket.ts（WS）封装
│   │   └── types/                   # 通用类型、常量
│   └── project.config.json          # 微信开发者工具配置
└── server/                          # NestJS 后端（第二阶段初始化，规划如下）
    └── src/
        ├── modules/
        │   ├── auth/                # 微信 code2session 登录态
        │   ├── match/               # 匹配队列 + 对局 WebSocket 网关
        │   ├── piece/               # 棋子 CRUD、素材上传（COS 直传）
        │   ├── review/              # 审核流水线（初审/举报/下架）
        │   └── admin/               # 运营审核后台接口
        ├── engine/                  # 与 client/src/core 同源的服务端副本
        └── common/                  # 守卫、拦截器、异常过滤器
```

> 说明：`core` 引擎不做 npm 包抽取（monorepo workspace 会增加构建复杂度），采用**目录拷贝 + 单向同步**的朴素方案，第二阶段若稳定再抽包。

***

## 三、核心逻辑设计

### 3.1 属性克制体系（elements.ts）

自创 18 元素体系（克制关系参照宝可梦，命名完全自创，规避 IP 风险）：

```ts
export type Element =
  'Blaze' | 'Torrent' | 'Overgrow' | 'Volt' | 'Aqua' | 'Gale' | 'Frost' | 'Terra'
  | 'Bug' | 'Toxic' | 'Metal' | 'Fairy' | 'Shadow' | 'Psychic' | 'Beast' | 'Dragon'
  | 'Light' | 'Normal';

// 克制表：atk -> def 的倍率。占领条件：倍率 > 1
// 实现为 18x18 查表矩阵（初始化全 1，再逐条声明克制/抵抗关系）
const CHART: Record<Element, Partial<Record<Element, number>>> = {
  Blaze:  { Overgrow: 2, Bug: 2, Metal: 2, Frost: 2, Torrent: 0.5, Aqua: 0.5, Terra: 0.5, Dragon: 0.5 },
  Torrent:{ Blaze: 2, Terra: 2, Overgrow: 0.5, Torrent: 0.5, Volt: 0.5, Dragon: 0.5 },
  // ... 其余 16 种
};

export function effectiveness(atk: Element, def: Element): number {
  return CHART[atk][def] ?? 1;   // 默认普通关系 1x
}
```

> 占领判定**只看** **`> 1`**，与伤害无关——本游戏没有数值战斗，克制表只表达"能否占领"。

### 3.2 领域模型（types.ts）

```ts
export type Side = 'red' | 'blue';

export interface Piece {
  id: string;
  name: string;
  element: Element;
  imageUrl: string;          // COS 地址
}

/** 棋盘单格 */
export interface Cell {
  side: Side | null;         // 当前占领方
  piece: Piece | null;       // 格子上的棋子
}

/** 手牌/牌堆中的棋子 */
export interface HandSlot {
  pieceId: string;
  piece: Piece;
}

export type MatchPhase =
  | 'WAITING'        // 匹配中
  | 'TURN_DRAW'      // 当前行动方可选择抽牌（可选阶段）
  | 'TURN_ACTION'    // 当前行动方落子
  | 'PENDING_WIN'    // 出现三连，等待对手阻断
  | 'FINISHED';      // 胜负已分（含 DRAW）

export interface MatchState {
  phase: MatchPhase;
  board: Cell[];                        // 固定 9 格
  hands: Record<Side, HandSlot[]>;      // 双方手牌（初始各 3 枚自创）
  deck: Piece[];                        // 共用牌堆（30 枚，抽完不补）
  turnSide: Side;                       // 当前行动方
  pendingWin: {                         // 待胜缓冲
    winnerSide: Side;                   //   达成三连的一方
    line: number[];                     //   三连的格子下标
    blockerSide: Side;                  //   需要阻断的一方（= 对手）
  } | null;
  result: { winner: Side | 'draw' } | null;
}
```

### 3.3 回合状态机（engine.ts）

```
            ┌────────────────────────────────────────────────┐
            ▼                                                │
  [TURN_DRAW] 可放弃 ──► [TURN_ACTION] ──► 结算落子+占领      │
            │                     │                          │
            └──── 抽1枚牌堆 ───────┘                          │
                                  │                          │
                     检测三连？──否──► 换边，回到 TURN_DRAW ────┤
                                  │                          │
                                 是                          │
                                  ▼                          │
                          [PENDING_WIN] ── 对手成功打断三连 ───┘
                                  │
                     对手整回合无法打断（回合结束仍三连）
                                  ▼
                            [FINISHED]
```

一次行动的结算伪代码（服务端权威入口）：

```ts
function place(state: MatchState, side: Side, handIdx: number, cellIdx: number): PlaceResult {
  // 1. 合法性校验：轮次、格空、手牌存在 —— 不合法抛 RuleError
  // 2. 落子
  state.board[cellIdx] = { side, piece: hand.piece };
  // 3. 占领判定：对 cellIdx 的上下左右相邻格
  const captures: number[] = [];
  for (const n of neighbors(cellIdx)) {
    const c = state.board[n];
    if (c.side && c.side !== side && effectiveness(hand.piece.element, c.piece!.element) > 1) {
      captures.push(n);
    }
  }
  // 疑点#2：被占领格的处理方式（见"七、规则疑点"），默认采用黑白棋式翻转
  for (const n of captures) state.board[n].side = side;
  // 4. 移除手牌，检测三连
  const line = findLine(state.board, side);
  if (line && side === /* 落子方 */) {
    if (对手上一回合的 pendingWin 仍在) → 本次行动已构成打断处理;
    state.pendingWin = { winnerSide: side, line, blockerSide: opponent(side) };
    state.phase = 'PENDING_WIN';  // 对手的下一回合 = 阻断机会
  }
  // 5. 换边 / 终局判定
}
```

### 3.4 待胜阻断逻辑（玩法核心特色）

* 三连**不立即胜利**，置 `PENDING_WIN`，进入对手的完整回合（抽牌可选 + 落子）；

* 对手若通过**占领**翻转三连线上的任意一格 → 三连被打断，回到正常轮转；

* 对手回合结束（落子结算后）三连仍在 → `winnerSide` 获胜；

* 边界：若双方在同一回合先后各成三连，以先进入 `PENDING_WIN` 者为准，后者先当阻断方。

### 3.5 共用牌堆（deck）

* 匹配成功时由服务端从**审核通过**的公共棋子池随机抽 30 枚生成（`deck_snapshots` 落库存证）；

* `TURN_DRAW` 阶段行动方可放弃；牌堆抽完即不再有抽牌阶段；

* 抽牌与牌序只存在于服务端内存 + 事件推送，客户端不感知未抽的牌。

### 3.6 人机对战 AI（第一阶段冷启动方案）

评估函数按优先级贪心（无搜索，够用且可解释）：

```
1. 我方已有两连且补第三格 → 直接收官
2. 对手存在 PENDING_WIN → 找能克制占领三连格的棋子阻断
3. 落子可触发最多占领 → 拿格子收益
4. 对手有两连 → 占位阻断
5. 随机合法落子
```

### 3.7 UGC 创作与审核流水线

```
玩家创作（相册/拍照/画板） ──提交──► [pending 待机审]
                                      │
              运营后台 ◄──机审(imgSecCheck)──┘
                │
        ┌──通过──┴──驳回──┐
        ▼                ▼
    [approved]       [rejected]（退回修改）
        │
   进入公共池 + 可对战使用
        │
   对局中被举报 ──► [reported 待人审] ──确认违规──► [offline 下架]
                       │
              累计举报 ≥ 阈值 ──► 自动优先下架，事后人审可恢复
```

棋子状态机：`pending → approved | rejected`，`approved → (被举报) reported → offline | 恢复 approved`。

***

## 四、通信协议

### 4.1 REST（非实时部分）

| 接口                        | 说明                       |
| ------------------------- | ------------------------ |
| `POST /auth/wx-login`     | 小程序 code 换 openid，签发 JWT |
| `GET/POST /pieces`        | 棋子列表 / 创建（含 18 属性单选）     |
| `POST /pieces/:id/image`  | 素材上传（COS 预签名直传）          |
| `POST /reports`           | 对局内举报棋子                  |
| `GET /admin/review-queue` | 运营审核队列（分普通/举报两条链路）       |

### 4.2 WebSocket 事件（对局）

| 事件                | 方向  | Payload 要点                                                                      |
| ----------------- | --- | ------------------------------------------------------------------------------- |
| `match:found`     | S→C | 对局 id、对手信息、双方初始手牌、牌堆长度                                                          |
| `match:draw`      | C→S | 抽牌                                                                              |
| `match:place`     | C→S | `{ handIdx, cellIdx }`                                                          |
| `match:event`     | S→C | 服务端结算结果：`placed / captured{cells} / pendingWin / blocked / finished`，客户端按事件驱动动画 |
| `match:surrender` | C→S | 投降                                                                              |

错误码约定：`RULE_INVALID_MOVE / RULE_NOT_YOUR_TURN / RULE_CELL_OCCUPIED …`

***

## 五、数据模型（Prisma 草案）

```prisma
model User        { id, openid, nickname, createdAt }
model Piece       { id, ownerId, name, element, imageUrl,
                    status PieceStatus, reportCount, createdAt }
enum PieceStatus  { pending approved rejected reported offline }
model Match       { id, redId, blueId, winnerId, isDraw,
                    deckSnapshot Json, stateSnapshot Json, endedAt }
model MatchAction { id, matchId, seq, side, type, payload Json }  // 完整棋谱，便于回放/复盘/申诉
model PieceReport { id, pieceId, reporterId, matchId, createdAt }
```

***

## 六、阶段规划（对应设计文档三阶段）

| 阶段          | 内容                                             | 交付物                     |
| ----------- | ---------------------------------------------- | ----------------------- |
| P0 环境搭建     | Node/pnpm/Taro 骨架（**已完成**）                     | `client/` 可 `dev:h5` 启动 |
| P1 本地玩法验证   | `core/` 规则引擎 + 单元测试 + 对局页 UI + 人机对战，纯前端跑通      | 可玩的 H5 单机版              |
| P2 后端 + UGC | NestJS 骨架、登录、背包、创作三入口、审核流                      | 可创作可联机（好友对战）            |
| P2.2 实时对战   | WS 匹配队列 + 房间管理 + 服务端权威裁决 + 视角化广播（**已完成**）      | 双人实时匹配对战（内存态）           |
| P2.3 持久化与重连 | Match/MatchAction 落库、战绩统计 API、断线宽限期重连（**已完成**） | 对局记录可查、战绩展示、断线 60s 内可重连 |
| P3 完整对战     | 举报下架、运营后台、正式登录                                 | 公测版小程序                  |
| P4 扩展       | Tauri 打包 Steam 版、Steamworks（成就/好友）             | Steam 上架                |

***

## 七、规则疑点清单（实现前需与设计确认）

| # | 疑点                                | 默认实现方案                              |
| - | --------------------------------- | ----------------------------------- |
| 1 | 设计说"30 只属性各不相同"，但属性体系只有 18 种，数字矛盾 | 18 种属性各 1 枚 + 随机 12 枚（属性可重复），共 30 枚 |
| 2 | "占领对方棋子所在格子"后，格子上放什么？             | 黑白棋式**阵营翻转**：原棋子保留，归属变为占领方          |
| 3 | 手牌上限（初始 3 + 每回合可抽 1，是否设上限）        | 暂不设上限，UI 横向滚动展示                     |
| 4 | 牌堆抽完 + 棋盘下满且无三连时的平局判定             | 棋盘满即终局，无三连判平                        |
| 5 | 一次落子可占领多个相邻格吗                     | 可以（4 邻格逐个独立判定）                      |
| 6 | 属性体系命名                            | 全部自创元素名，规避"宝可梦"IP 风险                |

***

## 附录：环境与工具链备注（P0 记录）

* Node.js v24 LTS（`C:\Program Files\nodejs`）、pnpm v11.24（全局）、Taro CLI 4.2.1（全局）；微信开发者工具已装。

* `client/pnpm-workspace.yaml` 中 `allowBuilds` 声明了允许执行构建脚本的依赖；`verifyDepsBeforeRun: false` 关闭了 pnpm run 前的依赖自检。

* 本机 pnpm store 位于 `E:\.pnpm-store`（与项目同盘，硬链接安装）。

* 常用命令（在 `client/` 下）：`pnpm run dev:h5`（H5 开发）、`pnpm run dev:weapp`（小程序开发，配合微信开发者工具导入 `client/` 目录）、`pnpm run build:h5`（生产构建）。

