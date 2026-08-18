const { test, expect } = require('@playwright/test');
const { gotoFixture } = require('../helpers');

// As with the other derived-metric suites, getStats() is overridden on the
// live pc instance to feed deterministic RTCP-adjacent numbers into the
// existing 2s poll, exercising the real E-model/bitrate-heuristic math
// without depending on headless Chromium's fake devices to produce real
// network impairment.

test.describe('MOS-style quality score', () => {
  test.beforeEach(async ({ page }) => {
    await gotoFixture(page);
    await page.evaluate(() => window.testHelpers.createLoopbackSession());
  });

  test('good audio RTCP numbers yield a high score', async ({ page }) => {
    const connectionIdA = await page.evaluate(() => {
      window.__pcA.getStats = async () => new Map([
        ['pair1', { id: 'pair1', type: 'candidate-pair', nominated: true, state: 'succeeded', currentRoundTripTime: 0.01 }],
        ['a1', { id: 'a1', type: 'inbound-rtp', kind: 'audio', jitter: 0.001, packetsLost: 0, packetsReceived: 1000 }],
      ]);
      return window.__webrtcInspector.getSnapshot().connections[0].id;
    });
    await page.waitForFunction(
      (id) => window.__webrtcInspector.getSnapshot().connections.find((c) => c.id === id).qualityScore !== null,
      connectionIdA,
      { timeout: 3000 }
    );
    const snap = await page.evaluate(() => window.__webrtcInspector.getSnapshot());
    expect(snap.connections.find((c) => c.id === connectionIdA).qualityScore).toBeGreaterThan(4);
  });

  test('bad audio RTCP numbers (high RTT/jitter/loss) yield a floor score of 1', async ({ page }) => {
    const connectionIdA = await page.evaluate(() => {
      window.__pcA.getStats = async () => new Map([
        ['pair1', { id: 'pair1', type: 'candidate-pair', nominated: true, state: 'succeeded', currentRoundTripTime: 0.5 }],
        ['a1', { id: 'a1', type: 'inbound-rtp', kind: 'audio', jitter: 0.1, packetsLost: 500, packetsReceived: 500 }],
      ]);
      return window.__webrtcInspector.getSnapshot().connections[0].id;
    });
    await page.waitForFunction(
      (id) => window.__webrtcInspector.getSnapshot().connections.find((c) => c.id === id).qualityScore !== null,
      connectionIdA,
      { timeout: 3000 }
    );
    const snap = await page.evaluate(() => window.__webrtcInspector.getSnapshot());
    expect(snap.connections.find((c) => c.id === connectionIdA).qualityScore).toBe(1);
  });

  test('a high bits-per-pixel video stream yields a high score', async ({ page }) => {
    const connectionIdA = await page.evaluate(async () => {
      const id = window.__webrtcInspector.getSnapshot().connections[0].id;
      window.__pcA.getStats = async () => new Map([
        ['v1', { id: 'v1', type: 'inbound-rtp', kind: 'video', bytesReceived: 0, frameWidth: 1280, frameHeight: 720, framesPerSecond: 30 }],
      ]);
      await window.testHelpers.wait(2200);
      // ~1.38MB over the elapsed tick at 1280x720@30fps is a bits-per-pixel
      // ratio well above the 0.12 top of the scoring range even with timing jitter.
      window.__pcA.getStats = async () => new Map([
        ['v1', { id: 'v1', type: 'inbound-rtp', kind: 'video', bytesReceived: 1382400, frameWidth: 1280, frameHeight: 720, framesPerSecond: 30 }],
      ]);
      return id;
    });
    await page.waitForFunction(
      (id) => window.__webrtcInspector.getSnapshot().connections.find((c) => c.id === id).qualityScore !== null,
      connectionIdA,
      { timeout: 3000 }
    );
    const snap = await page.evaluate(() => window.__webrtcInspector.getSnapshot());
    expect(snap.connections.find((c) => c.id === connectionIdA).qualityScore).toBeGreaterThanOrEqual(4.9);
  });

  test('a very low bits-per-pixel video stream yields a floor score of 1', async ({ page }) => {
    const connectionIdA = await page.evaluate(async () => {
      const id = window.__webrtcInspector.getSnapshot().connections[0].id;
      window.__pcA.getStats = async () => new Map([
        ['v1', { id: 'v1', type: 'inbound-rtp', kind: 'video', bytesReceived: 0, frameWidth: 1280, frameHeight: 720, framesPerSecond: 30 }],
      ]);
      await window.testHelpers.wait(2200);
      window.__pcA.getStats = async () => new Map([
        ['v1', { id: 'v1', type: 'inbound-rtp', kind: 'video', bytesReceived: 6912, frameWidth: 1280, frameHeight: 720, framesPerSecond: 30 }],
      ]);
      return id;
    });
    await page.waitForFunction(
      (id) => window.__webrtcInspector.getSnapshot().connections.find((c) => c.id === id).qualityScore !== null,
      connectionIdA,
      { timeout: 3000 }
    );
    const snap = await page.evaluate(() => window.__webrtcInspector.getSnapshot());
    expect(snap.connections.find((c) => c.id === connectionIdA).qualityScore).toBe(1);
  });

  test('averages audio and video subscores when both are present', async ({ page }) => {
    const connectionIdA = await page.evaluate(async () => {
      const id = window.__webrtcInspector.getSnapshot().connections[0].id;
      window.__pcA.getStats = async () => new Map([
        ['pair1', { id: 'pair1', type: 'candidate-pair', nominated: true, state: 'succeeded', currentRoundTripTime: 0.01 }],
        ['a1', { id: 'a1', type: 'inbound-rtp', kind: 'audio', jitter: 0.001, packetsLost: 0, packetsReceived: 1000 }],
        ['v1', { id: 'v1', type: 'inbound-rtp', kind: 'video', bytesReceived: 0, frameWidth: 1280, frameHeight: 720, framesPerSecond: 30 }],
      ]);
      await window.testHelpers.wait(2200);
      window.__pcA.getStats = async () => new Map([
        ['pair1', { id: 'pair1', type: 'candidate-pair', nominated: true, state: 'succeeded', currentRoundTripTime: 0.01 }],
        ['a1', { id: 'a1', type: 'inbound-rtp', kind: 'audio', jitter: 0.001, packetsLost: 0, packetsReceived: 2000 }],
        ['v1', { id: 'v1', type: 'inbound-rtp', kind: 'video', bytesReceived: 1382400, frameWidth: 1280, frameHeight: 720, framesPerSecond: 30 }],
      ]);
      return id;
    });
    await page.waitForFunction(
      (id) => window.__webrtcInspector.getSnapshot().connections.find((c) => c.id === id).qualityScore !== null,
      connectionIdA,
      { timeout: 3000 }
    );
    const snap = await page.evaluate(() => window.__webrtcInspector.getSnapshot());
    const score = snap.connections.find((c) => c.id === connectionIdA).qualityScore;
    // audio subscore ~4.4 (good RTCP numbers), video subscore ~5 (high bpp) -> average strictly between either alone.
    expect(score).toBeGreaterThan(4.3);
    expect(score).toBeLessThan(5);
  });
});
