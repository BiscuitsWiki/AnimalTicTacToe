# AnimalTicTacToe 服务端镜像（NestJS + Prisma + SQLite）
# 数据卷：/app/data（SQLite 数据库）、/app/uploads（UGC 图片）
FROM node:22-alpine

# Prisma 引擎在 musl（alpine）上需要 openssl / libc6-compat
RUN apk add --no-cache openssl libc6-compat

# pnpm（与本地 lockfile 版本一致的大版本）
RUN corepack enable && corepack prepare pnpm@10 --activate

WORKDIR /app

# 先装依赖（利用 docker layer 缓存）
COPY package.json pnpm-lock.yaml pnpm-workspace.yaml ./
RUN pnpm install --frozen-lockfile

# 源码 + 构建（prisma generate 生成 sqlite 引擎的客户端）
COPY prisma ./prisma
COPY src ./src
COPY admin ./admin
COPY tsconfig.json tsconfig.build.json nest-cli.json ./
RUN pnpm exec prisma generate && pnpm build

ENV NODE_ENV=production
# SQLite 数据库放数据卷（compose 中可用环境变量覆盖）
ENV DATABASE_URL=file:/app/data/app.db
ENV PORT=3000

EXPOSE 3000

# 启动：初始化/同步数据库结构（无 migrations，用 db push）→ 起服务
CMD ["sh", "-c", "mkdir -p /app/data /app/uploads && pnpm exec prisma db push --skip-generate && node dist/main"]
