const { test, expect } = require('@playwright/test');

// endMediaBlackout() used to swallow a rejected replaceTrack() restore with a
// bare .catch(() => {}) — if putting a sender's track back after a
// simulateNetworkLoss(['media']) outage failed, the caller had no way to know:
// no event, and network-loss-end still fired as if every track came back.
//
// core/webrtc-inspector.js captures the *native* RTCRtpSender.replaceTrack
// once at load time and calls that captured reference directly for both the
// blackout and the restore — it never goes through the instance/prototype
// method, so overriding the prototype after load can't reach it. Installing
// the override via addInitScript, before the page's own <script> tag runs
// core/webrtc-inspector.js, makes the module capture our controllable fake
// instead of the browser's real implementation: full determinism, no reliance
// on any engine-specific way to make a real replaceTrack() call reject.
const FORCE_RESTORE_REJECT_INIT_SCRIPT = `
  window.__forceRestoreReject = false;
  const nativeReplaceTrack = window.RTCRtpSender.prototype.replaceTrack;
  window.RTCRtpSender.prototype.replaceTrack = function (track) {
    if (track !== null && window.__forceRestoreReject) {
      return Promise.reject(new Error('simulated restore failure'));
    }
    return nativeReplaceTrack.call(this, track);
  };
`;

test.describe('endMediaBlackout restore failure is not swallowed', () => {
  test.beforeEach(async ({ page }) => {
    await page.addInitScript(FORCE_RESTORE_REJECT_INIT_SCRIPT);
    await page.goto('/test/fixtures/base.html');
    await page.waitForFunction(() => !!window.__webrtcInspector);
  });

  test('emits media-blackout-restore-failed and still ends the outage', async ({ page }) => {
    const result = await page.evaluate(async () => {
      await window.__webrtcInspector.setFakeCam({ width: 64, height: 48 });
      const { connectionIdA } = await window.testHelpers.createLoopbackSession('media-restore-fail', async (pcA) => {
        const stream = await navigator.mediaDevices.getUserMedia({ video: true });
        stream.getTracks().forEach((t) => pcA.addTrack(t, stream));
      });
      const sender = window.__pcA.getSenders().find((s) => s.track && s.track.kind === 'video');
      const trackId = sender.track.id;

      window.__events = [];
      window.__webrtcInspector.onEvent((e) => window.__events.push(e));

      const loss = window.__webrtcInspector.simulateNetworkLoss(200, { targets: ['media'] });
      window.__forceRestoreReject = true; // only the restore call fails, not the blackout's replaceTrack(null)
      await loss.done;

      return {
        eventTypes: window.__events.map((e) => e.type),
        failureEvent: window.__events.find((e) => e.type === 'media-blackout-restore-failed'),
        senderTrackAfter: sender.track,
        connectionIdA,
        trackId,
      };
    });

    expect(result.eventTypes).toContain('media-blackout-restore-failed');
    expect(result.eventTypes).toContain('network-loss-end'); // the outage still ends — one bad sender must not hang the rest
    expect(result.failureEvent.connectionId).toBe(result.connectionIdA);
    expect(result.failureEvent.kind).toBe('video');
    expect(result.failureEvent.trackId).toBe(result.trackId);
    expect(result.failureEvent.error).toContain('simulated restore failure');
    // The sender is genuinely left dark — the event is reporting a real, not cosmetic, gap.
    expect(result.senderTrackAfter).toBeNull();
  });

  test('a successful restore still emits no failure event', async ({ page }) => {
    const result = await page.evaluate(async () => {
      await window.__webrtcInspector.setFakeCam({ width: 64, height: 48 });
      await window.testHelpers.createLoopbackSession('media-restore-ok', async (pcA) => {
        const stream = await navigator.mediaDevices.getUserMedia({ video: true });
        stream.getTracks().forEach((t) => pcA.addTrack(t, stream));
      });
      window.__events = [];
      window.__webrtcInspector.onEvent((e) => window.__events.push(e));
      const loss = window.__webrtcInspector.simulateNetworkLoss(200, { targets: ['media'] });
      await loss.done; // __forceRestoreReject stays false
      return window.__events.map((e) => e.type);
    });
    expect(result).not.toContain('media-blackout-restore-failed');
    expect(result).toContain('network-loss-end');
  });
});
