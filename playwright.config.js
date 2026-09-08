// @ts-check
const { defineConfig, devices } = require('@playwright/test');

const isCI = !!process.env.CI;
const MEDIA_SPECS = ['**/media-fault-injection.spec.js', '**/network-fault.spec.js', '**/fake-media.spec.js'];

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
    // The media-path specs also run on Firefox and WebKit: setMediaFaultInjector
    // uses the standard RTCRtpScriptTransform, simulateNetworkLoss's 'media'
    // target uses replaceTrack(null), and the remote audio meter uses Web Audio,
    // so all three must hold on every engine. The rest of the suite (extension,
    // MCP over CDP) is Chromium by nature.
    {
      name: 'firefox',
      testMatch: MEDIA_SPECS,
      use: {
        ...devices['Desktop Firefox'],
        launchOptions: {
          firefoxUserPrefs: {
            'media.navigator.streams.fake': true,
            'media.navigator.permission.disabled': true,
          },
        },
      },
    },
    {
      name: 'webkit',
      testMatch: MEDIA_SPECS,
      use: {
        ...devices['Desktop Safari'],
        permissions: ['camera', 'microphone'],
      },
    },
  ],
});
