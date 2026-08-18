// Shared Playwright-side helpers for the webrtc-inspector spec suite.

const SILENT_WAV_BASE64 =
  'UklGRsQAAABXQVZFZm10IBAAAAABAAEAQB8AAIA+AAACABAAZGF0YaAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA';

// Navigates to the shared fixture (MockWebSocket + core script), which
// installs window.__webrtcInspector before any test code runs.
async function gotoFixture(page) {
  await page.goto('/test/fixtures/base.html');
  await page.waitForFunction(() => !!window.__webrtcInspector);
}

module.exports = { gotoFixture, SILENT_WAV_BASE64 };
