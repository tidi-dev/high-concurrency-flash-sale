import { execSync } from 'node:child_process';
import path from 'node:path';

// Apply migrations to the test database once per `jest` run.
export default function globalSetup(): void {
  const url = process.env.TEST_DATABASE_URL ?? 'postgresql://flashsale:flashsale@localhost:5432/flashsale_test';
  execSync('npx prisma migrate deploy', {
    cwd: path.resolve(__dirname, '..'),
    env: { ...process.env, DATABASE_URL: url },
    stdio: 'inherit',
  });
}
