import { Module } from '@nestjs/common';
import type { ConfigType } from '@nestjs/config';
import { ClientsModule } from '@nestjs/microservices';
import { TypeOrmModule } from '@nestjs/typeorm';
import { ChannelsModule } from '../channels/channels.module';
import messagingConfig from '../config/messaging.config';
import { StorageModule } from '../storage/storage.module';
import { buildVideoProcessingClientOptions } from '../video-processing/video-processing.queue';
import { Video } from './entities/video.entity';
import { VideoProcessingPublisher } from './video-processing.publisher';
import { VideoResponseMapper } from './video-response.mapper';
import { VideosController } from './videos.controller';
import { VideosService } from './videos.service';
import { VIDEO_PROCESSING_CLIENT } from './videos.constants';

@Module({
  imports: [
    TypeOrmModule.forFeature([Video]),
    ClientsModule.registerAsync([
      {
        name: VIDEO_PROCESSING_CLIENT,
        inject: [messagingConfig.KEY],
        useFactory: (config: ConfigType<typeof messagingConfig>) =>
          buildVideoProcessingClientOptions(config),
      },
    ]),
    StorageModule,
    ChannelsModule,
  ],
  controllers: [VideosController],
  providers: [VideosService, VideoProcessingPublisher, VideoResponseMapper],
})
export class VideosModule {}
