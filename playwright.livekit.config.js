// @ts-check
// Config for the real-LiveKit E2E suite (nightly only, never wired into the
// PR-blocking suite). See ~/Downloads/webrtc-inspector-livekit-e2e-plan.md
// section 6. Minimal on purpose for build-order step 1; hardened with real
// retries/timeouts in step 5 once local runs establish real timing.
const { defineConfig, devices } = require('@playwright/test');

const isCI = !!process.env.CI;

module.exports = defineConfig({
  testDir: 'test/livekit/specs',
  fullyParallel: false,
  // Every spec file shares one real livekit-server process (globalSetup owns
  // it) and one control-server port. server-outage-recovery.spec.js kills
  // and respawns that process outright, which would break any other spec
  // file running concurrently in a second worker — so this suite never runs
  // more than one spec file at a time.
  workers: 1,
  // Matches playwright.config.js's pattern: livekit-nightly.yml's "Write step
  // summary" and "Upload HTML report" steps need test-results/results.json
  // and playwright-report/ to exist, which the built-in default reporter
  // never writes to disk.
  reporter: isCI
    ? [
        ['list'],
        ['html', { outputFolder: 'playwright-report', open: 'never' }],
        ['json', { outputFile: 'test-results/results.json' }],
        ['github'],
      ]
    : [['list'], ['html', { outputFolder: 'playwright-report', open: 'never' }]],
  globalSetup: require.resolve('./test/livekit/global-setup.js'),
  use: {
    trace: 'retain-on-failure',
    screenshot: 'only-on-failure',
    baseURL: 'http://127.0.0.1:8931',
  },
  webServer: {
    command: 'node test/static-server.js',
    port: 8931,
    reuseExistingServer: true,
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
            '--auto-select-desktop-capture-source=Entire screen',
          ],
        },
      },
    },
  ],
});
