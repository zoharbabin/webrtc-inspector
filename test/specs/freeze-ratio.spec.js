const { test, expect } = require('@playwright/test');
const { gotoFixture } = require('../helpers');

// As with the candidate-flip/av-sync suites, getStats() is overridden on the
// live pc instance so freezeCount/totalFreezesDuration can be fed
// deterministically into the existing 2s poll instead of depending on
// headless Chromium's fake video device to actually produce freezes.

test.describe('Freeze ratio / quality flag', () => {
  async function setupRemoteVideoTrack(page) {
    return page.evaluate(async () => {
      await window.__webrtcInspector.setFakeCam({ width: 64, height: 48 });
      const stream = await navigator.mediaDevices.getUserMedia({ video: true });
      const { connectionIdB } = await window.testHelpers.createLoopbackSession('test-channel', (pcA) => {
        pcA.addTrack(stream.getVideoTracks()[0], stream);
      });
      await window.testHelpers.waitFor(() => {
        const recB = window.__webrtcInspector.getSnapshot().connections.find((c) => c.id === connectionIdB);
        return !!recB && recB.remoteTracks.length > 0;
      });
      const recB = window.__webrtcInspector.getSnapshot().connections.find((c) => c.id === connectionIdB);
      return { connectionIdB, trackId: recB.remoteTracks[0].trackId };
    });
  }

  test('flags a track with no freezes as ok', async ({ page }) => {
    await gotoFixture(page);
    const { connectionIdB, trackId } = await setupRemoteVideoTrack(page);
    await page.evaluate((tid) => {
      window.__pcB.getStats = async () => new Map([
        ['v1', { id: 'v1', type: 'inbound-rtp', kind: 'video', trackIdentifier: tid, freezeCount: 0, totalFreezesDuration: 0 }],
      ]);
    }, trackId);
    await page.waitForFunction(
      ({ id, tid }) => {
        const rec = window.__webrtcInspector.getSnapshot().connections.find((c) => c.id === id);
        const t = rec && rec.remoteTracks.find((x) => x.trackId === tid);
        return !!t && t.qualityFlag !== null;
      },
      { id: connectionIdB, tid: trackId },
      { timeout: 3000 }
    );
    const snap = await page.evaluate(() => window.__webrtcInspector.getSnapshot());
    const track = snap.connections.find((c) => c.id === connectionIdB).remoteTracks.find((t) => t.trackId === trackId);
    expect(track.freezeCount).toBe(0);
    expect(track.freezeRatio).toBe(0);
    expect(track.qualityFlag).toBe('ok');
  });

  test('flags a track with a moderate freeze ratio as degraded', async ({ page }) => {
    await gotoFixture(page);
    const { connectionIdB, trackId } = await setupRemoteVideoTrack(page);
    await page.evaluate((tid) => {
      // ~2-4s will have elapsed by the next poll tick; 0.06s of freezing
      // lands comfortably inside the (1%, 10%) degraded band either way.
      window.__pcB.getStats = async () => new Map([
        ['v1', { id: 'v1', type: 'inbound-rtp', kind: 'video', trackIdentifier: tid, freezeCount: 2, totalFreezesDuration: 0.06 }],
      ]);
    }, trackId);
    await page.waitForFunction(
      ({ id, tid }) => {
        const rec = window.__webrtcInspector.getSnapshot().connections.find((c) => c.id === id);
        const t = rec && rec.remoteTracks.find((x) => x.trackId === tid);
        return !!t && t.qualityFlag !== null;
      },
      { id: connectionIdB, tid: trackId },
      { timeout: 3000 }
    );
    const snap = await page.evaluate(() => window.__webrtcInspector.getSnapshot());
    const track = snap.connections.find((c) => c.id === connectionIdB).remoteTracks.find((t) => t.trackId === trackId);
    expect(track.freezeCount).toBe(2);
    expect(track.freezeRatio).toBeGreaterThan(0.01);
    expect(track.freezeRatio).toBeLessThan(0.10);
    expect(track.qualityFlag).toBe('degraded');
  });

  test('flags a track with a heavy freeze ratio as bad', async ({ page }) => {
    await gotoFixture(page);
    const { connectionIdB, trackId } = await setupRemoteVideoTrack(page);
    await page.evaluate((tid) => {
      // 1000s of freezing is >10% of elapsed time under any realistic test timing.
      window.__pcB.getStats = async () => new Map([
        ['v1', { id: 'v1', type: 'inbound-rtp', kind: 'video', trackIdentifier: tid, freezeCount: 50, totalFreezesDuration: 1000 }],
      ]);
    }, trackId);
    await page.waitForFunction(
      ({ id, tid }) => {
        const rec = window.__webrtcInspector.getSnapshot().connections.find((c) => c.id === id);
        const t = rec && rec.remoteTracks.find((x) => x.trackId === tid);
        return !!t && t.qualityFlag !== null;
      },
      { id: connectionIdB, tid: trackId },
      { timeout: 3000 }
    );
    const snap = await page.evaluate(() => window.__webrtcInspector.getSnapshot());
    const track = snap.connections.find((c) => c.id === connectionIdB).remoteTracks.find((t) => t.trackId === trackId);
    expect(track.freezeRatio).toBeGreaterThan(0.10);
    expect(track.qualityFlag).toBe('bad');
  });
});
