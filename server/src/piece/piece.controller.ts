import {
  BadRequestException, Body, Controller, Get, Headers, HttpException, HttpStatus, Ip, Param, Post, Query,
  UploadedFile, UseInterceptors,
} from '@nestjs/common'
import { FileInterceptor } from '@nestjs/platform-express'
import { diskStorage } from 'multer'
import { extname, join } from 'node:path'
import { randomUUID } from 'node:crypto'
import { open, unlink } from 'node:fs/promises'
import { ConfigService } from '@nestjs/config'
import { AuthService } from '../auth/auth.service.js'
import { assertAdmin } from '../common/admin-auth.js'
import { rateLimit } from '../common/rate-limit.js'
import { PieceService } from './piece.service.js'

const IMG_MAX_SIZE = 2 * 1024 * 1024          // 2MB
const IMG_TYPES = /\.(png|jpe?g|webp)$/i
/** 限流窗口 1 分钟 */
const RATE_WINDOW_MS = 60_000

/** 图片魔数校验：PNG / JPEG / WebP（RIFF....WEBP） */
async function checkImageMagicBytes(path: string): Promise<boolean> {
  const fh = await open(path, 'r')
  try {
    const buf = Buffer.alloc(12)
    const { bytesRead } = await fh.read(buf, 0, 12, 0)
    if (bytesRead < 12) return false
    const png = buf[0] === 0x89 && buf[1] === 0x50 && buf[2] === 0x4e && buf[3] === 0x47
    const jpeg = buf[0] === 0xff && buf[1] === 0xd8 && buf[2] === 0xff
    const webp =
      buf[0] === 0x52 && buf[1] === 0x49 && buf[2] === 0x46 && buf[3] === 0x46 &&
      buf[8] === 0x57 && buf[9] === 0x45 && buf[10] === 0x42 && buf[11] === 0x50
    return png || jpeg || webp
  } finally {
    await fh.close()
  }
}

/** 固定窗口限流：超限抛 429 */
function throttle(key: string, limit: number): void {
  if (!rateLimit(key, limit, RATE_WINDOW_MS)) {
    throw new HttpException('请求过于频繁，请稍后再试', HttpStatus.TOO_MANY_REQUESTS)
  }
}

@Controller('pieces')
export class PieceController {
  constructor(
    private readonly pieceService: PieceService,
    private readonly config: ConfigService,
    private readonly auth: AuthService,
  ) {}

  /** 从 Authorization: Bearer xxx 提取 token */
  private bearer(headers: Record<string, string>): string | undefined {
    const h = headers['authorization']
    return h?.startsWith('Bearer ') ? h.slice(7) : undefined
  }

  /** 管理端鉴权（共享实现：恒时比较 + 强度校验） */
  private assertAdmin(headers: Record<string, string>) {
    assertAdmin(this.config, headers)
  }

  /** 上传棋子图片（multipart/form-data, 字段名 file） */
  @Post('image')
  @UseInterceptors(
    FileInterceptor('file', {
      storage: diskStorage({
        destination: join(process.cwd(), 'uploads'),
        filename: (_req, file, cb) => cb(null, `${randomUUID()}${extname(file.originalname)}`),
      }),
      limits: { fileSize: IMG_MAX_SIZE },
      fileFilter: (_req, file, cb) => {
        if (!IMG_TYPES.test(file.originalname)) {
          return cb(new BadRequestException('仅支持 png/jpg/webp 图片'), false)
        }
        cb(null, true)
      },
    }),
  )
  async uploadImage(@Ip() ip: string, @UploadedFile() file?: Express.Multer.File) {
    throttle(`pieces:image:${ip}`, 5)
    if (!file) throw new BadRequestException('未收到图片文件')
    // 魔数校验：扩展名可伪造，内容不是真图片则删除并拒绝（防伪装图片上传任意文件）
    if (!await checkImageMagicBytes(file.path)) {
      await unlink(file.path).catch(() => {})
      throw new BadRequestException('图片内容非法（仅支持 png/jpg/webp）')
    }
    return { url: `/uploads/${file.filename}` }
  }

  /** 提交创作棋子（登录态下作者归属当前用户） */
  @Post()
  submit(@Ip() ip: string, @Headers() headers: Record<string, string>, @Body() body: { name: string; element: string; imageUrl: string; authorId?: string }) {
    throttle(`pieces:submit:${ip}`, 5)
    // 兼容未登录调用（登录前旧行为），登录后以 token 归属为准
    return this.auth.verifyTokenOrNull(this.bearer(headers)).then(user => {
      const authorId = user?.id ?? body.authorId ?? 'guest'
      return this.pieceService.submit({ ...body, authorId })
    })
  }

  /** 公共池（审核通过） */
  @Get('approved')
  listApproved(@Query('limit') limit?: string) {
    return this.pieceService.listApproved(limit ? Number(limit) : undefined)
  }

  /** 我的棋子（登录态下按当前用户查询） */
  @Get('mine')
  async listMine(@Headers() headers: Record<string, string>, @Query('authorId') authorId?: string) {
    const user = await this.auth.verifyTokenOrNull(this.bearer(headers))
    return this.pieceService.listMine(user?.id ?? authorId ?? 'guest')
  }

  /** 待审核队列（管理端，普通审核链路） */
  @Get('pending')
  listPending(@Headers() headers: Record<string, string>) {
    this.assertAdmin(headers)
    return this.pieceService.listPending()
  }

  /** 被举报下架队列（管理端，举报链路） */
  @Get('reported')
  listReported(@Headers() headers: Record<string, string>) {
    this.assertAdmin(headers)
    return this.pieceService.listReported()
  }

  /** 对局内举报棋子（登录态下举报者归属当前用户） */
  @Post(':id/report')
  async report(
    @Param('id') id: string,
    @Ip() ip: string,
    @Headers() headers: Record<string, string>,
    @Body() body: { reporterId: string; matchId?: string; reason: string },
  ) {
    throttle(`pieces:report:${ip}`, 10)
    const user = await this.auth.verifyTokenOrNull(this.bearer(headers))
    return this.pieceService.report({
      pieceId: id,
      reporterId: user?.id ?? body?.reporterId,
      matchId: body?.matchId,
      reason: body?.reason,
    })
  }

  /** 审核操作（管理端） */
  @Post(':id/review')
  review(
    @Param('id') id: string,
    @Headers() headers: Record<string, string>,
    @Query('action') action: 'approve' | 'reject',
    @Query('reason') reason?: string,
  ) {
    this.assertAdmin(headers)
    if (action !== 'approve' && action !== 'reject') {
      throw new BadRequestException('action 仅支持 approve / reject')
    }
    return this.pieceService.review(id, action, reason)
  }
}
