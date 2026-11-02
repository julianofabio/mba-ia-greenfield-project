import { ApiProperty } from '@nestjs/swagger';

export class PartUploadUrlDto {
  @ApiProperty({ example: 1 })
  part_number: number;

  @ApiProperty({ description: 'Presigned URL — PUT the part bytes to it' })
  url: string;
}

export class UploadPartUrlsResponseDto {
  @ApiProperty({ example: 3600 })
  expires_in: number;

  @ApiProperty({ type: [PartUploadUrlDto] })
  parts: PartUploadUrlDto[];
}
