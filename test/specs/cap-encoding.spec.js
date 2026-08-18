const { test, expect } = require('@playwright/test');
const { gotoFixture } = require('../helpers');

// capEncoding rides RTCRtpSender.getParameters()/setParameters() — a real
// track (via setFakeCam) is added so there's a genuine video sender with
// encodings to cap, no mocking of RTCRtpSender itself.

test.describe('capEncoding()', () => {
  test.beforeEach(async ({ page }) => {
    await gotoFixture(page);
  });

  test('sets maxBitrate/maxFramerate/scaleResolutionDownBy on the active video sender', async ({ page }) => {
    const result = await page.evaluate(async () => {
      await window.__webrtcInspector.setFakeCam({ width: 64, height: 48 });
      const { connectionIdA } = await window.testHelpers.createLoopbackSession('cap-encoding', async (pcA) => {
        const stream = await navigator.mediaDevices.getUserMedia({ video: true });
        stream.getTracks().forEach((t) => pcA.addTrack(t, stream));
      });
      await window.__webrtcInspector.capEncoding(connectionIdA, 'video', {
        maxBitrate: 100000,
        maxFramerate: 15,
        scaleResolutionDownBy: 2,
      });
      const sender = window.__pcA.getSenders().find((s) => s.track && s.track.kind === 'video');
      return sender.getParameters().encodings[0];
    });
    expect(result.maxBitrate).toBe(100000);
    expect(result.maxFramerate).toBe(15);
    expect(result.scaleResolutionDownBy).toBe(2);
  });

  test('sets degradationPreference on the sender parameters', async ({ page }) => {
    const result = await page.evaluate(async () => {
      await window.__webrtcInspector.setFakeCam({ width: 64, height: 48 });
      const { connectionIdA } = await window.testHelpers.createLoopbackSession('cap-degradation', async (pcA) => {
        const stream = await navigator.mediaDevices.getUserMedia({ video: true });
        stream.getTracks().forEach((t) => pcA.addTrack(t, stream));
      });
      await window.__webrtcInspector.capEncoding(connectionIdA, 'video', { degradationPreference: 'maintain-framerate' });
      const sender = window.__pcA.getSenders().find((s) => s.track && s.track.kind === 'video');
      return sender.getParameters().degradationPreference;
    });
    expect(result).toBe('maintain-framerate');
  });

  test('omitted fields are left untouched across two successive calls', async ({ page }) => {
    const result = await page.evaluate(async () => {
      await window.__webrtcInspector.setFakeCam({ width: 64, height: 48 });
      const { connectionIdA } = await window.testHelpers.createLoopbackSession('cap-partial', async (pcA) => {
        const stream = await navigator.mediaDevices.getUserMedia({ video: true });
        stream.getTracks().forEach((t) => pcA.addTrack(t, stream));
      });
      await window.__webrtcInspector.capEncoding(connectionIdA, 'video', { maxBitrate: 200000 });
      await window.__webrtcInspector.capEncoding(connectionIdA, 'video', { maxFramerate: 10 });
      const sender = window.__pcA.getSenders().find((s) => s.track && s.track.kind === 'video');
      return sender.getParameters().encodings[0];
    });
    expect(result.maxBitrate).toBe(200000);
    expect(result.maxFramerate).toBe(10);
  });

  test('throws for an unknown connection id', async ({ page }) => {
    const threw = await page.evaluate(async () => {
      try {
        await window.__webrtcInspector.capEncoding(999999, 'video', { maxBitrate: 1000 });
        return false;
      } catch {
        return true;
      }
    });
    expect(threw).toBe(true);
  });

  test('throws when there is no active sender of the requested kind', async ({ page }) => {
    const threw = await page.evaluate(async () => {
      const { connectionIdA } = await window.testHelpers.createLoopbackSession();
      try {
        await window.__webrtcInspector.capEncoding(connectionIdA, 'video', { maxBitrate: 1000 });
        return false;
      } catch {
        return true;
      }
    });
    expect(threw).toBe(true);
  });

  test('a capped bitrate keeps the connection healthy — real packets still flow', async ({ page }) => {
    const result = await page.evaluate(async () => {
      await window.__webrtcInspector.setFakeCam({ width: 64, height: 48 });
      const { connectionIdA } = await window.testHelpers.createLoopbackSession('cap-flow', async (pcA) => {
        const stream = await navigator.mediaDevices.getUserMedia({ video: true });
        stream.getTracks().forEach((t) => pcA.addTrack(t, stream));
      });
      await window.__webrtcInspector.capEncoding(connectionIdA, 'video', { maxBitrate: 50000, maxFramerate: 5 });
      await window.testHelpers.wait(600);
      const stats = await window.__pcA.getStats();
      let packetsSent = 0;
      stats.forEach((s) => { if (s.type === 'outbound-rtp' && s.kind === 'video') packetsSent += s.packetsSent || 0; });
      return packetsSent;
    });
    expect(result).toBeGreaterThan(0);
  });
});
