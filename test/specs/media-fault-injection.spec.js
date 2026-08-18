const { test, expect } = require('@playwright/test');
const { gotoFixture } = require('../helpers');

// Chromium-only: setMediaFaultInjector rides RTCRtpSender/Receiver's
// createEncodedStreams() (a Chrome extension, not yet a cross-browser
// standard). beforeOffer adds a real fake-cam video track (and, in the mixed
// test, a real fake-mic audio track too) so encoded frames genuinely flow
// over the loopback connection's real DTLS-SRTP transport — no mocking of
// RTCRtpSender/Receiver itself.

test.describe('setMediaFaultInjector() / clearMediaFaultInjector()', () => {
  test.beforeEach(async ({ page }) => {
    await gotoFixture(page);
  });

  test('mediaFaultInjectorActive flag reflects set/clear', async ({ page }) => {
    const states = await page.evaluate(() => {
      const before = window.__webrtcInspector.getSnapshot().mediaFaultInjectorActive;
      window.__webrtcInspector.setMediaFaultInjector(null, null, () => {});
      const during = window.__webrtcInspector.getSnapshot().mediaFaultInjectorActive;
      window.__webrtcInspector.clearMediaFaultInjector();
      const after = window.__webrtcInspector.getSnapshot().mediaFaultInjectorActive;
      return { before, during, after };
    });
    expect(states).toEqual({ before: false, during: true, after: false });
  });

  test('fn is invoked for outgoing video frames with connId/kind/direction metadata', async ({ page }) => {
    const result = await page.evaluate(async () => {
      window.__calls = [];
      window.__webrtcInspector.setMediaFaultInjector(null, null, (direction, frame, meta) => {
        window.__calls.push({ direction, kind: meta.kind, connId: meta.connId });
      });
      await window.__webrtcInspector.setFakeCam({ width: 64, height: 48 });
      const { connectionIdA } = await window.testHelpers.createLoopbackSession('mfi', async (pcA) => {
        const stream = await navigator.mediaDevices.getUserMedia({ video: true });
        stream.getTracks().forEach((t) => pcA.addTrack(t, stream));
      });
      const ok = await window.testHelpers.waitFor(() => window.__calls.some((c) => c.direction === 'outgoing' && c.kind === 'video'));
      const call = window.__calls.find((c) => c.direction === 'outgoing' && c.kind === 'video');
      return { ok, connId: call && call.connId, connectionIdA };
    });
    expect(result.ok).toBe(true);
    expect(result.connId).toBe(result.connectionIdA);
  });

  test('connId scoping: an injector scoped to a different connId never fires', async ({ page }) => {
    const result = await page.evaluate(async () => {
      window.__calls = 0;
      await window.__webrtcInspector.setFakeCam({ width: 64, height: 48 });
      const { connectionIdA } = await window.testHelpers.createLoopbackSession('mfi-scope', async (pcA) => {
        const stream = await navigator.mediaDevices.getUserMedia({ video: true });
        stream.getTracks().forEach((t) => pcA.addTrack(t, stream));
      });
      window.__webrtcInspector.setMediaFaultInjector(connectionIdA + 1000, null, () => { window.__calls++; });
      await window.testHelpers.wait(400);
      return window.__calls;
    });
    expect(result).toBe(0);
  });

  test('kind scoping: an audio-only injector never receives video frames', async ({ page }) => {
    const result = await page.evaluate(async () => {
      window.__kinds = new Set();
      window.__webrtcInspector.setMediaFaultInjector(null, 'audio', (direction, frame, meta) => { window.__kinds.add(meta.kind); });
      await window.__webrtcInspector.setFakeCam({ width: 64, height: 48 });
      await window.testHelpers.createLoopbackSession('mfi-kind', async (pcA) => {
        const camStream = await navigator.mediaDevices.getUserMedia({ video: true });
        const micStream = await navigator.mediaDevices.getUserMedia({ audio: true });
        camStream.getTracks().forEach((t) => pcA.addTrack(t, camStream));
        micStream.getTracks().forEach((t) => pcA.addTrack(t, micStream));
      });
      await window.testHelpers.waitFor(() => window.__kinds.has('audio'));
      return Array.from(window.__kinds);
    });
    expect(result).toEqual(['audio']);
  });

  test('returning false drops outgoing video frames — sender packetsSent stays at 0', async ({ page }) => {
    const result = await page.evaluate(async () => {
      window.__webrtcInspector.setMediaFaultInjector(null, 'video', () => false);
      await window.__webrtcInspector.setFakeCam({ width: 64, height: 48 });
      await window.testHelpers.createLoopbackSession('mfi-drop', async (pcA) => {
        const stream = await navigator.mediaDevices.getUserMedia({ video: true });
        stream.getTracks().forEach((t) => pcA.addTrack(t, stream));
      });
      await window.testHelpers.wait(600);
      const stats = await window.__pcA.getStats();
      let packetsSent = 0;
      stats.forEach((s) => { if (s.type === 'outbound-rtp' && s.kind === 'video') packetsSent += s.packetsSent || 0; });
      return packetsSent;
    });
    expect(result).toBe(0);
  });

  test('mutating frame.data (corrupt) still lets packets flow — sender packetsSent grows', async ({ page }) => {
    const result = await page.evaluate(async () => {
      window.__webrtcInspector.setMediaFaultInjector(null, 'video', (direction, frame) => {
        const bytes = new Uint8Array(frame.data);
        if (bytes.length > 0) bytes[0] = bytes[0] ^ 0xff;
      });
      await window.__webrtcInspector.setFakeCam({ width: 64, height: 48 });
      await window.testHelpers.createLoopbackSession('mfi-corrupt', async (pcA) => {
        const stream = await navigator.mediaDevices.getUserMedia({ video: true });
        stream.getTracks().forEach((t) => pcA.addTrack(t, stream));
      });
      await window.testHelpers.wait(600);
      const stats = await window.__pcA.getStats();
      let packetsSent = 0;
      stats.forEach((s) => { if (s.type === 'outbound-rtp' && s.kind === 'video') packetsSent += s.packetsSent || 0; });
      return packetsSent;
    });
    expect(result).toBeGreaterThan(0);
  });

  test("'duplicate' and {delayMs} actions don't stall the pipeline — connection stays connected and fn keeps firing", async ({ page }) => {
    const result = await page.evaluate(async () => {
      window.__calls = 0;
      window.__webrtcInspector.setMediaFaultInjector(null, 'video', () => {
        window.__calls++;
        return window.__calls % 2 === 0 ? 'duplicate' : { delayMs: 50 };
      });
      await window.__webrtcInspector.setFakeCam({ width: 64, height: 48 });
      const { connectionIdA } = await window.testHelpers.createLoopbackSession('mfi-dup-delay', async (pcA) => {
        const stream = await navigator.mediaDevices.getUserMedia({ video: true });
        stream.getTracks().forEach((t) => pcA.addTrack(t, stream));
      });
      await window.testHelpers.waitFor(() => window.__calls >= 5, 3000);
      const conn = window.__webrtcInspector.getSnapshot().connections.find((c) => c.id === connectionIdA);
      return { calls: window.__calls, state: conn.state.connectionState };
    });
    expect(result.calls).toBeGreaterThanOrEqual(5);
    expect(result.state).not.toBe('failed');
  });

  test('clearMediaFaultInjector stops further invocations', async ({ page }) => {
    const result = await page.evaluate(async () => {
      window.__calls = 0;
      window.__webrtcInspector.setMediaFaultInjector(null, 'video', () => { window.__calls++; });
      await window.__webrtcInspector.setFakeCam({ width: 64, height: 48 });
      await window.testHelpers.createLoopbackSession('mfi-clear', async (pcA) => {
        const stream = await navigator.mediaDevices.getUserMedia({ video: true });
        stream.getTracks().forEach((t) => pcA.addTrack(t, stream));
      });
      await window.testHelpers.waitFor(() => window.__calls > 0);
      window.__webrtcInspector.clearMediaFaultInjector();
      const afterClear = window.__calls;
      await window.testHelpers.wait(300);
      return { afterClear, final: window.__calls };
    });
    expect(result.afterClear).toBeGreaterThan(0);
    expect(result.final).toBe(result.afterClear);
  });
});
