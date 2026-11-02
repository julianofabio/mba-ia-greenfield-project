import {
  Column,
  CreateDateColumn,
  Entity,
  Index,
  JoinColumn,
  ManyToOne,
  PrimaryGeneratedColumn,
  UpdateDateColumn,
} from 'typeorm';
import { Channel } from '../../channels/entities/channel.entity';
import { numericColumnTransformer } from '../../common/database/numeric-column.transformer';

export enum VideoStatus {
  DRAFT = 'draft',
  PROCESSING = 'processing',
  READY = 'ready',
  FAILED = 'failed',
}

@Entity('videos')
export class Video {
  @PrimaryGeneratedColumn('uuid')
  id: string;

  @Column({ type: 'varchar', length: 11, unique: true })
  public_id: string;

  @Index()
  @Column({ type: 'uuid' })
  channel_id: string;

  @Column({ type: 'varchar', length: 100 })
  title: string;

  @Column({ type: 'enum', enum: VideoStatus, default: VideoStatus.DRAFT })
  status: VideoStatus;

  @Column({ type: 'varchar', length: 255 })
  original_file_name: string;

  @Column({ type: 'varchar', length: 255 })
  content_type: string;

  @Column({ type: 'bigint', transformer: numericColumnTransformer })
  declared_size_bytes: number;

  @Column({ type: 'varchar', length: 255 })
  storage_key: string;

  @Column({ type: 'varchar', length: 1024, nullable: true })
  upload_id: string | null;

  @Column({ type: 'varchar', length: 255, nullable: true })
  thumbnail_key: string | null;

  @Column({
    type: 'bigint',
    nullable: true,
    transformer: numericColumnTransformer,
  })
  size_bytes: number | null;

  @Column({
    type: 'numeric',
    precision: 10,
    scale: 3,
    nullable: true,
    transformer: numericColumnTransformer,
  })
  duration_seconds: number | null;

  @Column({ type: 'integer', nullable: true })
  width: number | null;

  @Column({ type: 'integer', nullable: true })
  height: number | null;

  @Column({ type: 'varchar', length: 50, nullable: true })
  video_codec: string | null;

  @Column({ type: 'varchar', length: 50, nullable: true })
  audio_codec: string | null;

  @Column({ type: 'varchar', length: 100, nullable: true })
  container_format: string | null;

  @Column({
    type: 'bigint',
    nullable: true,
    transformer: numericColumnTransformer,
  })
  bitrate: number | null;

  @Column({ type: 'varchar', length: 500, nullable: true })
  failure_reason: string | null;

  @CreateDateColumn()
  created_at: Date;

  @UpdateDateColumn()
  updated_at: Date;

  @ManyToOne(() => Channel)
  @JoinColumn({ name: 'channel_id' })
  channel: Channel;
}
