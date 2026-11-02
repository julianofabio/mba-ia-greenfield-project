import { execFile } from 'node:child_process';
import { Injectable } from '@nestjs/common';
import {
  type MediaMetadata,
  parseFfprobeOutput,
} from './ffprobe-output.parser';
import { MediaProcessingError } from './media-processing.error';

const MAX_THUMBNAIL_WIDTH = 1280;
const MAX_FRAME_BYTES = 32 * 1024 * 1024;
const MAX_STDERR_IN_ERROR = 400;
// Remote inputs are read with HTTP Range requests; bound a stalled transfer.
const COMMAND_TIMEOUT_MS = 5 * 60 * 1000;

/**
 * Runs `ffprobe`/`ffmpeg` (installed in the image) against a local path or an
 * HTTP(S) URL. URLs are read with Range requests, so a 10 GB object is never
 * downloaded just to read its header or one frame.
 */
@Injectable()
export class MediaProbeService {
  async probe(input: string): Promise<MediaMetadata> {
    const stdout = await run('ffprobe', [
      '-v',
      'error',
      '-print_format',
      'json',
      '-show_format',
      '-show_streams',
      input,
    ]);
    let parsed: unknown;
    try {
      parsed = JSON.parse(stdout.toString('utf8'));
    } catch {
      throw new MediaProcessingError('ffprobe returned invalid JSON');
    }
    return parseFfprobeOutput(parsed);
  }

  /** Returns one JPEG frame at `atSeconds`, never wider than 1280 px. */
  async extractFrame(input: string, atSeconds: number): Promise<Buffer> {
    const frame = await run('ffmpeg', [
      '-v',
      'error',
      '-ss',
      atSeconds.toFixed(3),
      '-i',
      input,
      '-frames:v',
      '1',
      '-vf',
      `scale='min(${MAX_THUMBNAIL_WIDTH},iw)':-2`,
      '-q:v',
      '3',
      '-f',
      'image2',
      '-c:v',
      'mjpeg',
      'pipe:1',
    ]);
    if (frame.length === 0) {
      throw new MediaProcessingError(
        `ffmpeg produced no frame at ${atSeconds}s`,
      );
    }
    return frame;
  }
}

function run(command: string, args: string[]): Promise<Buffer> {
  return new Promise((resolve, reject) => {
    execFile(
      command,
      args,
      {
        encoding: 'buffer',
        maxBuffer: MAX_FRAME_BYTES,
        timeout: COMMAND_TIMEOUT_MS,
      },
      (error, stdout, stderr) => {
        if (error) {
          const detail = stderr.toString('utf8').trim() || error.message;
          reject(
            new MediaProcessingError(
              `${command} failed: ${detail.slice(0, MAX_STDERR_IN_ERROR)}`,
            ),
          );
          return;
        }
        resolve(stdout);
      },
    );
  });
}
