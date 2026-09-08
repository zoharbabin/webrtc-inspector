const { test, expect } = require('@playwright/test');
const { mintToken, LIVEKIT_URL } = require('../server.js');
const { ROOM_JOIN_TIMEOUT_MS, TRACK_SUBSCRIBED_TIMEOUT_MS, STATS_FLOWING_TIMEOUT_MS, POLL_INTERVAL_MS } = require('../helpers.js');

// Plan section 4 Tier B / section 5 item 10.
// test/specs/fake-media.spec.js only ever meters a same-page loopback
// offer/answer. This file confirms the same real-audio-level invariant holds
// end to end through a real second LiveKit participant and a real SFU hop,
// using the same levelUnavailableReason-aware pattern: Chromium only runs the
// audio decoder for a remote track something renders, so the test attaches
// its own <audio> sink and trusts the inspector's own reported reason rather
// than asserting a raw level, skipping only when the inspector itself says
// it could not measure (no AudioContext rendering on this machine).

async function join(page, roomName, identity) {
  await page.goto('/test/livekit/fixture.html');
  await page.waitForFunction(() => !!window.__livekitTestHelpers);
  const token = await mintToken(identity, roomName);
  await page.evaluate(
    ([url, tok]) => window.__livekitTestHelpers.join(url, tok, {}),
    [LIVEKIT_URL, token]
  );
}

test.describe('media-roundtrip: real fake mic/cam through a real second participant', () => {
  test('a real remote audio level meters above the noise floor, and video bytes flow, once bob renders alice\'s tracks', async ({ browser }) => {
    test.setTimeout(60000);
    const roomName = `media-roundtrip-${Date.now()}`;
    const ctxA = await browser.newContext();
    const ctxB = await browser.newContext();
    const pageA = await ctxA.newPage();
    const pageB = await ctxB.newPage();

    try {
      await join(pageA, roomName, 'alice');
      await join(pageB, roomName, 'bob');
      await expect.poll(
        () => pageA.evaluate(() => window.__livekitTestHelpers.getConnectionState()),
        { timeout: ROOM_JOIN_TIMEOUT_MS, intervals: [POLL_INTERVAL_MS] }
      ).toBe('connected');
      await expect.poll(
        () => pageB.evaluate(() => window.__livekitTestHelpers.getConnectionState()),
        { timeout: ROOM_JOIN_TIMEOUT_MS, intervals: [POLL_INTERVAL_MS] }
      ).toBe('connected');

      await pageA.evaluate(() => window.__livekitTestHelpers.publishCamMic());

      await expect.poll(
        () => pageB.evaluate(() => window.__livekitTestHelpers.getRemoteTracksByParticipant().alice),
        { timeout: TRACK_SUBSCRIBED_TIMEOUT_MS, intervals: [POLL_INTERVAL_MS] }
      ).toEqual(expect.arrayContaining([expect.objectContaining({ source: 'microphone' })]));

      const remoteTracks = await pageB.evaluate(() => window.__livekitTestHelpers.getRemoteTracksByParticipant().alice);
      const audioTrack = remoteTracks.find((t) => t.source === 'microphone');
      const videoTrack = remoteTracks.find((t) => t.source === 'camera');
      expect(audioTrack).toBeTruthy();
      expect(videoTrack).toBeTruthy();

      const connB = await pageB.evaluate(() => window.__webrtcInspector.getSnapshot().connections[0].id);

      // App-side sink on the real remote audio track. Without one, Chromium
      // never runs the decoder and the meter can only report a reason, never
      // a level, matching test/specs/fake-media.spec.js's finding.
      const meterResult = await pageB.evaluate(async ({ connId, mediaStreamTrackId }) => {
        const snap = window.__webrtcInspector.getSnapshot();
        const conn = snap.connections.find((c) => c.id === connId);
        const remoteTrack = conn.remoteTracks.find((t) => t.trackId === mediaStreamTrackId);
        const stream = window.__webrtcInspector.getRemoteTrackStream(connId, remoteTrack.trackId);
        const el = document.createElement('audio');
        el.autoplay = true;
        el.srcObject = stream;
        document.body.appendChild(el);
        try { await el.play(); } catch { /* autoplay policy: the sink still pulls */ }

        const track = () => {
          const s = window.__webrtcInspector.getSnapshot().connections.find((c) => c.id === connId);
          return s && s.remoteTracks.find((t) => t.trackId === mediaStreamTrackId);
        };
        let maxLevel = 0;
        let reasonWhenMetered = 'never-metered';
        const deadline = Date.now() + 15000;
        while (Date.now() < deadline) {
          const t = track();
          if (t && typeof t.level === 'number' && t.level > maxLevel) {
            maxLevel = t.level;
            reasonWhenMetered = t.levelUnavailableReason;
          }
          if (maxLevel > 0.01) break;
          await new Promise((r) => setTimeout(r, 200));
        }
        const last = track();
        return { maxLevel, unavailableReason: reasonWhenMetered, finalReason: last ? last.levelUnavailableReason : null };
      }, { connId: connB, mediaStreamTrackId: audioTrack.mediaStreamTrackId });

      test.skip(meterResult.finalReason === 'audio-context-not-rendering', 'nothing drives an AudioContext on this machine, so the meter cannot measure any level');
      expect(meterResult.maxLevel).toBeGreaterThan(0.01);
      expect(meterResult.unavailableReason).toBeNull();

      // Real video bytes flow on the same remote connection, cross-referenced
      // by the same trackId attribution getRemoteTracksByParticipant() gives.
      const videoBytesAt = () => pageB.evaluate(({ connId, mediaStreamTrackId }) => {
        const snap = window.__webrtcInspector.getSnapshot({ detail: 'detailed' });
        const conn = snap.connections.find((c) => c.id === connId);
        const reports = (conn && conn.latestStats && conn.latestStats.reports) || [];
        const inbound = reports.find((r) => r.type === 'inbound-rtp' && r.kind === 'video' && r.trackIdentifier === mediaStreamTrackId);
        return (inbound && inbound.bytesReceived) || 0;
      }, { connId: connB, mediaStreamTrackId: videoTrack.mediaStreamTrackId });

      const before = await videoBytesAt();
      await expect.poll(videoBytesAt, { timeout: STATS_FLOWING_TIMEOUT_MS, intervals: [POLL_INTERVAL_MS] })
        .toBeGreaterThan(before);
    } finally {
      await ctxA.close();
      await ctxB.close();
    }
  });
});
