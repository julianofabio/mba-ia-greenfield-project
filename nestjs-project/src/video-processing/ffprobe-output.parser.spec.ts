import {
  parseFfprobeOutput,
  thumbnailTimestamp,
} from './ffprobe-output.parser';
import { MediaProcessingError } from './media-processing.error';

const videoStream = {
  codec_type: 'video',
  codec_name: 'h264',
  width: 1920,
  height: 1080,
};
const audioStream = { codec_type: 'audio', codec_name: 'aac' };
const format = {
  duration: '12.345000',
  format_name: 'mov,mp4,m4a,3gp,3g2,mj2',
  bit_rate: '2500123',
};

describe('parseFfprobeOutput', () => {
  it('should map a video with audio', () => {
    expect(
      parseFfprobeOutput({ streams: [videoStream, audioStream], format }),
    ).toEqual({
      durationSeconds: 12.345,
      width: 1920,
      height: 1080,
      videoCodec: 'h264',
      audioCodec: 'aac',
      containerFormat: 'mov,mp4,m4a,3gp,3g2,mj2',
      bitrate: 2500123,
    });
  });

  it('should report a null audio codec for silent videos', () => {
    expect(
      parseFfprobeOutput({ streams: [videoStream], format }).audioCodec,
    ).toBeNull();
  });

  it('should report null duration and bitrate when the container omits them', () => {
    const metadata = parseFfprobeOutput({ streams: [videoStream], format: {} });

    expect(metadata.durationSeconds).toBeNull();
    expect(metadata.bitrate).toBeNull();
    expect(metadata.containerFormat).toBeNull();
  });

  it('should reject a file without a video stream', () => {
    expect(() =>
      parseFfprobeOutput({ streams: [audioStream], format }),
    ).toThrow(MediaProcessingError);
    expect(() => parseFfprobeOutput({})).toThrow(MediaProcessingError);
  });
});

describe('thumbnailTimestamp', () => {
  it.each([
    [null, 0],
    [0.5, 0],
    [1, 0.1],
    [3, 0.3],
    [3725.5, 372.55],
  ])('should pick the frame for duration %p at %p s', (duration, expected) => {
    expect(thumbnailTimestamp(duration)).toBe(expected);
  });
});
