import { NestFactory } from '@nestjs/core'
import { ValidationPipe } from '@nestjs/common'
import { NestExpressApplication } from '@nestjs/platform-express'
import { WsAdapter } from '@nestjs/platform-ws'
import { join } from 'node:path'
import { mkdirSync } from 'node:fs'
import type { NextFunction, Request, Response } from 'express'
import { AppModule } from './app.module.js'

async function bootstrap() {
  const app = await NestFactory.create<NestExpressApplication>(AppModule)

  // 原生 WebSocket 协议（H5 浏览器 / 小程序 Taro.connectSocket 直连）
  app.useWebSocketAdapter(new WsAdapter(app))

  // H5 开发期跨域（Vite 端口）
  app.enableCors({ origin: true })

  // 安全响应头（无 cookie 会话，无需 CSP 全家桶；nosniff 防上传目录 MIME 嗅探）
  app.use((_req: Request, res: Response, next: NextFunction) => {
    res.setHeader('X-Content-Type-Options', 'nosniff')
    res.setHeader('X-Frame-Options', 'DENY')
    res.setHeader('Referrer-Policy', 'no-referrer')
    next()
  })

  // 上传目录 + 静态资源服务（生产环境换对象存储 COS）
  const uploadsDir = join(process.cwd(), 'uploads')
  mkdirSync(uploadsDir, { recursive: true })
  app.useStaticAssets(uploadsDir, { prefix: '/uploads' })

  // 运营后台静态页（访问 http://localhost:3000/admin/）
  app.useStaticAssets(join(process.cwd(), 'admin'), { prefix: '/admin' })

  app.useGlobalPipes(
    new ValidationPipe({ transform: true, whitelist: true }),
  )

  const port = Number(process.env.PORT ?? 3000)
  await app.listen(port)
  console.log(`[server] listening on http://localhost:${port}`)
}
bootstrap()
