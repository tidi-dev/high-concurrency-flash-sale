import 'reflect-metadata';
import { Logger } from '@nestjs/common';
import { NestFactory } from '@nestjs/core';
import type { NestExpressApplication } from '@nestjs/platform-express';
import { existsSync } from 'node:fs';
import { SimulationService } from './admin/simulation.service';
import { AppModule } from './app.module';
import { env } from './common/env';
import { configureApp } from './configure-app';

async function bootstrap() {
  const app = await NestFactory.create<NestExpressApplication>(AppModule, { logger: ['log', 'warn', 'error'] });
  configureApp(app);
  if (env.webDist && existsSync(env.webDist)) {
    app.useStaticAssets(env.webDist); // in Docker, the API also serves the built dashboard
  }
  const server = await app.listen(env.port, '0.0.0.0');
  server.keepAliveTimeout = 65_000;
  app.get(SimulationService).baseUrl = `http://127.0.0.1:${env.port}`;
  new Logger('API').log(`listening on http://localhost:${env.port}/api`);
}
void bootstrap();
