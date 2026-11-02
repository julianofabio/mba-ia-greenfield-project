export function videoOriginalKey(videoId: string): string {
  return `videos/${videoId}/original`;
}

export function videoThumbnailKey(videoId: string): string {
  return `videos/${videoId}/thumbnail.jpg`;
}
