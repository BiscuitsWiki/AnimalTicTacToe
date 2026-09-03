import { Module } from '@nestjs/common'
import { ConfigModule } from '@nestjs/config'
import { AdminModule } from './admin/admin.module.js'
import { AuthModule } from './auth/auth.module.js'
import { PieceModule } from './piece/piece.module.js'
import { GameModule } from './game/game.module.js'
import { PrismaModule } from './prisma.module.js'

@Module({
  imports: [
    ConfigModule.forRoot({ isGlobal: true }),
    PrismaModule,
    AuthModule,
    AdminModule,
    PieceModule,
    GameModule,
  ],
})
export class AppModule {}
