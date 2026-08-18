const { test, expect } = require('@playwright/test');
const { gotoFixture } = require('../helpers');

// getSnapshot()'s flags field (see #25) is computed live from Date.now() at
// call time, not tied to the 2s stats-poll tick — so age-based flags (data
// channel idle, track added with no stats) just need a real wait, no
// getStats() shadowing. Flags derived from #15/#16/#17's quality signals
// reuse the getStats()-shadowing pattern from candidate-flip/freeze-ratio
// specs, since the pure-loopback fixture has no real network degradation.

test.describe('Heuristic anomaly flags', () => {
  test('a freshly opened, actively used connection has no flags', async ({ page }) => {
    await gotoFixture(page);
    const connectionIdA = await page.evaluate(async () => {
      const { connectionIdA: id } = await window.testHelpers.createLoopbackSession();
      window.__dcA.send('hello');
      return id;
    });
    const snap = await page.evaluate(() => window.__webrtcInspector.getSnapshot());
    const recA = snap.connections.find((c) => c.id === connectionIdA);
    expect(recA.flags).toEqual([]);
  });

  test('flags an ICE connection stuck in checking past the threshold', async ({ page }) => {
    await gotoFixture(page);
    const connectionIdA = await page.evaluate(async () => {
      const { connectionIdA: id } = await window.testHelpers.createLoopbackSession();
      // A real ICE agent that never leaves 'checking' can't be produced
      // deterministically without real network partitioning, so this drives
      // the module's own iceconnectionstatechange listener the same way the
      // browser would: override the live property, then dispatch the event
      // it reads from.
      Object.defineProperty(window.__pcA, 'iceConnectionState', { value: 'checking', configurable: true });
      window.__pcA.dispatchEvent(new Event('iceconnectionstatechange'));
      return id;
    });
    await page.waitForFunction(
      (id) => {
        const rec = window.__webrtcInspector.getSnapshot().connections.find((c) => c.id === id);
        return !!rec && rec.flags.some((f) => f.startsWith('ice_stuck_checking_'));
      },
      connectionIdA,
      { timeout: 7000 }
    );
  });

  test('flags a data channel that opened but was never used', async ({ page }) => {
    await gotoFixture(page);
    const connectionIdA = await page.evaluate(async () => {
      const { connectionIdA: id } = await window.testHelpers.createLoopbackSession('idle-channel');
      return id;
    });
    await page.waitForFunction(
      (id) => {
        const rec = window.__webrtcInspector.getSnapshot().connections.find((c) => c.id === id);
        return !!rec && rec.flags.includes('datachannel_opened_never_used:idle-channel');
      },
      connectionIdA,
      { timeout: 5000 }
    );
  });

  test('does not flag a data channel that was used before the idle threshold', async ({ page }) => {
    await gotoFixture(page);
    const connectionIdA = await page.evaluate(async () => {
      const { connectionIdA: id } = await window.testHelpers.createLoopbackSession('active-channel');
      window.__dcA.send('ping');
      return id;
    });
    await page.waitForTimeout(3200);
    const snap = await page.evaluate(() => window.__webrtcInspector.getSnapshot());
    const recA = snap.connections.find((c) => c.id === connectionIdA);
    expect(recA.flags).not.toContain('datachannel_opened_never_used:active-channel');
  });

  test('flags a local track added but never correlated to outbound-rtp stats', async ({ page }) => {
    await gotoFixture(page);
    const { connectionIdA, trackId } = await page.evaluate(async () => {
      await window.__webrtcInspector.setFakeCam({ width: 64, height: 48 });
      const stream = await navigator.mediaDevices.getUserMedia({ video: true });
      const track = stream.getVideoTracks()[0];
      const { connectionIdA: id } = await window.testHelpers.createLoopbackSession('test-channel', (pcA) => {
        pcA.addTrack(track, stream);
      });
      // Shadow getStats so no outbound-rtp report ever correlates to this
      // track's mid — simulates a track that was added but never actually
      // started flowing (e.g. a stuck negotiation).
      window.__pcA.getStats = async () => new Map();
      return { connectionIdA: id, trackId: track.id };
    });
    await page.waitForFunction(
      ({ id, tid }) => {
        const rec = window.__webrtcInspector.getSnapshot().connections.find((c) => c.id === id);
        return !!rec && rec.flags.includes(`track_added_no_stats:${tid}`);
      },
      { id: connectionIdA, tid: trackId },
      { timeout: 5000 }
    );
  });

  test('flags a local track reporting a non-none quality limitation reason', async ({ page }) => {
    await gotoFixture(page);
    const { connectionIdA, trackId } = await page.evaluate(async () => {
      await window.__webrtcInspector.setFakeCam({ width: 64, height: 48 });
      const stream = await navigator.mediaDevices.getUserMedia({ video: true });
      const track = stream.getVideoTracks()[0];
      const { connectionIdA: id } = await window.testHelpers.createLoopbackSession('test-channel', (pcA) => {
        pcA.addTrack(track, stream);
      });
      const mid = window.__pcA.getTransceivers().find((t) => t.sender && t.sender.track === track).mid;
      window.__pcA.getStats = async () => new Map([
        ['o1', { id: 'o1', type: 'outbound-rtp', mid, qualityLimitationReason: 'cpu' }],
      ]);
      return { connectionIdA: id, trackId: track.id };
    });
    await page.waitForFunction(
      ({ id, tid }) => {
        const rec = window.__webrtcInspector.getSnapshot().connections.find((c) => c.id === id);
        return !!rec && rec.flags.includes(`quality_limited_cpu:${tid}`);
      },
      { id: connectionIdA, tid: trackId },
      { timeout: 3000 }
    );
  });

  test('flags a remote track with a heavy freeze ratio', async ({ page }) => {
    await gotoFixture(page);
    const { connectionIdB, trackId } = await page.evaluate(async () => {
      await window.__webrtcInspector.setFakeCam({ width: 64, height: 48 });
      const stream = await navigator.mediaDevices.getUserMedia({ video: true });
      const { connectionIdB: id } = await window.testHelpers.createLoopbackSession('test-channel', (pcA) => {
        pcA.addTrack(stream.getVideoTracks()[0], stream);
      });
      await window.testHelpers.waitFor(() => {
        const recB = window.__webrtcInspector.getSnapshot().connections.find((c) => c.id === id);
        return !!recB && recB.remoteTracks.length > 0;
      });
      const recB = window.__webrtcInspector.getSnapshot().connections.find((c) => c.id === id);
      const tid = recB.remoteTracks[0].trackId;
      window.__pcB.getStats = async () => new Map([
        ['v1', { id: 'v1', type: 'inbound-rtp', kind: 'video', trackIdentifier: tid, freezeCount: 50, totalFreezesDuration: 1000 }],
      ]);
      return { connectionIdB: id, trackId: tid };
    });
    await page.waitForFunction(
      ({ id, tid }) => {
        const rec = window.__webrtcInspector.getSnapshot().connections.find((c) => c.id === id);
        return !!rec && rec.flags.includes(`freeze_ratio_bad:${tid}`);
      },
      { id: connectionIdB, tid: trackId },
      { timeout: 3000 }
    );
  });

  test('flags repeated candidate-type flips', async ({ page }) => {
    await gotoFixture(page);
    const connectionIdA = await page.evaluate(async () => {
      const { connectionIdA: id } = await window.testHelpers.createLoopbackSession();
      const pairs = [['srflx', 'local1'], ['relay', 'local2'], ['srflx', 'local3']];
      let i = 0;
      window.__pcA.getStats = async () => {
        const [type, localId] = pairs[Math.min(i, pairs.length - 1)];
        return new Map([
          ['pair1', { id: 'pair1', type: 'candidate-pair', nominated: true, state: 'succeeded', localCandidateId: localId }],
          [localId, { id: localId, type: 'local-candidate', candidateType: type }],
        ]);
      };
      for (i = 0; i < pairs.length; i++) {
        await window.testHelpers.waitFor(() => {
          const rec = window.__webrtcInspector.getSnapshot().connections.find((c) => c.id === id);
          return !!rec && rec.selectedCandidateType === pairs[i][0];
        }, 3000);
      }
      return id;
    });
    await page.waitForFunction(
      (id) => {
        const rec = window.__webrtcInspector.getSnapshot().connections.find((c) => c.id === id);
        return !!rec && rec.flags.some((f) => f.startsWith('candidate_type_flipped_'));
      },
      connectionIdA,
      { timeout: 3000 }
    );
    const snap = await page.evaluate(() => window.__webrtcInspector.getSnapshot());
    const recA = snap.connections.find((c) => c.id === connectionIdA);
    expect(recA.candidateTypeFlips.length).toBeGreaterThanOrEqual(2);
    expect(recA.flags).toContain(`candidate_type_flipped_${recA.candidateTypeFlips.length}x`);
  });
});
