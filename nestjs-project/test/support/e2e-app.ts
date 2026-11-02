import { randomUUID } from 'node:crypto';
import { INestApplication, ValidationPipe } from '@nestjs/common';
import { Test, type TestingModule } from '@nestjs/testing';
import { ThrottlerStorage, ThrottlerStorageService } from '@nestjs/throttler';
import request from 'supertest';
import { App } from 'supertest/types';
import { DataSource } from 'typeorm';
import { AppModule } from '../../src/app.module';
import { DomainExceptionFilter } from '../../src/common/filters/domain-exception.filter';
import { ValidationExceptionFilter } from '../../src/common/filters/validation-exception.filter';
import { User } from '../../src/users/entities/user.entity';

export interface E2EApp {
  app: INestApplication<App>;
  moduleRef: TestingModule;
  dataSource: DataSource;
  clearThrottle: () => void;
}

/** Boots AppModule reproducing the global pipe and filters from main.ts. */
export async function createE2EApp(): Promise<E2EApp> {
  const moduleRef = await Test.createTestingModule({
    imports: [AppModule],
  }).compile();

  const app = moduleRef.createNestApplication<INestApplication<App>>();
  app.useGlobalPipes(
    new ValidationPipe({
      whitelist: true,
      forbidNonWhitelisted: true,
      transform: true,
    }),
  );
  app.useGlobalFilters(
    new DomainExceptionFilter(),
    new ValidationExceptionFilter(),
  );
  await app.init();

  const throttlerStorage =
    moduleRef.get<ThrottlerStorageService>(ThrottlerStorage);
  return {
    app,
    moduleRef,
    dataSource: moduleRef.get(DataSource),
    clearThrottle: () => throttlerStorage.storage.clear(),
  };
}

/**
 * Registers a user through the API (which also creates the channel), marks the
 * e-mail as confirmed and logs in. Returns the access token.
 */
export async function createConfirmedUser(
  e2e: E2EApp,
): Promise<{ accessToken: string; email: string }> {
  const email = `e2e_${randomUUID().slice(0, 8)}@example.com`;
  const password = 'password123';
  const server = e2e.app.getHttpServer();

  await request(server)
    .post('/auth/register')
    .send({ email, password })
    .expect(201);
  await e2e.dataSource
    .getRepository(User)
    .update({ email }, { is_confirmed: true });
  const login = await request(server)
    .post('/auth/login')
    .send({ email, password })
    .expect(200);

  const { access_token } = login.body as { access_token: string };
  return { accessToken: access_token, email };
}
