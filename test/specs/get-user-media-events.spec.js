const { test, expect } = require('@playwright/test');
const { gotoFixture } = require('../helpers');

// getUserMedia/getDisplayMedia rejections (permission denied, no matching
// device) previously left no trace in the event log beyond '-called' — an
// agent reading the log as its only record couldn't tell a request failed
// from one that's still pending.

test.describe('getUserMedia()/getDisplayMedia() failure events', () => {
  test.beforeEach(async ({ page }) => {
    await gotoFixture(page);
  });

  test('a rejected getUserMedia emits getUserMedia-failed, not getUserMedia-served-real', async ({ page }) => {
    const result = await page.evaluate(async () => {
      window.__events = [];
      window.__webrtcInspector.onEvent((e) => window.__events.push(e));
      let rejected = false;
      try {
        await navigator.mediaDevices.getUserMedia({ video: { deviceId: { exact: 'nonexistent-device-id-xyz' } } });
      } catch (_) {
        rejected = true;
      }
      return { rejected, eventTypes: window.__events.map((e) => e.type) };
    });
    expect(result.rejected).toBe(true);
    expect(result.eventTypes).toContain('getUserMedia-called');
    expect(result.eventTypes).toContain('getUserMedia-failed');
    expect(result.eventTypes).not.toContain('getUserMedia-served-real');
    expect(result.eventTypes).not.toContain('getUserMedia-served-mixed');
  });

  test('a rejected getDisplayMedia emits getDisplayMedia-failed, not getDisplayMedia-served', async ({ page }) => {
    const result = await page.evaluate(async () => {
      window.__events = [];
      window.__webrtcInspector.onEvent((e) => window.__events.push(e));
      let rejected = false;
      try {
        // Per spec, getDisplayMedia() requires video to be requested — video:
        // false rejects with a TypeError before any picker is ever involved,
        // so this fails the same way with or without a screen-sharing UI.
        await navigator.mediaDevices.getDisplayMedia({ video: false });
      } catch (_) {
        rejected = true;
      }
      return { rejected, eventTypes: window.__events.map((e) => e.type) };
    });
    expect(result.rejected).toBe(true);
    expect(result.eventTypes).toContain('getDisplayMedia-failed');
    expect(result.eventTypes).not.toContain('getDisplayMedia-served');
  });
});
