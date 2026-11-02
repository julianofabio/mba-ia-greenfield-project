import { MediaProcessingError } from './media-processing.error';

export interface MediaMetadata {
  durationSeconds: number | null;
  width: number;
  height: number;
  videoCodec: string;
  audioCodec: string | null;
  containerFormat: string | null;
  bitrate: number | null;
}

interface FfprobeStream {
  codec_type?: string;
  codec_name?: string;
  width?: number;
  height?: number;
}

interface FfprobeOutput {
  streams?: FfprobeStream[];
  format?: { duration?: string; format_name?: string; bit_rate?: string };
}

/** Thumbnail frame position: 10% of the duration, the first frame for short or unknown durations. */
export function thumbnailTimestamp(durationSeconds: number | null): number {
  if (durationSeconds === null || durationSeconds < 1) return 0;
  return Math.round(durationSeconds * 0.1 * 1000) / 1000;
}

/** Maps `ffprobe -print_format json -show_format -show_streams` output. */
export function parseFfprobeOutput(raw: unknown): MediaMetadata {
  const output = (raw ?? {}) as FfprobeOutput;
  const streams = output.streams ?? [];
  const video = streams.find((s) => s.codec_type === 'video');
  if (!video?.codec_name || !video.width || !video.height) {
    throw new MediaProcessingError('The file has no video stream');
  }
  const audio = streams.find((s) => s.codec_type === 'audio');

  return {
    durationSeconds: toNumber(output.format?.duration),
    width: video.width,
    height: video.height,
    videoCodec: video.codec_name,
    audioCodec: audio?.codec_name ?? null,
    containerFormat: output.format?.format_name ?? null,
    bitrate: toInteger(output.format?.bit_rate),
  };
}

function toNumber(value: string | undefined): number | null {
  const parsed = Number(value);
  return value === undefined || !Number.isFinite(parsed) ? null : parsed;
}

function toInteger(value: string | undefined): number | null {
  const parsed = toNumber(value);
  return parsed === null ? null : Math.round(parsed);
}
