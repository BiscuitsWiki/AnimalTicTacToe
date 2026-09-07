# AnimalTicTacToe H5 客户端镜像：构建阶段（Taro H5）+ 运行阶段（nginx）
# 构建阶段必须用 glibc（Debian）：Taro 4.2.1 的原生绑定 @tarojs/binding 只发布
# darwin/win32/linux-gnu 变体，无 musl（linux-x64-musl），alpine 上会报
# "Cannot find module '@tarojs/binding-linux-x64-musl'"。运行阶段仅托管静态文件，仍用 alpine。
FROM node:22-bookworm-slim AS builder

RUN corepack enable && corepack prepare pnpm@10 --activate

WORKDIR /app

COPY package.json pnpm-lock.yaml pnpm-workspace.yaml ./
RUN pnpm install --frozen-lockfile

COPY . .
# Taro webpack 构建较吃内存
ENV NODE_OPTIONS=--max-old-space-size=4096
RUN pnpm build:h5


FROM nginx:alpine

COPY --from=builder /app/dist /usr/share/nginx/html
COPY nginx.conf /etc/nginx/conf.d/default.conf

EXPOSE 80
