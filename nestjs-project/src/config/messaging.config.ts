import { registerAs } from '@nestjs/config';

export default registerAs('messaging', () => ({
  rabbitmqUrl: process.env.RABBITMQ_URL!,
  videoProcessingQueue:
    process.env.VIDEO_PROCESSING_QUEUE || 'video-processing',
}));
