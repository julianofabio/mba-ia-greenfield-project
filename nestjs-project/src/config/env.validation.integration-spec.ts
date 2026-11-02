import { envValidationSchema } from './env.validation';

const requiredEnv = {
  DB_USERNAME: 'user',
  DB_PASSWORD: 'pass',
  DB_NAME: 'db',
  JWT_SECRET: 'secret',
  JWT_REFRESH_SECRET: 'refresh-secret',
  S3_ACCESS_KEY: 'access-key',
  S3_SECRET_KEY: 'secret-key',
  RABBITMQ_URL: 'amqp://user:pass@rabbitmq:5672',
};

const validate = (env: Record<string, string>) =>
  envValidationSchema.validate(
    { ...requiredEnv, ...env },
    { allowUnknown: true, abortEarly: false },
  );

describe('envValidationSchema — SWAGGER_ENABLED', () => {
  it('should reject SWAGGER_ENABLED with an invalid value', () => {
    const { error } = validate({ SWAGGER_ENABLED: 'invalid' });
    expect(error).toBeDefined();
    expect(error!.message).toContain('SWAGGER_ENABLED');
  });

  it('should accept SWAGGER_ENABLED=true', () => {
    const { error } = validate({ SWAGGER_ENABLED: 'true' });
    expect(error).toBeUndefined();
  });

  it('should accept SWAGGER_ENABLED=false', () => {
    const { error } = validate({ SWAGGER_ENABLED: 'false' });
    expect(error).toBeUndefined();
  });

  it('should apply default false when SWAGGER_ENABLED is not set', () => {
    const { value, error } = validate({});
    expect(error).toBeUndefined();
    expect(value.SWAGGER_ENABLED).toBe('false');
  });
});

describe('envValidationSchema — object storage and message queue', () => {
  const withoutKey = (key: string) => {
    const env: Record<string, string> = { ...requiredEnv };
    delete env[key];
    return envValidationSchema.validate(env, {
      allowUnknown: true,
      abortEarly: false,
    });
  };

  it.each(['S3_ACCESS_KEY', 'S3_SECRET_KEY', 'RABBITMQ_URL'])(
    'should reject a missing %s',
    (key) => {
      const { error } = withoutKey(key);
      expect(error).toBeDefined();
      expect(error!.message).toContain(key);
    },
  );

  it('should apply the Compose defaults to the optional keys', () => {
    const { value, error } = validate({});
    expect(error).toBeUndefined();
    expect(value).toMatchObject({
      S3_ENDPOINT: 'http://minio:9000',
      S3_PUBLIC_ENDPOINT: 'http://localhost:9000',
      S3_REGION: 'us-east-1',
      S3_BUCKET: 'streamtube-videos',
      VIDEO_PROCESSING_QUEUE: 'video-processing',
    });
  });

  it('should reject an S3_ENDPOINT that is not a URI', () => {
    const { error } = validate({ S3_ENDPOINT: 'minio 9000' });
    expect(error).toBeDefined();
    expect(error!.message).toContain('S3_ENDPOINT');
  });

  it('should reject a RABBITMQ_URL with a non-AMQP scheme', () => {
    const { error } = validate({ RABBITMQ_URL: 'http://rabbitmq:5672' });
    expect(error).toBeDefined();
    expect(error!.message).toContain('RABBITMQ_URL');
  });
});

describe('test environment overrides (src/test/test-env.ts)', () => {
  it('should route tests to a dedicated queue', () => {
    expect(process.env.VIDEO_PROCESSING_QUEUE).toBe('video-processing.test');
  });

  it('should sign client URLs against the internal storage endpoint', () => {
    expect(process.env.S3_PUBLIC_ENDPOINT).toBe(process.env.S3_ENDPOINT);
  });
});
