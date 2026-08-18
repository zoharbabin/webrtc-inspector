const { test, expect } = require('@playwright/test');
const { gotoFixture } = require('../helpers');

// Headless Chromium's fake audio device doesn't reliably produce real
// inbound-rtp audio packets for a synthetic loopback session, so — as with
// the candidate-flip tests — getStats() is overridden on the live pc instance
// to feed synthetic inbound-rtp reports into the existing 2s poll, exercising
// the real jitter-buffer-delta math deterministically.

test.describe('Audio/video sync delta', () => {
  test.beforeEach(async ({ page }) => {
    await gotoFixture(page);
    await page.evaluate(() => window.testHelpers.createLoopbackSession());
  });

  test('computes the audio-minus-video jitter buffer delta in ms', async ({ page }) => {
    const connectionIdA = await page.evaluate(() => {
      window.__pcA.getStats = async () => new Map([
        ['audio1', { id: 'audio1', type: 'inbound-rtp', kind: 'audio', jitterBufferDelay: 0.5, jitterBufferEmittedCount: 100 }],
        ['video1', { id: 'video1', type: 'inbound-rtp', kind: 'video', jitterBufferDelay: 0.2, jitterBufferEmittedCount: 100 }],
      ]);
      return window.__webrtcInspector.getSnapshot().connections[0].id;
    });
    await page.waitForFunction(
      (id) => window.__webrtcInspector.getSnapshot().connections.find((c) => c.id === id).avSyncDeltaMs !== null,
      connectionIdA,
      { timeout: 3000 }
    );
    const snap = await page.evaluate(() => window.__webrtcInspector.getSnapshot());
    const recA = snap.connections.find((c) => c.id === connectionIdA);
    // audio avg = 500/100=5ms, video avg = 200/100=2ms, delta = +3ms (audio lagging behind video)
    expect(recA.avSyncDeltaMs).toBeCloseTo(3, 5);
  });

  test('is null when only one kind is present', async ({ page }) => {
    const connectionIdA = await page.evaluate(() => {
      window.__pcA.getStats = async () => new Map([
        ['audio1', { id: 'audio1', type: 'inbound-rtp', kind: 'audio', jitterBufferDelay: 0.5, jitterBufferEmittedCount: 100 }],
      ]);
      return window.__webrtcInspector.getSnapshot().connections[0].id;
    });
    await page.evaluate(() => window.testHelpers.wait(2200));
    const snap = await page.evaluate(() => window.__webrtcInspector.getSnapshot());
    const recA = snap.connections.find((c) => c.id === connectionIdA);
    expect(recA.avSyncDeltaMs).toBeNull();
  });

  test('updates as the delta narrows across polls', async ({ page }) => {
    const connectionIdA = await page.evaluate(() => {
      window.__pcA.getStats = async () => new Map([
        ['audio1', { id: 'audio1', type: 'inbound-rtp', kind: 'audio', jitterBufferDelay: 1.0, jitterBufferEmittedCount: 100 }],
        ['video1', { id: 'video1', type: 'inbound-rtp', kind: 'video', jitterBufferDelay: 0.2, jitterBufferEmittedCount: 100 }],
      ]);
      return window.__webrtcInspector.getSnapshot().connections[0].id;
    });
    await page.waitForFunction(
      (id) => window.__webrtcInspector.getSnapshot().connections.find((c) => c.id === id).avSyncDeltaMs > 5,
      connectionIdA,
      { timeout: 3000 }
    );
    await page.evaluate(() => {
      window.__pcA.getStats = async () => new Map([
        ['audio1', { id: 'audio1', type: 'inbound-rtp', kind: 'audio', jitterBufferDelay: 0.2, jitterBufferEmittedCount: 100 }],
        ['video1', { id: 'video1', type: 'inbound-rtp', kind: 'video', jitterBufferDelay: 0.2, jitterBufferEmittedCount: 100 }],
      ]);
    });
    await page.waitForFunction(
      (id) => window.__webrtcInspector.getSnapshot().connections.find((c) => c.id === id).avSyncDeltaMs === 0,
      connectionIdA,
      { timeout: 3000 }
    );
  });
});
