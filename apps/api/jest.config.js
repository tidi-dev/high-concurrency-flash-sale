// Two test projects:
//   unit        -> src/**/*.spec.ts. Pure logic plus the Redis Lua scripts (these need Redis running,
//                  because mocking Redis would test the mock rather than the script).
//   integration -> test/**/*.int-spec.ts. Full stack: Nest app + Redis + PostgreSQL (database flashsale_test).
const tsJest = ['ts-jest', { tsconfig: '<rootDir>/tsconfig.test.json' }];

/** @type {import('jest').Config} */
module.exports = {
  testTimeout: 60000, // root level: Jest ignores testTimeout inside `projects`
  projects: [
    {
      displayName: 'unit',
      testEnvironment: 'node',
      rootDir: __dirname,
      testMatch: ['<rootDir>/src/**/*.spec.ts'],
      transform: { '^.+\\.ts$': tsJest },
      setupFiles: ['<rootDir>/test/setup-env.ts'],
    },
    {
      displayName: 'integration',
      testEnvironment: 'node',
      rootDir: __dirname,
      testMatch: ['<rootDir>/test/**/*.int-spec.ts'],
      transform: { '^.+\\.ts$': tsJest },
      setupFiles: ['<rootDir>/test/setup-env.ts'],
      globalSetup: '<rootDir>/test/global-setup.ts',
      // run with --runInBand: these tests share one database and one Redis DB
    },
  ],
};
