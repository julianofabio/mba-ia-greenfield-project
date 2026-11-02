import { execFile } from 'node:child_process';
import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { promisify } from 'node:util';

const execFileAsync = promisify(execFile);

export interface TestVideoOptions {
  durationSeconds?: number;
  width?: number;
  height?: number;
  withAudio?: boolean;
}

export interface TestFiles {
  dir: string;
  cleanup: () => Promise<void>;
}

/** Temp directory for generated media, removed by `cleanup`. */
export async function createTestFiles(): Promise<TestFiles> {
  const dir = await mkdtemp(join(tmpdir(), 'streamtube-media-'));
  return { dir, cleanup: () => rm(dir, { recursive: true, force: true }) };
}

/**
 * Generates a small H.264 (+ AAC) MP4 with FFmpeg's `lavfi` test sources —
 * no binary fixtures in git.
 */
export async function generateTestVideo(
  files: TestFiles,
  name: string,
  {
    durationSeconds = 3,
    width = 320,
    height = 240,
    withAudio = true,
  }: TestVideoOptions = {},
): Promise<string> {
  const output = join(files.dir, name);
  const args = [
    '-v',
    'error',
    '-y',
    '-f',
    'lavfi',
    '-i',
    `testsrc=duration=${durationSeconds}:size=${width}x${height}:rate=25`,
  ];
  if (withAudio) {
    args.push(
      '-f',
      'lavfi',
      '-i',
      `sine=frequency=440:duration=${durationSeconds}`,
    );
    args.push('-c:a', 'aac');
  }
  args.push(
    '-c:v',
    'libx264',
    '-pix_fmt',
    'yuv420p',
    '-movflags',
    '+faststart',
    output,
  );
  await execFileAsync('ffmpeg', args);
  return output;
}

/** A file that is not a video, to exercise processing failures. */
export async function generateTextFile(
  files: TestFiles,
  name: string,
): Promise<string> {
  const output = join(files.dir, name);
  await writeFile(output, 'this is not a video\n'.repeat(64));
  return output;
}
