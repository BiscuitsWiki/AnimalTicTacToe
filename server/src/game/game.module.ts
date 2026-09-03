import { Module } from '@nestjs/common'
import { AuthModule } from '../auth/auth.module.js'
import { PieceModule } from '../piece/piece.module.js'
import { GameGateway } from './game.gateway.js'
import { GameStatsController } from './game.stats.controller.js'
import { MatchService } from './match.service.js'
import { RoomService } from './room.service.js'

@Module({
  imports: [AuthModule, PieceModule],
  controllers: [GameStatsController],
  providers: [MatchService, RoomService, GameGateway],
})
export class GameModule {}
