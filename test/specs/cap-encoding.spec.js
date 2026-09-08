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

  test('emits encoding-capped only after setParameters resolves', async ({ page }) => {
    const result = await page.evaluate(async () => {
      await window.__webrtcInspector.setFakeCam({ width: 64, height: 48 });
      const { connectionIdA } = await window.testHelpers.createLoopbackSession('cap-event', async (pcA) => {
        const stream = await navigator.mediaDevices.getUserMedia({ video: true });
        stream.getTracks().forEach((t) => pcA.addTrack(t, stream));
      });
      window.__events = [];
      window.__webrtcInspector.onEvent((e) => window.__events.push(e));
      await window.__webrtcInspector.capEncoding(connectionIdA, 'video', { maxBitrate: 100000 });
      const evt = window.__events.find((e) => e.type === 'encoding-capped');
      return { evt, connectionIdA };
    });
    expect(result.evt).toBeDefined();
    expect(result.evt.connectionId).toBe(result.connectionIdA);
    expect(result.evt.kind).toBe('video');
    expect(result.evt.caps).toEqual({ maxBitrate: 100000 });
  });

  test('a rejected setParameters emits encoding-cap-failed, not encoding-capped', async ({ page }) => {
    const result = await page.evaluate(async () => {
      await window.__webrtcInspector.setFakeCam({ width: 64, height: 48 });
      const { connectionIdA } = await window.testHelpers.createLoopbackSession('cap-fail', async (pcA) => {
        const stream = await navigator.mediaDevices.getUserMedia({ video: true });
        stream.getTracks().forEach((t) => pcA.addTrack(t, stream));
      });
      window.__pcA.close(); // a closed connection's sender rejects setParameters (InvalidStateError)
      window.__events = [];
      window.__webrtcInspector.onEvent((e) => window.__events.push(e));
      let rejected = false;
      try {
        await window.__webrtcInspector.capEncoding(connectionIdA, 'video', { maxBitrate: 100000 });
      } catch (_) {
        rejected = true;
      }
      return { rejected, eventTypes: window.__events.map((e) => e.type) };
    });
    expect(result.rejected).toBe(true);
    expect(result.eventTypes).toContain('encoding-cap-failed');
    expect(result.eventTypes).not.toContain('encoding-capped');
  });

  // getParameters()/setParameters() share a hidden per-sender transaction id
  // that the browser bumps on every getParameters() call and validates on
  // setParameters() — without serializing per sender, the second of two
  // concurrent capEncoding() calls on the same sender rejects with
  // InvalidStateError, even though both calls are individually valid.
  test('two concurrent calls on the same sender both apply instead of one racing to a rejection', async ({ page }) => {
    const result = await page.evaluate(async () => {
      await window.__webrtcInspector.setFakeCam({ width: 64, height: 48 });
      const { connectionIdA } = await window.testHelpers.createLoopbackSession('cap-race', async (pcA) => {
        const stream = await navigator.mediaDevices.getUserMedia({ video: true });
        stream.getTracks().forEach((t) => pcA.addTrack(t, stream));
      });
      const p1 = window.__webrtcInspector.capEncoding(connectionIdA, 'video', { maxBitrate: 100000 });
      const p2 = window.__webrtcInspector.capEncoding(connectionIdA, 'video', { maxFramerate: 12 });
      const settled = await Promise.allSettled([p1, p2]);
      const sender = window.__pcA.getSenders().find((s) => s.track && s.track.kind === 'video');
      return { statuses: settled.map((s) => s.status), encoding: sender.getParameters().encodings[0] };
    });
    expect(result.statuses).toEqual(['fulfilled', 'fulfilled']);
    expect(result.encoding.maxBitrate).toBe(100000);
    expect(result.encoding.maxFramerate).toBe(12);
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
