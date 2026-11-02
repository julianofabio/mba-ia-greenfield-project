import { Inject, Injectable, OnModuleDestroy } from '@nestjs/common';
import type { ConfigType } from '@nestjs/config';
import {
  AbortMultipartUploadCommand,
  CompleteMultipartUploadCommand,
  CreateMultipartUploadCommand,
  DeleteObjectCommand,
  GetObjectCommand,
  HeadObjectCommand,
  ListPartsCommand,
  PutObjectCommand,
  S3Client,
  UploadPartCommand,
} from '@aws-sdk/client-s3';
import { getSignedUrl } from '@aws-sdk/s3-request-presigner';
import storageConfig from '../config/storage.config';
import {
  PRESIGNED_URL_EXPIRES_IN_SECONDS,
  type PresignAudience,
} from './storage.constants';

export interface StoredPart {
  partNumber: number;
  sizeBytes: number;
  etag: string;
}

export interface ObjectHead {
  sizeBytes: number;
  contentType: string | undefined;
}

@Injectable()
export class StorageService implements OnModuleDestroy {
  private readonly internalClient: S3Client;
  private readonly publicClient: S3Client;
  private readonly bucket: string;

  constructor(
    @Inject(storageConfig.KEY)
    config: ConfigType<typeof storageConfig>,
  ) {
    this.bucket = config.bucket;
    this.internalClient = this.buildClient(config, config.endpoint);
    this.publicClient = this.buildClient(config, config.publicEndpoint);
  }

  onModuleDestroy(): void {
    this.internalClient.destroy();
    this.publicClient.destroy();
  }

  async createMultipartUpload(
    key: string,
    contentType: string,
  ): Promise<string> {
    const { UploadId } = await this.internalClient.send(
      new CreateMultipartUploadCommand({
        Bucket: this.bucket,
        Key: key,
        ContentType: contentType,
      }),
    );
    if (!UploadId) {
      throw new Error(`Storage returned no UploadId for ${key}`);
    }
    return UploadId;
  }

  async presignUploadPart(
    key: string,
    uploadId: string,
    partNumber: number,
  ): Promise<string> {
    return getSignedUrl(
      this.publicClient,
      new UploadPartCommand({
        Bucket: this.bucket,
        Key: key,
        UploadId: uploadId,
        PartNumber: partNumber,
      }),
      { expiresIn: PRESIGNED_URL_EXPIRES_IN_SECONDS },
    );
  }

  async listParts(key: string, uploadId: string): Promise<StoredPart[]> {
    const parts: StoredPart[] = [];
    let marker: string | undefined;
    do {
      const page = await this.internalClient.send(
        new ListPartsCommand({
          Bucket: this.bucket,
          Key: key,
          UploadId: uploadId,
          PartNumberMarker: marker,
        }),
      );
      for (const part of page.Parts ?? []) {
        parts.push({
          partNumber: part.PartNumber ?? 0,
          sizeBytes: part.Size ?? 0,
          etag: part.ETag ?? '',
        });
      }
      marker = page.IsTruncated ? page.NextPartNumberMarker : undefined;
    } while (marker);
    return parts.sort((a, b) => a.partNumber - b.partNumber);
  }

  async completeMultipartUpload(
    key: string,
    uploadId: string,
    parts: StoredPart[],
  ): Promise<void> {
    await this.internalClient.send(
      new CompleteMultipartUploadCommand({
        Bucket: this.bucket,
        Key: key,
        UploadId: uploadId,
        MultipartUpload: {
          Parts: parts.map(({ partNumber, etag }) => ({
            PartNumber: partNumber,
            ETag: etag,
          })),
        },
      }),
    );
  }

  async abortMultipartUpload(key: string, uploadId: string): Promise<void> {
    await this.internalClient.send(
      new AbortMultipartUploadCommand({
        Bucket: this.bucket,
        Key: key,
        UploadId: uploadId,
      }),
    );
  }

  async headObject(key: string): Promise<ObjectHead | null> {
    try {
      const head = await this.internalClient.send(
        new HeadObjectCommand({ Bucket: this.bucket, Key: key }),
      );
      return {
        sizeBytes: head.ContentLength ?? 0,
        contentType: head.ContentType,
      };
    } catch (err) {
      if (isNotFound(err)) return null;
      throw err;
    }
  }

  async putObject(
    key: string,
    body: Buffer,
    contentType: string,
  ): Promise<void> {
    await this.internalClient.send(
      new PutObjectCommand({
        Bucket: this.bucket,
        Key: key,
        Body: body,
        ContentType: contentType,
      }),
    );
  }

  async deleteObject(key: string): Promise<void> {
    await this.internalClient.send(
      new DeleteObjectCommand({ Bucket: this.bucket, Key: key }),
    );
  }

  async presignGetObject(
    key: string,
    options: { audience: PresignAudience; downloadFileName?: string },
  ): Promise<string> {
    const client =
      options.audience === 'public' ? this.publicClient : this.internalClient;
    return getSignedUrl(
      client,
      new GetObjectCommand({
        Bucket: this.bucket,
        Key: key,
        ResponseContentDisposition: options.downloadFileName
          ? contentDispositionAttachment(options.downloadFileName)
          : undefined,
      }),
      { expiresIn: PRESIGNED_URL_EXPIRES_IN_SECONDS },
    );
  }

  private buildClient(
    config: ConfigType<typeof storageConfig>,
    endpoint: string,
  ): S3Client {
    return new S3Client({
      region: config.region,
      endpoint,
      forcePathStyle: true,
      credentials: {
        accessKeyId: config.accessKey,
        secretAccessKey: config.secretKey,
      },
      requestChecksumCalculation: 'WHEN_REQUIRED',
      responseChecksumValidation: 'WHEN_REQUIRED',
    });
  }
}

function isNotFound(err: unknown): boolean {
  const { name, $metadata } = err as {
    name?: string;
    $metadata?: { httpStatusCode?: number };
  };
  return name === 'NotFound' || $metadata?.httpStatusCode === 404;
}

function contentDispositionAttachment(fileName: string): string {
  const ascii = fileName.replace(/[^\x20-\x7e]/g, '_').replace(/["\\]/g, '_');
  return `attachment; filename="${ascii}"; filename*=UTF-8''${encodeURIComponent(fileName)}`;
}
