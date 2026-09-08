// @ts-check
// Config for the real-LiveKit E2E suite (nightly only, never wired into the
// PR-blocking suite). See ~/Downloads/webrtc-inspector-livekit-e2e-plan.md
// section 6. Minimal on purpose for build-order step 1; hardened with real
// retries/timeouts in step 5 once local runs establish real timing.
const { defineConfig, devices } = require('@playwright/test');

module.exports = defineConfig({
  testDir: 'test/livekit/specs',
  fullyParallel: false,
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
