import { ApiProperty } from '@nestjs/swagger';

export class UploadedPartDto {
  @ApiProperty({ example: 1 })
  part_number: number;

  @ApiProperty({ example: 67108864 })
  size_bytes: number;
}

export class UploadStateResponseDto {
  @ApiProperty({ example: 67108864 })
  part_size: number;

  @ApiProperty({ example: 3 })
  part_count: number;

  @ApiProperty({ type: [UploadedPartDto] })
  uploaded_parts: UploadedPartDto[];
}
