// @ts-check
const { defineConfig, devices } = require('@playwright/test');

const isCI = !!process.env.CI;

module.exports = defineConfig({
  testDir: 'test/specs',
  fullyParallel: true,
  forbidOnly: isCI,
  retries: isCI ? 1 : 0,
  workers: isCI ? 2 : undefined,
  reporter: isCI
    ? [
        ['list'],
        ['html', { outputFolder: 'playwright-report', open: 'never' }],
        ['json', { outputFile: 'test-results/results.json' }],
        ['github'],
      ]
    : [['list'], ['html', { outputFolder: 'playwright-report', open: 'never' }]],
  use: {
    trace: 'retain-on-failure',
    screenshot: 'only-on-failure',
    baseURL: 'http://127.0.0.1:8931',
  },
  webServer: {
    command: 'node test/static-server.js',
    port: 8931,
    reuseExistingServer: !isCI,
  },
  projects: [
    {
      name: 'chromium',
      use: {
        ...devices['Desktop Chrome'],
        launchOptions: {
          args: [
            '--use-fake-ui-for-media-stream',
            '--use-fake-device-for-media-stream',
          ],
        },
      },
    },
  ],
});
