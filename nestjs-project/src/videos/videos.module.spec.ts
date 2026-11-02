import { ConfigModule } from '@nestjs/config';
import { Test } from '@nestjs/testing';
import { TypeOrmModule } from '@nestjs/typeorm';
import { Channel } from '../channels/entities/channel.entity';
import messagingConfig from '../config/messaging.config';
import storageConfig from '../config/storage.config';
import { createTestDataSource } from '../test/create-test-data-source';
import { User } from '../users/entities/user.entity';
import { Video } from './entities/video.entity';
import { VideoProcessingPublisher } from './video-processing.publisher';
import { VideosModule } from './videos.module';

describe('VideosModule', () => {
  it('should compile with TypeORM, the RabbitMQ client, storage and channels', async () => {
    const module = await Test.createTestingModule({
      imports: [
        ConfigModule.forRoot({
          isGlobal: true,
          load: [storageConfig, messagingConfig],
        }),
        TypeOrmModule.forRoot(
          createTestDataSource([User, Channel, Video], { synchronize: false })
            .options,
        ),
        VideosModule,
      ],
    }).compile();

    expect(module.get(VideoProcessingPublisher)).toBeInstanceOf(
      VideoProcessingPublisher,
    );
    await module.close();
  });
});
