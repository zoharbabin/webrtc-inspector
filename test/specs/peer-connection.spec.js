const { test, expect } = require('@playwright/test');
const { gotoFixture, SILENT_WAV_BASE64, STATS_POLL_WAIT_MS } = require('../helpers');

test.describe('RTCPeerConnection instrumentation', () => {
  test.beforeEach(async ({ page }) => {
    await gotoFixture(page);
    await page.evaluate((wav) => { window.__SILENT_WAV = wav; }, SILENT_WAV_BASE64);
  });

  test('installs window.__webrtcInspector', async ({ page }) => {
    const installed = await page.evaluate(() => {
      const inspector = window.__webrtcInspector;
      return !!inspector && !inspector.unsupported;
    });
    expect(installed).toBe(true);
  });

  test('tracks both peers of a loopback session', async ({ page }) => {
    await page.evaluate(() => window.testHelpers.createLoopbackSession());
    const snap = await page.evaluate(() => window.__webrtcInspector.getSnapshot());
    expect(snap.connections).toHaveLength(2);
  });

  test('captures local ICE candidates', async ({ page }) => {
    const { connectionIdA } = await page.evaluate(() => window.testHelpers.createLoopbackSession());
    await page.waitForFunction(
      (id) => window.__webrtcInspector.getSnapshot().connections.find((c) => c.id === id).localCandidateTypes.length > 0,
      connectionIdA
    );
    const snap = await page.evaluate(() => window.__webrtcInspector.getSnapshot());
    const recA = snap.connections.find((c) => c.id === connectionIdA);
    expect(recA.localCandidateTypes.length).toBeGreaterThan(0);
  });

  test('captures remote ICE candidates on the answering side', async ({ page }) => {
    const { connectionIdB } = await page.evaluate(() => window.testHelpers.createLoopbackSession());
    await page.waitForFunction(
      (id) => window.__webrtcInspector.getSnapshot().connections.find((c) => c.id === id).remoteCandidateTypes.length > 0,
      connectionIdB
    );
    const snap = await page.evaluate(() => window.__webrtcInspector.getSnapshot());
    const recB = snap.connections.find((c) => c.id === connectionIdB);
    expect(recB.remoteCandidateTypes.length).toBeGreaterThan(0);
  });

  test('captures local SDP summary (m-lines + codecs)', async ({ page }) => {
    const { connectionIdA } = await page.evaluate(() =>
      window.testHelpers.createLoopbackSession('test-channel', (pcA) => pcA.addTransceiver('audio'))
    );
    const snap = await page.evaluate(() => window.__webrtcInspector.getSnapshot());
    const recA = snap.connections.find((c) => c.id === connectionIdA);
    expect(recA.localSdpSummary).toBeTruthy();
    expect(recA.localSdpSummary.mLines).toBeGreaterThanOrEqual(1);
    expect(recA.localSdpSummary.codecs.length).toBeGreaterThan(0);
  });

  test('captures remote SDP summary on the answering side', async ({ page }) => {
    const { connectionIdB } = await page.evaluate(() =>
      window.testHelpers.createLoopbackSession('test-channel', (pcA) => pcA.addTransceiver('audio'))
    );
    const snap = await page.evaluate(() => window.__webrtcInspector.getSnapshot());
    const recB = snap.connections.find((c) => c.id === connectionIdB);
    expect(recB.remoteSdpSummary).toBeTruthy();
    expect(recB.remoteSdpSummary.mLines).toBeGreaterThanOrEqual(1);
  });

  test('getSdp() returns full local/remote SDP strings', async ({ page }) => {
    const { connectionIdA } = await page.evaluate(() => window.testHelpers.createLoopbackSession());
    const sdp = await page.evaluate((id) => window.__webrtcInspector.getSdp(id), connectionIdA);
    expect(sdp.local).toBeTruthy();
    expect(typeof sdp.local.sdp).toBe('string');
    expect(sdp.local.sdp.length).toBeGreaterThan(0);
  });

  test('logs an addTransceiver call and its local track', async ({ page }) => {
    const { connectionIdA } = await page.evaluate(async () => {
      const { connectionIdA } = await window.testHelpers.createLoopbackSession();
      await window.__webrtcInspector.setFakeCam({ width: 64, height: 48 });
      const stream = await navigator.mediaDevices.getUserMedia({ video: true });
      window.__pcA.addTransceiver(stream.getVideoTracks()[0], { direction: 'sendonly' });
      return { connectionIdA };
    });
    const snap = await page.evaluate(() => window.__webrtcInspector.getSnapshot());
    const recA = snap.connections.find((c) => c.id === connectionIdA);
    expect(recA.localTracks.some((t) => t.kind === 'video' && t.sourceTag === 'fake-cam')).toBe(true);
  });

  test('addTrack tags the local track with its getUserMedia source', async ({ page }) => {
    const { connectionIdA } = await page.evaluate(async () => {
      const { connectionIdA } = await window.testHelpers.createLoopbackSession();
      await window.__webrtcInspector.setFakeMic(window.__SILENT_WAV);
      const stream = await navigator.mediaDevices.getUserMedia({ audio: true });
      stream.getTracks().forEach((t) => window.__pcA.addTrack(t, stream));
      return { connectionIdA };
    });
    const snap = await page.evaluate(() => window.__webrtcInspector.getSnapshot());
    const recA = snap.connections.find((c) => c.id === connectionIdA);
    expect(recA.localTracks.some((t) => t.sourceTag === 'fake-mic')).toBe(true);
  });

  test('promotes qualityLimitationReason onto a sending video track', async ({ page }) => {
    const { connectionIdA, trackId } = await page.evaluate(async () => {
      await window.__webrtcInspector.setFakeCam({ width: 64, height: 48 });
      const stream = await navigator.mediaDevices.getUserMedia({ video: true });
      const trackId = stream.getVideoTracks()[0].id;
      const { connectionIdA } = await window.testHelpers.createLoopbackSession('test-channel', (pcA) => {
        pcA.addTrack(stream.getVideoTracks()[0], stream);
      });
      return { connectionIdA, trackId };
    });
    await page.waitForFunction(
      ({ id, trackId }) => {
        const rec = window.__webrtcInspector.getSnapshot().connections.find((c) => c.id === id);
        const track = rec && rec.localTracks.find((t) => t.trackId === trackId);
        return !!track && track.qualityLimitationReason !== null;
      },
      { id: connectionIdA, trackId },
      { timeout: STATS_POLL_WAIT_MS }
    );
    const snap = await page.evaluate(() => window.__webrtcInspector.getSnapshot());
    const recA = snap.connections.find((c) => c.id === connectionIdA);
    const track = recA.localTracks.find((t) => t.trackId === trackId);
    expect(track.qualityLimitationReason).toBe('none');
  });

  test('leaves qualityLimitationReason null for an audio-only track', async ({ page }) => {
    const { connectionIdA, trackId } = await page.evaluate(async () => {
      await window.__webrtcInspector.setFakeMic(window.__SILENT_WAV);
      const stream = await navigator.mediaDevices.getUserMedia({ audio: true });
      const trackId = stream.getAudioTracks()[0].id;
      const { connectionIdA } = await window.testHelpers.createLoopbackSession('test-channel', (pcA) => {
        pcA.addTrack(stream.getAudioTracks()[0], stream);
      });
      return { connectionIdA, trackId };
    });
    await page.waitForFunction(
      (id) => window.__webrtcInspector.getSnapshot().connections.find((c) => c.id === id).latestStats !== null,
      connectionIdA,
      { timeout: STATS_POLL_WAIT_MS }
    );
    const snap = await page.evaluate(() => window.__webrtcInspector.getSnapshot());
    const recA = snap.connections.find((c) => c.id === connectionIdA);
    const track = recA.localTracks.find((t) => t.trackId === trackId);
    expect(track.qualityLimitationReason).toBeNull();
  });

  // close() sets connectionState directly per spec, and on a connection that
  // never negotiated it fires no event at all, so the record can only learn
  // about an app-initiated close from the patched close() itself. If it doesn't,
  // the 2s stats poll and every audio meter keep running for the life of the
  // page and getSnapshot() reports a dead connection as live.
  test('an app-initiated pc.close() closes the record, stops the stats poll, and is idempotent', async ({ page }) => {
    const result = await page.evaluate(async () => {
      const { connectionIdA } = await window.testHelpers.createLoopbackSession('close-direct');
      const rec = () => window.__webrtcInspector.getSnapshot().connections.find((c) => c.id === connectionIdA);
      await window.testHelpers.waitFor(() => rec().latestStats, 8000, 100); // need one poll to have a timestamp to compare
      window.__pcA.close();
      const closedImmediately = rec().closed;
      const tsAtClose = rec().latestStats.ts;
      window.__pcA.close(); // a second close must not emit a second pc-closed
      await window.testHelpers.wait(3000); // longer than one 2s poll interval
      const closeEvents = window.__webrtcInspector
        .getEvents()
        .events.filter((e) => e.type === 'pc-closed' && e.connectionId === connectionIdA);
      return {
        closedImmediately,
        pollStopped: rec().latestStats.ts === tsAtClose,
        closeEventCount: closeEvents.length,
        reason: closeEvents.length ? closeEvents[0].reason : null,
      };
    });
    expect(result.closedImmediately).toBe(true);
    expect(result.pollStopped).toBe(true);
    expect(result.closeEventCount).toBe(1);
    expect(result.reason).toBe('closed');
  });

  // The patched constructor shares the native prototype, so without the
  // constructor fix `pc.constructor` is the native RTCPeerConnection while
  // `window.RTCPeerConnection` is the patched one. Apps that compare the two to
  // feature-detect would see a mismatch that only exists because we are loaded.
  test('patched RTCPeerConnection and WebSocket stay indistinguishable from the native ones', async ({ page }) => {
    const result = await page.evaluate(() => {
      const pc = new RTCPeerConnection({ iceServers: [] });
      const ws = new WebSocket('ws://127.0.0.1:9/never-connects');
      const out = {
        pcInstanceof: pc instanceof RTCPeerConnection,
        pcConstructor: pc.constructor === RTCPeerConnection,
        pcConstructorHidden: !Object.keys(Object.getPrototypeOf(pc)).includes('constructor'),
        wsInstanceof: ws instanceof WebSocket,
        wsConstructor: ws.constructor === WebSocket,
        pcName: RTCPeerConnection.prototype === Object.getPrototypeOf(pc),
      };
      pc.close();
      ws.close();
      return out;
    });
    expect(result).toEqual({
      pcInstanceof: true,
      pcConstructor: true,
      pcConstructorHidden: true,
      wsInstanceof: true,
      wsConstructor: true,
      pcName: true,
    });
  });

  // A page that churns connections (reconnect loops, per-call sessions) used to
  // grow connectionsById forever, pinning every closed RTCPeerConnection and its
  // tracks/dataChannels/statsHistory for the life of the tab. Eviction drops
  // closed records oldest first and never touches a live one — mirrors
  // evictClosedSockets()'s websocket.spec.js test.
  test('evicts closed connection records but keeps a live connection addressable', async ({ page }) => {
    const result = await page.evaluate(async () => {
      const { connectionIdA: keeperId } = await window.testHelpers.createLoopbackSession();
      for (let i = 0; i < 150; i++) {
        const churn = new RTCPeerConnection({ iceServers: [] });
        churn.close();
      }
      const snap = window.__webrtcInspector.getSnapshot();
      return {
        connectionCount: snap.connections.length,
        keeperStillTracked: snap.connections.some((c) => c.id === keeperId),
        keeperClosed: snap.connections.find((c) => c.id === keeperId).closed,
      };
    });
    expect(result.connectionCount).toBeLessThanOrEqual(100);
    expect(result.keeperStillTracked).toBe(true);
    expect(result.keeperClosed).toBe(false);
  });
});
