import { defineConfig } from '@playwright/test'

export default defineConfig({
  testDir: './e2e',
  globalSetup: './e2e/global-setup.ts',
  globalTeardown: './e2e/global-teardown.ts',
  fullyParallel: true,
  forbidOnly: !!process.env.CI,
  retries: process.env.CI ? 2 : 0,
  workers: process.env.CI ? 2 : undefined,
  reporter: process.env.CI ? 'github' : 'list',
  use: {
    baseURL: 'http://localhost:3000',
    trace: 'on-first-retry',
  },
  webServer: [
    {
      command: 'sh -c "test -x venv/bin/python && exec venv/bin/python -m uvicorn app.main:app --port 8000 || exec python3 -m uvicorn app.main:app --port 8000"',
      port: 8000,
      cwd: '../backend',
      reuseExistingServer: !process.env.CI,
      timeout: 30000,
      env: process.env.CI ? { DATABASE_URL: 'sqlite:///./e2e_test.db' } : undefined,
    },
    {
      command: 'npm run dev',
      port: 3000,
      reuseExistingServer: !process.env.CI,
      timeout: 30000,
    },
  ],
})
