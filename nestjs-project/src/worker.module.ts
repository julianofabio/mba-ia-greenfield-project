import { Module } from '@nestjs/common';
import { ConfigModule } from '@nestjs/config';
import { TypeOrmModule } from '@nestjs/typeorm';
import databaseConfig from './config/database.config';
import { envValidationSchema } from './config/env.validation';
import messagingConfig from './config/messaging.config';
import storageConfig from './config/storage.config';
import { buildTypeOrmOptions } from './database/typeorm-options';
import { UsersModule } from './users/users.module';
import { VideoProcessingModule } from './video-processing/video-processing.module';

/** Root module of the video worker process (`src/worker.ts`). */
@Module({
  imports: [
    ConfigModule.forRoot({
      isGlobal: true,
      load: [databaseConfig, storageConfig, messagingConfig],
      validationSchema: envValidationSchema,
      validationOptions: { allowUnknown: true, abortEarly: false },
    }),
    TypeOrmModule.forRootAsync({
      imports: [ConfigModule],
      inject: [databaseConfig.KEY],
      useFactory: buildTypeOrmOptions,
    }),
    // Registers the User and Channel entities (Video → Channel → User relations)
    // through their owning modules; autoLoadEntities only sees forFeature() ones.
    UsersModule,
    VideoProcessingModule,
  ],
})
export class WorkerModule {}
