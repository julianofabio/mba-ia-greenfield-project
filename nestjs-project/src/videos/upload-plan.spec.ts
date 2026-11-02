import {
  computePartCount,
  defaultTitleFromFileName,
  MAX_VIDEO_SIZE_BYTES,
  PART_SIZE_BYTES,
} from './upload-plan';

describe('upload-plan', () => {
  describe('computePartCount', () => {
    it.each([
      [1, 1],
      [PART_SIZE_BYTES, 1],
      [PART_SIZE_BYTES + 1, 2],
      [150 * 1024 * 1024, 3],
      [MAX_VIDEO_SIZE_BYTES, 160],
    ])('should split %d bytes into %d parts', (size, parts) => {
      expect(computePartCount(size)).toBe(parts);
    });
  });

  describe('defaultTitleFromFileName', () => {
    it.each([
      ['meu-video.final.mp4', 'meu-video.final'],
      ['aula.mp4', 'aula'],
      ['sem-extensao', 'sem-extensao'],
      ['.oculto', '.oculto'],
      ['  espacos.mov  ', 'espacos'],
    ])('should derive %p → %p', (fileName, title) => {
      expect(defaultTitleFromFileName(fileName)).toBe(title);
    });

    it('should truncate to 100 characters', () => {
      expect(defaultTitleFromFileName(`${'a'.repeat(150)}.mp4`)).toHaveLength(
        100,
      );
    });
  });
});
