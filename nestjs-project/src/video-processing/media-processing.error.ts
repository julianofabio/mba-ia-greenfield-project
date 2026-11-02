/** A video could not be probed or a frame could not be extracted. */
export class MediaProcessingError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'MediaProcessingError';
  }
}
