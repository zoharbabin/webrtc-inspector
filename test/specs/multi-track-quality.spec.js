const { test, expect } = require('@playwright/test');
const { gotoFixture, STATS_POLL_WAIT_MS } = require('../helpers');

// Before this fix, updateQualityScore()/updateAvSyncDelta() picked "the"
// audio/video inbound-rtp report with reports.find() — fine for the common
// single-track-per-kind case, but on a connection with more than one remote
// track of the same kind (e.g. camera + screen-share video) that silently
// scored whichever report getStats() happened to list first, and
// getTrackDiagnostics() reported that same arbitrary connection-level number
// back for every track queried, regardless of which one was actually asked
// about. Now each remote track gets its own qualityScore correlated by
// trackIdentifier, and avSyncDeltaMs goes null instead of guessing when a
// kind has more than one report.

test.describe('Multi-track quality/AV-sync (no silent single-track guessing)', () => {
  async function setupTwoRemoteVideoTracks(page) {
    return page.evaluate(async () => {
      await window.__webrtcInspector.setFakeCam({ width: 64, height: 48 });
      const stream1 = await navigator.mediaDevices.getUserMedia({ video: true });
      const stream2 = await navigator.mediaDevices.getUserMedia({ video: true });
      const { connectionIdB } = await window.testHelpers.createLoopbackSession('test-channel', (pcA) => {
        pcA.addTrack(stream1.getVideoTracks()[0], stream1);
        pcA.addTrack(stream2.getVideoTracks()[0], stream2);
      });
      await window.testHelpers.waitFor(() => {
        const recB = window.__webrtcInspector.getSnapshot().connections.find((c) => c.id === connectionIdB);
        return !!recB && recB.remoteTracks.length === 2;
      });
      const recB = window.__webrtcInspector.getSnapshot().connections.find((c) => c.id === connectionIdB);
      return { connectionIdB, tid1: recB.remoteTracks[0].trackId, tid2: recB.remoteTracks[1].trackId };
    });
  }

  test('each remote track gets its own quality score, not the same arbitrary one', async ({ page }) => {
    await gotoFixture(page);
    const { connectionIdB, tid1, tid2 } = await setupTwoRemoteVideoTracks(page);

    await page.evaluate(({ tid1, tid2 }) => {
      // Track 1 starts at a low bitrate, track 2 at a high one, so their
      // bits-per-pixel scores diverge once the second poll can diff bytes.
      window.__pcB.getStats = async () => new Map([
        ['v1', { id: 'v1', type: 'inbound-rtp', kind: 'video', trackIdentifier: tid1, bytesReceived: 0, frameWidth: 1280, frameHeight: 720, framesPerSecond: 30 }],
        ['v2', { id: 'v2', type: 'inbound-rtp', kind: 'video', trackIdentifier: tid2, bytesReceived: 0, frameWidth: 1280, frameHeight: 720, framesPerSecond: 30 }],
      ]);
    }, { tid1, tid2 });
    await page.evaluate(() => window.testHelpers.wait(2200));
    await page.evaluate(({ tid1, tid2 }) => {
      window.__pcB.getStats = async () => new Map([
        // ~1.38MB/poll: well above the scoring range's top (high score).
        ['v1', { id: 'v1', type: 'inbound-rtp', kind: 'video', trackIdentifier: tid1, bytesReceived: 1382400, frameWidth: 1280, frameHeight: 720, framesPerSecond: 30 }],
        // ~6.9KB/poll: well below the scoring range's bottom (floor score).
        ['v2', { id: 'v2', type: 'inbound-rtp', kind: 'video', trackIdentifier: tid2, bytesReceived: 6912, frameWidth: 1280, frameHeight: 720, framesPerSecond: 30 }],
      ]);
    }, { tid1, tid2 });

    await page.waitForFunction(
      ({ id, tid1, tid2 }) => {
        const rec = window.__webrtcInspector.getSnapshot().connections.find((c) => c.id === id);
        const t1 = rec && rec.remoteTracks.find((t) => t.trackId === tid1);
        const t2 = rec && rec.remoteTracks.find((t) => t.trackId === tid2);
        return !!t1 && !!t2 && t1.qualityScore !== null && t2.qualityScore !== null;
      },
      { id: connectionIdB, tid1, tid2 },
      { timeout: STATS_POLL_WAIT_MS }
    );

    const { score1, score2, diag1, diag2 } = await page.evaluate(({ id, tid1, tid2 }) => {
      const rec = window.__webrtcInspector.getSnapshot().connections.find((c) => c.id === id);
      return {
        score1: rec.remoteTracks.find((t) => t.trackId === tid1).qualityScore,
        score2: rec.remoteTracks.find((t) => t.trackId === tid2).qualityScore,
        diag1: window.__webrtcInspector.getTrackDiagnostics([tid1]).qualityScore,
        diag2: window.__webrtcInspector.getTrackDiagnostics([tid2]).qualityScore,
      };
    }, { id: connectionIdB, tid1, tid2 });

    expect(score1).toBeGreaterThanOrEqual(4.9);
    expect(score2).toBe(1);
    // getTrackDiagnostics must report each track's own score, not the same
    // value for both (the original bug: both would have echoed whichever
    // connection-level number reports.find() picked first).
    expect(diag1).toBe(score1);
    expect(diag2).toBe(score2);
    expect(diag1).not.toBe(diag2);
  });

  test('avSyncDeltaMs is null (not an arbitrary guess) when more than one video report is present', async ({ page }) => {
    await gotoFixture(page);
    const connectionIdA = await page.evaluate(async () => {
      const { connectionIdA } = await window.testHelpers.createLoopbackSession();
      window.__pcA.getStats = async () => new Map([
        ['audio1', { id: 'audio1', type: 'inbound-rtp', kind: 'audio', jitterBufferDelay: 0.5, jitterBufferEmittedCount: 100 }],
        ['video1', { id: 'video1', type: 'inbound-rtp', kind: 'video', jitterBufferDelay: 0.2, jitterBufferEmittedCount: 100 }],
        ['video2', { id: 'video2', type: 'inbound-rtp', kind: 'video', jitterBufferDelay: 0.9, jitterBufferEmittedCount: 100 }],
      ]);
      return connectionIdA;
    });
    await page.evaluate(() => window.testHelpers.wait(2200));
    const snap = await page.evaluate(() => window.__webrtcInspector.getSnapshot());
    const recA = snap.connections.find((c) => c.id === connectionIdA);
    expect(recA.avSyncDeltaMs).toBeNull();
  });
});
