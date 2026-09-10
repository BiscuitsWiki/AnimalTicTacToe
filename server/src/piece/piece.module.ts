import { Module } from '@nestjs/common'
import { AuthModule } from '../auth/auth.module.js'
import { PieceController } from './piece.controller.js'
import { ContentSecurityService } from './content-security.service.js'
import { PieceService } from './piece.service.js'

@Module({
  imports: [AuthModule],
  controllers: [PieceController],
  providers: [PieceService, ContentSecurityService],
  exports: [PieceService],
})
export class PieceModule {}
