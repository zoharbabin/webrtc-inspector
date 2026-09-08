// Shared Playwright-side helpers for the webrtc-inspector spec suite.

const SILENT_WAV_BASE64 =
  'UklGRsQAAABXQVZFZm10IBAAAAABAAEAQB8AAIA+AAACABAAZGF0YaAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA';

// Navigates to the shared fixture (MockWebSocket + core script), which
// installs window.__webrtcInspector before any test code runs.
async function gotoFixture(page) {
  await page.goto('/test/fixtures/base.html');
  await page.waitForFunction(() => !!window.__webrtcInspector);
}

// Anything derived from getStats() only appears on a stats poll, and the core
// module polls every 2s. A 3s wait is therefore just 1.5 intervals: it passes
// on an idle machine and fails when the event loop is busy, which is the
// classic shape of a flaky suite. Wait several intervals instead — a longer
// timeout costs nothing when the test passes.
const STATS_POLL_WAIT_MS = 8000;

// Anomaly flags need their threshold to elapse (3s for the unused-channel and
// no-stats flags) and then a poll to notice, so they need more room again.
const ANOMALY_FLAG_WAIT_MS = 12000;

// setMediaFaultInjector needs the standard RTCRtpScriptTransform. Chromium,
// Firefox and Safari all ship it, but Playwright's Linux WebKit build does not,
// while the same Playwright WebKit on macOS does — so this is a per-machine
// capability, not a per-engine one, and has to be probed at runtime rather than
// keyed off browserName. Written as a probe so the specs light up on their own
// the day the Linux build gains it.
async function hasEncodedTransform(page) {
  return page.evaluate(() => typeof window.RTCRtpScriptTransform === 'function');
}

module.exports = { gotoFixture, hasEncodedTransform, SILENT_WAV_BASE64, STATS_POLL_WAIT_MS, ANOMALY_FLAG_WAIT_MS };
