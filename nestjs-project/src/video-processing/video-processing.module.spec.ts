import { ConfigModule } from '@nestjs/config';
import { Test } from '@nestjs/testing';
import { TypeOrmModule } from '@nestjs/typeorm';
import { Channel } from '../channels/entities/channel.entity';
import storageConfig from '../config/storage.config';
import { createTestDataSource } from '../test/create-test-data-source';
import { User } from '../users/entities/user.entity';
import { Video } from '../videos/entities/video.entity';
import { VideoProcessingModule } from './video-processing.module';
import { VideoProcessingService } from './video-processing.service';

describe('VideoProcessingModule', () => {
  it('should compile with TypeORM and storage', async () => {
    const module = await Test.createTestingModule({
      imports: [
        ConfigModule.forRoot({ isGlobal: true, load: [storageConfig] }),
        TypeOrmModule.forRoot(
          createTestDataSource([User, Channel, Video], { synchronize: false })
            .options,
        ),
        VideoProcessingModule,
      ],
    }).compile();

    expect(module.get(VideoProcessingService)).toBeInstanceOf(
      VideoProcessingService,
    );
    await module.close();
  });
});
