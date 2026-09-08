const { test, expect } = require('@playwright/test');
const { mintToken, LIVEKIT_URL } = require('../server.js');
const {
  ROOM_JOIN_TIMEOUT_MS,
  SIMULCAST_NEGOTIATED_TIMEOUT_MS,
  CAP_ENCODING_SETTLE_TIMEOUT_MS,
  POLL_INTERVAL_MS,
} = require('../helpers.js');

// Plan section 5 item 2 / section 4 Tier A "capEncoding": cap a real
// simulcast sender's maxBitrate while LiveKit is actively renegotiating
// (a screen-share publish, not the synthetic pc.close()-triggered rejection
// in test/specs/cap-encoding.spec.js), then confirm the cap holds or a
// documented encoding-cap-failed event fires. Also confirms the plan's
// suspected sender-targeting defect: capEncoding()/replaceOutgoingTrack()
// resolve their target via getSenders().find(s => s.track.kind === kind),
// first-match-by-kind — with two same-kind senders (camera + screen-share)
// on one connection, this is genuinely ambiguous. See
// extension/core/webrtc-inspector.js capEncoding()/replaceOutgoingTrack().

async function joinAndPublish(page, roomName, identity, opts) {
  await page.goto('/test/livekit/fixture.html');
  await page.waitForFunction(() => !!window.__livekitTestHelpers);
  const token = await mintToken(identity, roomName);
  await page.evaluate(
    ([url, tok, o]) => window.__livekitTestHelpers.join(url, tok, o),
    [LIVEKIT_URL, token, opts || {}]
  );
  await page.evaluate(() => window.__livekitTestHelpers.publishCamMic());
  // Captures window.__webrtcInspector events for this page, independent of
  // livekit-client's own event log (window.__livekitTestHelpers.getEvents()).
  await page.evaluate(() => {
    window.__wrtcEvents = [];
    window.__webrtcInspector.onEvent((e) => window.__wrtcEvents.push(e));
  });
}

async function getSoleVideoConnectionId(page) {
  const snap = await page.evaluate(() => window.__webrtcInspector.getSnapshot());
  const conn = snap.connections.find((c) => (c.localTracks || []).some((t) => t.kind === 'video'));
  expect(conn).toBeTruthy();
  return conn.id;
}

test.describe('capEncoding vs real LiveKit negotiation/ABR', () => {
  test('cap holds (or documented encoding-cap-failed fires) on a real simulcast sender during concurrent renegotiation', async ({ browser }) => {
    const roomName = `capencoding-abr-${Date.now()}`;
    const ctxA = await browser.newContext();
    const ctxB = await browser.newContext();
    const pageA = await ctxA.newPage();
    const pageB = await ctxB.newPage();

    try {
      await joinAndPublish(pageA, roomName, 'alice', {});
      await joinAndPublish(pageB, roomName, 'bob', {});

      await expect.poll(
        () => pageA.evaluate(() => window.__livekitTestHelpers.assertSimulcastNegotiated().encodingCount),
        { timeout: SIMULCAST_NEGOTIATED_TIMEOUT_MS, intervals: [POLL_INTERVAL_MS] }
      ).toBeGreaterThan(1);

      const connId = await getSoleVideoConnectionId(pageA);
      const CAP_BITRATE = 250_000;

      // Fire the cap and a real renegotiation (screen-share publish)
      // concurrently, so encoding-capped/-cap-failed must resolve against
      // live negotiation activity, not an idle connection.
      const [, capResult] = await Promise.all([
        pageA.evaluate(() => window.__livekitTestHelpers.publishScreenShare()),
        pageA.evaluate(
          ([id, bitrate]) => window.__webrtcInspector.capEncoding(id, 'video', { maxBitrate: bitrate })
            .then(() => 'resolved')
            .catch(() => 'rejected'),
          [connId, CAP_BITRATE]
        ),
      ]);
      expect(['resolved', 'rejected']).toContain(capResult);

      await expect.poll(
        async () => {
          const events = await pageA.evaluate(() => window.__wrtcEvents);
          return events.filter((e) => e.type === 'encoding-capped' || e.type === 'encoding-cap-failed').length;
        },
        { timeout: CAP_ENCODING_SETTLE_TIMEOUT_MS, intervals: [POLL_INTERVAL_MS] }
      ).toBeGreaterThan(0);

      const events = await pageA.evaluate(() => window.__wrtcEvents);
      const capEvents = events.filter((e) => e.type === 'encoding-capped' || e.type === 'encoding-cap-failed');
      expect(capEvents.length).toBeGreaterThanOrEqual(1);
      const last = capEvents[capEvents.length - 1];
      expect(last.connectionId).toBe(connId);
      expect(last.kind).toBe('video');
      expect(last.caps).toEqual({ maxBitrate: CAP_BITRATE });

      if (last.type === 'encoding-capped') {
        // Cap must hold on the sender it actually targeted, and survive a
        // brief settle window even while the concurrent renegotiation
        // finishes (proves capEncoding's cap isn't silently clobbered by
        // LiveKit's own subsequent parameter pushes).
        await expect.poll(
          async () => {
            const states = await pageA.evaluate(() => window.__livekitTestHelpers.getVideoSenderStates());
            return states.some((s) => s.maxBitrate === CAP_BITRATE);
          },
          { timeout: 3000, intervals: [POLL_INTERVAL_MS] }
        ).toBe(true);
      } else {
        // A documented, typed failure is an acceptable real-timing outcome
        // (plan: "confirm the cap holds OR a documented encoding-cap-failed
        // event fires") — but it must carry a real error message, not a
        // silent/empty failure.
        expect(typeof last.error).toBe('string');
        expect(last.error.length).toBeGreaterThan(0);
      }
    } finally {
      await ctxA.close();
      await ctxB.close();
    }
  });

  test('sender targeting: capEncoding on a participant publishing camera + screen-share affects exactly one deterministic sender', async ({ browser }) => {
    const roomName = `capencoding-sender-targeting-${Date.now()}`;
    const ctxA = await browser.newContext();
    const ctxB = await browser.newContext();
    const pageA = await ctxA.newPage();
    const pageB = await ctxB.newPage();

    try {
      await joinAndPublish(pageA, roomName, 'alice', {});
      await joinAndPublish(pageB, roomName, 'bob', {});
      await pageA.evaluate(() => window.__livekitTestHelpers.publishScreenShare());

      await expect.poll(
        () => pageA.evaluate(() => window.__livekitTestHelpers.getLocalVideoSources().length),
        { timeout: ROOM_JOIN_TIMEOUT_MS, intervals: [POLL_INTERVAL_MS] }
      ).toBe(2);

      const sources = await pageA.evaluate(() => window.__livekitTestHelpers.getLocalVideoSources());
      const cameraTrackId = sources.find((s) => s.source === 'camera').mediaStreamTrackId;
      const screenTrackId = sources.find((s) => s.source === 'screen_share').mediaStreamTrackId;
      expect(cameraTrackId).toBeTruthy();
      expect(screenTrackId).toBeTruthy();

      // Both video tracks must live on the same connection for the
      // first-match-by-kind ambiguity to actually apply.
      const snap = await pageA.evaluate(() => window.__webrtcInspector.getSnapshot());
      const conn = snap.connections.find((c) => {
        const ids = (c.localTracks || []).map((t) => t.trackId);
        return ids.includes(cameraTrackId) && ids.includes(screenTrackId);
      });
      expect(conn).toBeTruthy();

      const CAP_A = 200_000;
      const CAP_B = 300_000;

      await pageA.evaluate(
        ([id, bitrate]) => window.__webrtcInspector.capEncoding(id, 'video', { maxBitrate: bitrate }),
        [conn.id, CAP_A]
      );
      const afterFirst = await pageA.evaluate(() => window.__livekitTestHelpers.getVideoSenderStates());
      const cappedFirst = afterFirst.filter((s) => s.maxBitrate === CAP_A);
      // Exactly one sender is ever hit per call — this is the ambiguity: the
      // API has no way for a caller to pick which same-kind sender it means.
      expect(cappedFirst.length).toBe(1);
      const targetedTrackId = cappedFirst[0].trackId;
      expect([cameraTrackId, screenTrackId]).toContain(targetedTrackId);

      // Calling again with a different bitrate must hit the SAME sender
      // both times: getSenders().find() order is stable within a session,
      // so the lookup is deterministic-but-unspecified, not randomized —
      // which makes the miss silent and repeatable rather than an
      // occasional flake, i.e. a real caller targeting the other sender by
      // kind alone would consistently cap the wrong one every time.
      await pageA.evaluate(
        ([id, bitrate]) => window.__webrtcInspector.capEncoding(id, 'video', { maxBitrate: bitrate }),
        [conn.id, CAP_B]
      );
      const afterSecond = await pageA.evaluate(() => window.__livekitTestHelpers.getVideoSenderStates());
      const cappedSecond = afterSecond.filter((s) => s.maxBitrate === CAP_B);
      expect(cappedSecond.length).toBe(1);
      expect(cappedSecond[0].trackId).toBe(targetedTrackId);

      // The other same-kind sender must be left completely untouched by
      // either call — confirming the ambiguity is a real miss, not just a
      // shared side effect.
      const otherTrackId = targetedTrackId === cameraTrackId ? screenTrackId : cameraTrackId;
      const otherState = afterSecond.find((s) => s.trackId === otherTrackId);
      expect(otherState.maxBitrate).not.toBe(CAP_A);
      expect(otherState.maxBitrate).not.toBe(CAP_B);
    } finally {
      await ctxA.close();
      await ctxB.close();
    }
  });
});
