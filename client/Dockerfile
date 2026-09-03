# AnimalTicTacToe H5 客户端镜像：构建阶段（Taro H5）+ 运行阶段（nginx）
FROM node:22-alpine AS builder

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
