import { defineConfig } from "vitest/config";

/**
 * Tests run against a real Postgres database (TEST_DATABASE_URL) that has all migrations applied.
 * Integration tests share that database, so files run one at a time.
 */
export default defineConfig({
  test: {
    include: ["tests/**/*.test.ts"],
    fileParallelism: false,
    testTimeout: 20_000,
    env: {
      NODE_ENV: "test",
      DATABASE_URL:
        process.env.TEST_DATABASE_URL ?? "postgresql://postgres:postgres@127.0.0.1:5432/waleado_test",
      JWT_ACCESS_SECRET: "test-secret-that-is-at-least-32-characters-long",
      APP_PUBLIC_URL: "https://app.example.test",
      WHATSAPP_BRIDGE_ENABLED: "false",
      SSLCOMMERZ_STORE_ID: "",
      SSLCOMMERZ_STORE_PASSWORD: "",
      SMTP_HOST: "",
    },
  },
});
