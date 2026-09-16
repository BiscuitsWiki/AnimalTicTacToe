# AnimalTicTacToe 服务器部署指南

> 适用：将网页版部署到公网服务器，发链接给好友即玩。
> 形态：Docker Compose 单机部署——web 容器（nginx，唯一公网入口 80 端口）+ server 容器（NestJS + SQLite，仅内网）。
> 全流程照抄命令即可，无需改动任何代码。

***

## 一、服务器选购

| 项  | 建议                                                      |
| -- | ------------------------------------------------------- |
| 厂商 | 阿里云 / 腾讯云轻量应用服务器（新用户活动价很低）                              |
| 配置 | **2核 4G 起步**（client 的 Taro 构建吃内存；2G 会 OOM，可本地构建后只传产物规避） |
| 系统 | Ubuntu 22.04 / Debian 12（本文命令按 Ubuntu 写）                |
| 地域 | 只发国内好友 → 国内节点（用域名必须 ICP 备案）；不想备案 → 香港/新加坡节点（延迟略高但免备案）   |
| 带宽 | 轻量套餐自带 4-6Mbps 足够（游戏流量极小，仅图片上传吃带宽）                      |

**只需放行一个端口：80（HTTP）。** 3000 不放行（compose 已收敛为内网）。

***

## 二、服务器初始化（装 Docker）

SSH 登录服务器后执行：

```bash
# 以 root 操作；若用普通用户，命令前加 sudo
apt update && apt upgrade -y

# 一键安装 Docker + Compose 插件（官方脚本）
curl -fsSL https://get.docker.com | sh

# 验证
docker --version          # 期望 >= 24
docker compose version    # 期望 v2.x
```

> 国内服务器若拉取镜像慢，配置镜像加速器：
>
> ```bash
> mkdir -p /etc/docker && cat > /etc/docker/daemon.json <<'EOF'
> { "registry-mirrors": ["https://docker.m.daocloud.io"] }
> EOF
> systemctl restart docker
> ```

***

## 三、上传代码

任选一种：

**方式 A：本地打包上传（推荐——私有仓库免配置 token，且不依赖服务器访问 GitHub）**

```powershell
# 本地 PowerShell（项目根目录执行）：导出最近一次提交的内容为压缩包
git archive --format=tar.gz -o att.tar.gz HEAD
scp att.tar.gz root@<服务器IP>:/opt/
```

```bash
# 服务器：
mkdir -p /opt/att && tar -xzf /opt/att.tar.gz -C /opt/att && cd /opt/att
```

**方式 B：Git 克隆（仓库公开、或 URL 中带 PAT 时方便，更新只需 git pull）**

```bash
apt install -y git
git clone https://github.com/<你的用户名>/AnimalTicTacToe.git /opt/att
cd /opt/att
```

***

## 四、首次部署（3 条命令）

```bash
cd /opt/att

# 1. 生成强随机管理密钥并写入 .env
echo "ADMIN_TOKEN=$(openssl rand -hex 24)" > .env
cat .env    # 记下这个值，运营后台登录要用

# 2. 构建并启动（首次约 5-10 分钟）
#    -p att 显式指定项目名 → 数据卷固定为 att_server_data / att_server_uploads，与部署目录名解耦
docker compose -p att up -d --build

# 3. 观察就绪状态
docker compose -p att ps              # 两个容器均应为 Up (healthy)
docker compose -p att logs -f server  # Ctrl+C 退出日志
```

看到 `att-server` 与 `att-web` 都在运行后，浏览器访问 `http://<服务器IP>/` —— 能进主菜单即部署成功。

***

## 五、自动化验收（必做一次）

验收脚本检查 14 项：H5 首页、静态缓存、运营后台、登录、工坊、战绩、上传路由、WS 反代、房间码、端口收敛等。

```bash
cd /opt/att

# 方式 A：服务器装了 Node >= 22
node acceptance.mjs http://localhost

# 方式 B：不装 Node，直接用 Docker 跑（推荐）
docker run --rm --network host -v /opt/att:/app -w /app node:22-alpine \
    node acceptance.mjs http://localhost
```

期望输出最后一行：`全部通过，部署验收成功。`

若有 FAIL 项，按提示排查（常见原因见第八节）。全过后，把 `http://<服务器IP>/` 发给好友即可。

***

## 六、日常运维

### 当前生产环境（实测信息）

| 项 | 值 |
| -- | -- |
| 服务器 | 腾讯云 `ubuntu@182.254.221.57`（Ubuntu 24.04，SSH 密码登录） |
| 公网入口 | `http://182.254.221.57:8080`（宿主 80 被占，`.env` 设 `WEB_PORT=8080`） |
| 部署目录 | `/opt/att`（属主 root，解压必须 `sudo tar`） |
| Compose 项目名 | `att`（数据卷 `att_server_data` / `att_server_uploads`） |
| `.env` 位置 | `/opt/att/.env`（`ADMIN_TOKEN` + `TENCENT_SECRET_ID/KEY`，不在 git 内） |

### 更新 Runbook（下令「更新公网」时按此执行）

> **分工**：助手执行本机命令（预检 / 提交推送打包 / 验收脚本）；**scp 上传与服务器命令需用户手动执行**（密码交互），助手逐步给出命令并核对输出。
> **触发口令**：用户说「更新公网」「部署更新」→ 从第 0 步开始走。

#### 第 0 步：预检（助手，本机）

- 双端单测全绿、H5 生产构建通过
- `git status` 确认无未提交改动——**`git archive` 只含已提交代码**，未提交的改动不会进包（踩过：新文件没 commit 导致服务器上找不到）

#### 第 1 步：提交、推送、打包（助手，本机 PowerShell 项目根目录）

```powershell
git add -A
git commit -m "<本次发布说明>"
git push
git archive --format=tar.gz -o att.tar.gz HEAD
```

#### 第 2 步：上传（用户执行，需输密码）

```powershell
C:\Windows\System32\OpenSSH\scp.exe att.tar.gz ubuntu@182.254.221.57:~/
```

- **必须传到家目录 `~/`**：`/opt` 归 root，ubuntu 无权写入（scp 到 `/opt` 会 `Permission denied`——踩过）
- 用完整路径 `C:\Windows\System32\OpenSSH\scp.exe`：部分 PowerShell 会话 PATH 中无 scp
- 看到进度条走完 `100%` 才算成功

#### 第 3 步：服务器解压 + 重建（用户执行）

```bash
ls -lh ~/att.tar.gz                                    # ① 时间戳应为今天（确认新包）
sudo tar -xzf ~/att.tar.gz -C /opt/att                 # ② 解压（必须 sudo）
# ③ 新代码标志验证：按本次改动 grep 关键标识（函数名/新文件），均应 ≥1
cd /opt/att && sudo docker compose -p att up -d --build --force-recreate   # ④ 重建（真实编译需几分钟）
sudo docker compose -p att ps                          # ⑤ CREATED 应为 "xx minutes ago"
```

要点：

- `--force-recreate` 必加：镜像未变时 `up` 只显示 Running 空转，容器不会换新（踩过）
- `Built 0.x 秒` = 全命中缓存 → 很可能代码没进来，回 ② 检查解压
- **卡牌/皮肤数据迁移自动执行**：容器启动命令先跑 `node scripts/migrate-card-skin.mjs`（内含 `prisma db push`；把旧 Piece 表按名称归并为 Card + Skin，同名不同属性的皮肤自动驳回，幂等可重复执行），再起服务；旧库升级只需换镜像重启
- **改了 docker-compose.yml 时注意**：`environment:` 是白名单制，`.env` 里的变量必须显式列进 `environment` 才会注入容器（踩过：TENCENT 密钥在 .env 里但没进容器）
- 服务器上写 `.env` 等多行操作**拆成单条 `echo ... | sudo tee -a`**，避免 SSH 断线打断 heredoc 产生重复/残缺行（踩过）；写完 `sudo grep <KEY> /opt/att/.env` 验证；`.env` 变更后 `up -d --force-recreate` 生效（不必 --build），用 `exec server printenv` 复核

#### 第 4 步：验收（助手，本机）

```powershell
node acceptance.mjs http://182.254.221.57:8080
```

期望最后一行 `全部通过，部署验收成功。`；随后按需手动过新功能（浏览器 `Ctrl+F5` 强刷）。

#### 回滚

本机导出上一提交重传，重复第 2~4 步（数据卷不受影响）：

```powershell
git archive --format=tar.gz -o att.tar.gz HEAD~1
```

#### 已知副作用

- 更新会中断进行中对局（几十秒停机窗口），避开正在玩的时间
- acceptance 的 WS 匹配测试会在数据库留一条测试战绩（断线超时判负记录）
- tar.gz 每次覆盖 `/opt/att`，但 `.env` 与数据卷都在包外，不会被动

### 本次更新专项：卡牌/皮肤模型 + 60 张四阶段组牌（2026-09-17）

> 仍按上面 Runbook 第 0~4 步执行，本节只列**本次特有**的检查点与注意事项。

**发布内容**：同名卡牌 = 同一张卡（新增 Card 表；原 Piece 表改为 Skin、PieceReport 改为 SkinReport）、工坊与后台的属性检索 + 按卡聚合展示、对局牌堆改为 60 张四阶段抽取（51 张预设卡 + 有上架皮肤的工坊卡）。

**① 更新前先备份数据卷（本次含表结构变更，必做）**

```bash
docker run --rm -v att_server_data:/data -v /opt/backup:/backup alpine \
    tar -czf /backup/att-data-before-cardskin-$(date +%F).tar.gz -C /data .
```

> 原因：容器启动会自动把旧 `Piece` 表迁移为 `Card`/`Skin`，**旧代码读不懂新表**——若之后要回滚代码，必须同时按第六节「数据恢复」还原这份备份。

**② 数据库无需手工操作**：容器启动命令先跑 `node scripts/migrate-card-skin.mjs`（导出旧表 → `prisma db push` → 按 cardName 归并为卡牌 + 皮肤 → 同名不同属性的皮肤自动驳回），幂等可重复执行，本地已用模拟旧库实测通过。

**③ 第 3 步解压后：新代码标志验证（4 条都应命中）**

```bash
cd /opt/att
grep -c migrate-card-skin Dockerfile                      # 期望 1
ls -l server/scripts/migrate-card-skin.mjs                # 文件存在
grep -c buildGameDeck server/src/game/match.service.ts     # 期望 ≥1
grep -c '属性检索' client/src/pages/workshop/index.tsx      # 期望 ≥1
```

**④ 第 4 步验收：本次新增手动检查项（浏览器 Ctrl+F5 强刷）**

```bash
# 迁移日志（起容器后 1 分钟内看，期望出现迁移横幅与归并统计）
sudo docker compose -p att logs server | grep -E '卡牌/皮肤数据迁移|归并完成|属性冲突'
```

- 后台 `/admin/`：统计卡新增「卡牌总数（预设 51）」（值 = 51 + 工坊已上架卡数）；「上架中」按卡牌聚合（卡头 + N 款皮肤），皮肤仍可单独下架；属性检索栏可选「单属性」「双属性组合」。
- 迁移日志若出现 `预设卡「X」与原工坊卡属性冲突` 警告：该同名工坊皮肤已被自动驳回（创作者改名/改属性后可重新提交），属预期兜底。
- 工坊页：出现「属性检索」面板（选「火」= 主/副任一命中；再点第二个属性 = 组合无序匹配）；「已上架卡牌」按卡牌聚合，同名卡的多款皮肤在同一分组内。
- 工坊提交：输入已存在的卡名 → 应提示「该名称已有卡牌（火/萌）…属性已锁定」，属性 chips 锁定不可改。
- 对局：匹配/人机开局后牌堆为 60 张（双方各发 3 张后余 54）；同一卡名的重复副本应显示不同皮肤图片（该卡有多款上架皮肤时）。

**⑤ 回滚（本次特殊）**：代码回滚需连带还原数据卷：

```bash
docker compose -p att down
docker run --rm -v att_server_data:/data -v /opt/backup:/backup alpine \
    sh -c 'rm -rf /data/* && tar -xzf /backup/att-data-before-cardskin-<日期>.tar.gz -C /data'
# 再用上一提交的包重建
```

### 数据备份（建议加 cron）

```bash
# 手动备份一次：
docker run --rm -v att_server_data:/data -v /opt/backup:/backup alpine \
    tar -czf /backup/att-data-$(date +%F).tar.gz -C /data .
docker run --rm -v att_server_uploads:/data -v /opt/backup:/backup alpine \
    tar -czf /backup/att-uploads-$(date +%F).tar.gz -C /data .

# 每天凌晨 3 点自动备份：
(crontab -l 2>/dev/null; echo "0 3 * * * docker run --rm -v att_server_data:/d -v /opt/backup:/b alpine tar -czf /b/att-data-\$(date +\%F).tar.gz -C /d . && docker run --rm -v att_server_uploads:/d -v /opt/backup:/b alpine tar -czf /b/att-uploads-\$(date +\%F).tar.gz -C /d .") | crontab -
```

> 卷名 `att_server_data` / `att_server_uploads` 由部署命令的 `-p att` 决定。换过项目名的话用 `docker volume ls` 确认实际名称。

### 数据恢复

```bash
docker compose -p att down
docker run --rm -v att_server_data:/data -v /opt/backup:/backup alpine \
    sh -c "rm -rf /data/* && tar -xzf /backup/att-data-2026-XX-XX.tar.gz -C /data"
docker compose -p att up -d
```

### 常用命令速查

| 目的   | 命令                                                         |
| ---- | ---------------------------------------------------------- |
| 看日志  | `docker compose -p att logs -f server` / `... logs -f web` |
| 重启   | `docker compose -p att restart`                            |
| 停服   | `docker compose -p att down`（数据保留）                         |
| 查数据卷 | `docker volume ls`                                         |

### 运营后台

浏览器访问 `http://<服务器IP>/admin/`，登录密钥 = `.env` 里的 `ADMIN_TOKEN`。
可审核 UGC 棋子卡、处理举报。**该地址与密钥不要外泄。**

***

## 七、可选：域名 + HTTPS（发微信前的建议）

客户端已做同源化（自动 ws/wss 切换），**无需改代码**，任选一层方案：

### 方案 A：Caddy 自动 HTTPS（最简单，需域名已解析到服务器 IP）

```bash
apt install -y caddy
cat > /etc/caddy/Caddyfile <<'EOF'
你的域名.com {
    reverse_proxy 127.0.0.1:80
}
EOF
systemctl reload caddy
```

Caddy 自动申请续期证书。注意：国内服务器 + 域名需先完成 ICP 备案（约 2 周）；免备案用境外服务器。

### 方案 B：Cloudflare Tunnel（免开放端口、免服务器证书）

Cloudflare 仪表盘 → Zero Trust → Networks → Tunnels 创建隧道，指向 `http://att-web:80` 或 `http://127.0.0.1:80`，域名托管在 Cloudflare。强制 HTTPS 后客户端自动走 wss。

配置后用验收脚本复测：`node acceptance.mjs https://你的域名.com`

***

## 八、故障排查

| 症状                                | 原因与处理                                                                                |
| --------------------------------- | ------------------------------------------------------------------------------------ |
| web 构建报 `Cannot find module '@tarojs/binding-linux-x64-musl'` | Taro 4.2.1 未发布 musl 原生绑定，构建镜像不能用 alpine——client/Dockerfile 构建阶段已用 node:22-bookworm-slim（glibc），保持即可 |
| att-web 卡在 Created / 日志报 `bind: address already in use` | 宿主机 80 被预装服务占用（`sudo ss -tlnp` 查看，常见为模板机预装的 Caddy/nginx）。处理：停用占用服务，或在 `.env` 设 `WEB_PORT=8080` 换端口（防火墙放行 8080）后 `docker compose -p att up -d` |
| `docker compose ps` 里 server 反复重启 | `docker compose logs server` 看报错；多为 `.env` 缺 `ADMIN_TOKEN`（compose 会直接报错提示）          |
| 首页打不开（超时）                         | 云厂商安全组/防火墙没放行 80；服务器内 `ufw status` 也检查一下                                             |
| 首页能开，联机匹配转圈                       | `/ws` 反代异常，跑验收脚本看 WS 两项；确认 nginx.conf 已随镜像更新（旧镜像重新 build）                            |
| 工坊图片上传报错                          | 看 `docker compose logs server`；3MB 以上文件会被 nginx 拦（client\_max\_body\_size 3m）        |
| 工坊图片显示 404                        | `/uploads` 反代被静态规则截走 → 确认 nginx.conf 用的是 `^~` 前缀匹配的版本                                |
| 验收提示 3000 端口可达                    | compose 的 server 服务被加了 ports 映射，删掉只留 expose，`docker compose up -d` 重建                |
| 构建时 client 阶段 OOM 被杀              | 内存不足 4G；或改用「本地构建产物」方式：本地 `pnpm build:h5` 后把 client/dist 传上去，用只含 nginx 阶段的 Dockerfile |
| 微信内打开链接提示非安全                      | 未套 HTTPS，见第七节                                                                        |

***

## 九、架构速览（排障时的心智模型）

```
好友浏览器
   │  http://IP（或 https://域名 → Caddy/CF → 80）
   ▼
[att-web 容器 :80]  nginx
   ├─ /              → 静态托管 H5（client/dist）
   ├─ /ws            → 反代 att-server:3000（WebSocket，透传 Upgrade，idle 1h）
   ├─ /uploads /auth /pieces /game /admin → 反代 att-server:3000
   ▼
[att-server 容器 :3000，不对公网]  NestJS + Prisma + SQLite
   ├─ 卷 server_data    → SQLite 数据库
   └─ 卷 server_uploads → UGC 图片
```

- 客户端地址逻辑：[client/src/config.ts](client/src/config.ts) —— 生产同源（API 相对路径 + ws/wss 自适应）

- 反代规则：[client/nginx.conf](client/nginx.conf)

- 编排定义：[docker-compose.yml](docker-compose.yml)

- 验收脚本：[acceptance.mjs](acceptance.mjs)

