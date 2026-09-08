const { test, expect } = require('@playwright/test');
const { mintToken, LIVEKIT_URL } = require('../server.js');
const {
  ROOM_JOIN_TIMEOUT_MS,
  TRACK_REPLACE_CONVERGENCE_TIMEOUT_MS,
  POLL_INTERVAL_MS,
} = require('../helpers.js');

// Plan section 5 item 11 / section 4 Tier B "replaceOutgoingTrack": swap
// tracks mid-session on a real publishing PC, confirm the subscriber side
// sees the swap cleanly — no frozen frame, no renegotiation glitch. A raw
// RTCRtpSender.replaceTrack() doesn't renegotiate (same SSRC/mid, same
// receiver-side MediaStreamTrack.id), so "no renegotiation glitch" is
// verified as: the subscriber's remote track id is unchanged, while the
// pixel content it renders changes to match the new source.

const ORIGINAL_CAM = { color: '#ff00ff', text: 'orig', rgb: [255, 0, 255] };
const SWAPPED_CAM = { color: '#00ffff', text: 'swap', rgb: [0, 255, 255] };

async function joinAndPublishWithFakeCam(page, roomName, identity, cam) {
  await page.goto('/test/livekit/fixture.html');
  await page.waitForFunction(() => !!window.__livekitTestHelpers);
  await page.evaluate(([color, text]) => window.__webrtcInspector.setFakeCam({ color, text }), [cam.color, cam.text]);
  const token = await mintToken(identity, roomName);
  await page.evaluate(
    ([url, tok, o]) => window.__livekitTestHelpers.join(url, tok, o),
    [LIVEKIT_URL, token, {}]
  );
  await page.evaluate(() => window.__livekitTestHelpers.publishCamMic());
  await page.evaluate(() => {
    window.__wrtcEvents = [];
    window.__webrtcInspector.onEvent((e) => window.__wrtcEvents.push(e));
  });
}

async function joinOnly(page, roomName, identity) {
  await page.goto('/test/livekit/fixture.html');
  await page.waitForFunction(() => !!window.__livekitTestHelpers);
  const token = await mintToken(identity, roomName);
  await page.evaluate(
    ([url, tok, o]) => window.__livekitTestHelpers.join(url, tok, o),
    [LIVEKIT_URL, token, {}]
  );
}

async function resolveAliceVideoOnBob(pageB) {
  const remoteByParticipant = await pageB.evaluate(() => window.__livekitTestHelpers.getRemoteTracksByParticipant());
  const videoTrack = (remoteByParticipant.alice || []).find((t) => t.source === 'camera');
  if (!videoTrack) return null;
  const snap = await pageB.evaluate(() => window.__webrtcInspector.getSnapshot());
  for (const conn of snap.connections) {
    const match = (conn.remoteTracks || []).find((rt) => rt.trackId === videoTrack.mediaStreamTrackId);
    if (match) return { connectionId: conn.id, trackId: match.trackId };
  }
  return null;
}

async function sampleAliceColorOnBob(pageB, found) {
  return pageB.evaluate(
    ([connId, trackId]) => {
      const stream = window.__webrtcInspector.getRemoteTrackStream(connId, trackId);
      return window.__livekitTestHelpers.sampleStreamColor(stream);
    },
    [found.connectionId, found.trackId]
  );
}

function closeTo(rgb, expected, tolerance) {
  return (
    Math.abs(rgb.r - expected[0]) < tolerance &&
    Math.abs(rgb.g - expected[1]) < tolerance &&
    Math.abs(rgb.b - expected[2]) < tolerance
  );
}

test.describe('replaceOutgoingTrack on a real publishing PC', () => {
  test('subscriber sees a mid-session track swap cleanly: same remote track id, new pixel content, no renegotiation', async ({ browser }) => {
    const roomName = `track-replace-${Date.now()}`;
    const ctxA = await browser.newContext();
    const ctxB = await browser.newContext();
    const pageA = await ctxA.newPage();
    const pageB = await ctxB.newPage();

    try {
      await joinAndPublishWithFakeCam(pageA, roomName, 'alice', ORIGINAL_CAM);
      await joinOnly(pageB, roomName, 'bob');

      await expect.poll(
        () => resolveAliceVideoOnBob(pageB),
        { timeout: ROOM_JOIN_TIMEOUT_MS, intervals: [POLL_INTERVAL_MS] }
      ).not.toBeNull();
      const found = await resolveAliceVideoOnBob(pageB);
      expect(found).toBeTruthy();

      const beforeRgb = await sampleAliceColorOnBob(pageB, found);
      expect(closeTo(beforeRgb, ORIGINAL_CAM.rgb, 40)).toBe(true);

      // Confirm the state pageA's own connection is in before the swap:
      // exactly one active video sender, on a real (already-negotiated) PC.
      const snapA = await pageA.evaluate(() => window.__webrtcInspector.getSnapshot());
      const connA = snapA.connections.find((c) => (c.localTracks || []).some((t) => t.kind === 'video'));
      expect(connA).toBeTruthy();
      const negotiationCountBefore = await pageA.evaluate(() => window.__livekitTestHelpers.getEvents().length);

      await pageA.evaluate(([color, text]) => window.__webrtcInspector.setFakeCam({ color, text }), [SWAPPED_CAM.color, SWAPPED_CAM.text]);
      const newTrackId = await pageA.evaluate(async (connId) => {
        const stream = await navigator.mediaDevices.getUserMedia({ video: true });
        const track = stream.getVideoTracks()[0];
        window.__wrtcReplacementTrack = track; // keep it alive across the evaluate() boundary
        await window.__webrtcInspector.replaceOutgoingTrack(connId, 'video', track);
        return track.id;
      }, connA.id);

      // The extension's own event log must record the swap correctly
      // (RTCRtpSender.prototype.replaceTrack is patched to emit this).
      const replaceEvents = await pageA.evaluate(() => window.__wrtcEvents.filter((e) => e.type === 'track-replaced'));
      expect(replaceEvents.length).toBeGreaterThanOrEqual(1);
      expect(replaceEvents[replaceEvents.length - 1].trackId).toBe(newTrackId);
      expect(replaceEvents[replaceEvents.length - 1].kind).toBe('video');

      // No renegotiation glitch: bob's remote track id for alice's camera
      // publication must not change across the swap (replaceTrack keeps the
      // same sender/SSRC/mid — only the frames change).
      const afterSwapFound = await resolveAliceVideoOnBob(pageB);
      expect(afterSwapFound.connectionId).toBe(found.connectionId);
      expect(afterSwapFound.trackId).toBe(found.trackId);

      // No frozen frame: the subscriber must actually start rendering the
      // new source's pixels, not the old ones and not a stalled/black frame.
      await expect.poll(
        async () => {
          const rgb = await sampleAliceColorOnBob(pageB, found);
          return closeTo(rgb, SWAPPED_CAM.rgb, 40);
        },
        { timeout: TRACK_REPLACE_CONVERGENCE_TIMEOUT_MS, intervals: [POLL_INTERVAL_MS] }
      ).toBe(true);

      // livekit-client itself must not have logged a renegotiation-class
      // room event (Reconnecting/SignalReconnecting/ConnectionStateChanged)
      // as a side effect of the swap.
      const eventsAfter = await pageA.evaluate(() => window.__livekitTestHelpers.getEvents());
      const renegotiationEvents = eventsAfter
        .slice(negotiationCountBefore)
        .filter((e) => e.type === 'reconnecting' || e.type === 'signalReconnecting' || e.type === 'connectionStateChanged');
      expect(renegotiationEvents).toEqual([]);
    } finally {
      await ctxA.close();
      await ctxB.close();
    }
  });

  test('sender targeting: replaceOutgoingTrack on a participant publishing camera + screen-share affects exactly one deterministic sender', async ({ browser }) => {
    const roomName = `track-replace-sender-targeting-${Date.now()}`;
    const ctxA = await browser.newContext();
    const ctxB = await browser.newContext();
    const pageA = await ctxA.newPage();
    const pageB = await ctxB.newPage();

    try {
      await joinAndPublishWithFakeCam(pageA, roomName, 'alice', ORIGINAL_CAM);
      await joinOnly(pageB, roomName, 'bob');
      await pageA.evaluate(() => window.__livekitTestHelpers.publishScreenShare());

      await expect.poll(
        () => pageA.evaluate(() => window.__livekitTestHelpers.getLocalVideoSources().length),
        { timeout: ROOM_JOIN_TIMEOUT_MS, intervals: [POLL_INTERVAL_MS] }
      ).toBe(2);

      const sources = await pageA.evaluate(() => window.__livekitTestHelpers.getLocalVideoSources());
      const cameraTrackId = sources.find((s) => s.source === 'camera').mediaStreamTrackId;
      const screenTrackId = sources.find((s) => s.source === 'screen_share').mediaStreamTrackId;

      const snap = await pageA.evaluate(() => window.__webrtcInspector.getSnapshot());
      const conn = snap.connections.find((c) => {
        const ids = (c.localTracks || []).map((t) => t.trackId);
        return ids.includes(cameraTrackId) && ids.includes(screenTrackId);
      });
      expect(conn).toBeTruthy();

      const beforeStates = await pageA.evaluate(() => window.__livekitTestHelpers.getVideoSenderStates());
      const beforeTrackIds = beforeStates.map((s) => s.trackId).sort();

      await pageA.evaluate(async (connId) => {
        const stream = await navigator.mediaDevices.getUserMedia({ video: true });
        const track = stream.getVideoTracks()[0];
        window.__wrtcReplacementTrack2 = track;
        await window.__webrtcInspector.replaceOutgoingTrack(connId, 'video', track);
      }, conn.id);

      // Same first-match-by-kind lookup as capEncoding: exactly one of the
      // two same-kind senders gets its track swapped, and it's whichever one
      // getSenders() happens to return first — the caller has no way to
      // choose. Confirmed here directly rather than assumed from the source.
      const afterStates = await pageA.evaluate(() => window.__livekitTestHelpers.getVideoSenderStates());
      const afterTrackIds = afterStates.map((s) => s.trackId).sort();
      const unchangedCount = afterTrackIds.filter((id) => beforeTrackIds.includes(id)).length;
      // Exactly one sender's track id changed (the replaced one); the other
      // same-kind sender's track id is untouched.
      expect(unchangedCount).toBe(1);
      expect(afterStates.length).toBe(2);
    } finally {
      await ctxA.close();
      await ctxB.close();
    }
  });
});
