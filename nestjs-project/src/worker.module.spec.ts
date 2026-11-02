import { Test } from '@nestjs/testing';
import { VideoProcessingController } from './video-processing/video-processing.controller';
import { WorkerModule } from './worker.module';

describe('WorkerModule', () => {
  it('should compile with config, TypeORM and the processing consumer', async () => {
    const module = await Test.createTestingModule({
      imports: [WorkerModule],
    }).compile();

    expect(module.get(VideoProcessingController)).toBeInstanceOf(
      VideoProcessingController,
    );
    await module.close();
  });
});
