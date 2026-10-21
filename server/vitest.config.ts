import { defineConfig } from 'vitest/config';

export default defineConfig({
  test: {
    globalSetup: ['./test/globalSetup.ts'],
    fileParallelism: false,
    testTimeout: 20000,
    env: {
      NODE_ENV: 'test',
      DATABASE_URL: process.env.TEST_DATABASE_URL ?? 'postgres://norbs:norbs@localhost:5432/norbscoin_test',
      REQUIRE_MFA: 'true',
      DISABLE_RATE_LIMIT: 'true',
      UPLOAD_DIR: './var/test-uploads',
      PUBLIC_BASE_URL: 'https://exchange.test',
      EMAIL_TRANSPORT: 'log',
    },
  },
});
