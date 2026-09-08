const { test, expect } = require('@playwright/test');
const { mintToken, LIVEKIT_URL } = require('../server.js');
const {
  ROOM_JOIN_TIMEOUT_MS,
  SIMULCAST_NEGOTIATED_TIMEOUT_MS,
  STATS_FLOWING_TIMEOUT_MS,
  RECONNECT_CONVERGENCE_TIMEOUT_MS,
  POLL_INTERVAL_MS,
} = require('../helpers.js');

// Plan section 4 Tier A "simulateNetworkLoss, simulateNetworkPreset,
// registerNetworkPreset" / section 5 item 4. There is no page-JS-level way to
// force real transient packet loss on a live RTCPeerConnection (see
// extension/core/webrtc-inspector.js's own comment above killConnection); the
// 'media' outage target (replaceTrack(null) on every sender, restored after)
// is the closest real, OS-access-free proxy. What's genuinely worth proving
// against a real SFU session, rather than a loopback fixture, is: (a) a local
// media blackout never gets mistaken by LiveKit's own engine for a transport
// failure — the PC must stay healthy throughout, not just the app-level
// track; (b) restore is clean — the subscriber actually resumes receiving new
// frames, not a stuck/frozen stream; (c) simulateNetworkPreset/
// registerNetworkPreset behave the same way against real infra as they do
// against the loopback fixtures.

const ORIGINAL_CAM = { color: '#ffaa00', text: 'orig', rgb: [255, 170, 0] };

async function joinAndPublishWithFakeCam(page, roomName, identity, cam) {
  await page.goto('/test/livekit/fixture.html');
  await page.waitForFunction(() => !!window.__livekitTestHelpers);
  // Explicit 1280x720: setFakeCam's fake track bypasses videoCaptureDefaults
  // entirely (getUserMedia returns a clone of the canvas track regardless of
  // requested constraints), and its own default of 320x240 is too small for
  // LiveKit's computeVideoEncodings() to negotiate multiple simulcast layers
  // (see fixture.js's buildRoomOptions comment).
  await page.evaluate(
    ([color, text]) => window.__webrtcInspector.setFakeCam({ color, text, width: 1280, height: 720 }),
    [cam.color, cam.text]
  );
  const token = await mintToken(identity, roomName);
  await page.evaluate(
    ([url, tok]) => window.__livekitTestHelpers.join(url, tok, {}),
    [LIVEKIT_URL, token]
  );
  await page.evaluate(() => window.__livekitTestHelpers.publishCamMic());
}

async function joinOnly(page, roomName, identity) {
  await page.goto('/test/livekit/fixture.html');
  await page.waitForFunction(() => !!window.__livekitTestHelpers);
  const token = await mintToken(identity, roomName);
  await page.evaluate(
    ([url, tok]) => window.__livekitTestHelpers.join(url, tok, {}),
    [LIVEKIT_URL, token]
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

async function outboundPacketsSent(page, connId) {
  const snap = await page.evaluate(() => window.__webrtcInspector.getSnapshot());
  const conn = snap.connections.find((c) => c.id === connId);
  const reports = (conn && conn.latestStats && conn.latestStats.reports) || [];
  let sent = 0;
  reports.forEach((r) => { if (r.type === 'outbound-rtp' && r.kind === 'video') sent += r.packetsSent || 0; });
  return sent;
}

async function everyConnectionStaysHealthyDuring(page, checkForMs) {
  const deadline = Date.now() + checkForMs;
  const badStates = [];
  while (Date.now() < deadline) {
    const snap = await page.evaluate(() => window.__webrtcInspector.getSnapshot());
    snap.connections.forEach((c) => {
      if (!c.closed && !['connected', 'completed', 'connecting', 'new', 'checking'].includes(c.state.connectionState)) {
        badStates.push({ id: c.id, connectionState: c.state.connectionState });
      }
    });
    await new Promise((r) => setTimeout(r, POLL_INTERVAL_MS));
  }
  return badStates;
}

test.describe('simulateNetworkLoss / simulateNetworkPreset / registerNetworkPreset against a real LiveKit session', () => {
  test('a media blackout never breaks the underlying PC, and the subscriber cleanly resumes real frames after restore', async ({ browser }) => {
    test.setTimeout(60000);
    const roomName = `network-fault-media-${Date.now()}`;
    const ctxA = await browser.newContext();
    const ctxB = await browser.newContext();
    const pageA = await ctxA.newPage();
    const pageB = await ctxB.newPage();

    try {
      await joinAndPublishWithFakeCam(pageA, roomName, 'alice', ORIGINAL_CAM);
      await joinOnly(pageB, roomName, 'bob');

      await expect.poll(
        () => pageA.evaluate(() => window.__livekitTestHelpers.assertSimulcastNegotiated().encodingCount),
        { timeout: SIMULCAST_NEGOTIATED_TIMEOUT_MS, intervals: [POLL_INTERVAL_MS] }
      ).toBeGreaterThan(1);

      await expect.poll(
        () => resolveAliceVideoOnBob(pageB),
        { timeout: ROOM_JOIN_TIMEOUT_MS, intervals: [POLL_INTERVAL_MS] }
      ).not.toBeNull();
      const found = await resolveAliceVideoOnBob(pageB);
      const beforeRgb = await sampleAliceColorOnBob(pageB, found);
      expect(closeTo(beforeRgb, ORIGINAL_CAM.rgb, 40)).toBe(true);

      const snapBefore = await pageA.evaluate(() => window.__webrtcInspector.getSnapshot());
      const connA = snapBefore.connections.find((c) => (c.localTracks || []).some((t) => t.kind === 'video'));
      expect(connA).toBeTruthy();

      const outageDurationMs = 2500;
      await pageA.evaluate((durationMs) => {
        window.__wrtcOutage = window.__webrtcInspector.simulateNetworkLoss(durationMs, { targets: ['media'] });
      }, outageDurationMs);

      await expect.poll(
        () => pageA.evaluate(() => window.__webrtcInspector.getSnapshot().activeOutages),
        { timeout: 2000, intervals: [POLL_INTERVAL_MS] }
      ).toContain('media');

      // The core safety invariant: a local application-level media blackout
      // must never be mistaken for a transport failure by LiveKit's own
      // engine — the PC itself stays healthy the whole time.
      const badStatesA = await everyConnectionStaysHealthyDuring(pageA, outageDurationMs - 300);
      expect(badStatesA).toEqual([]);

      await pageA.evaluate(() => window.__wrtcOutage.done);

      await expect.poll(
        () => pageA.evaluate(() => window.__webrtcInspector.getSnapshot().activeOutages),
        { timeout: 2000, intervals: [POLL_INTERVAL_MS] }
      ).not.toContain('media');

      // No frozen stream: the subscriber must resume rendering real, fresh
      // frames from alice's real (unchanged) source after restore.
      await expect.poll(
        async () => closeTo(await sampleAliceColorOnBob(pageB, found), ORIGINAL_CAM.rgb, 40),
        { timeout: STATS_FLOWING_TIMEOUT_MS, intervals: [POLL_INTERVAL_MS] }
      ).toBe(true);

      // Real packets flowing again, not just a single stale frame. getSnapshot()
      // reflects the extension's own 2s stats-poll cache (config.statsIntervalMs),
      // not a live read, so this must poll past that interval rather than sleep
      // a fixed amount shorter than it — otherwise both reads can return the
      // exact same cached snapshot and the counts compare equal, not greater.
      const sentAt1 = await outboundPacketsSent(pageA, connA.id);
      await expect.poll(
        () => outboundPacketsSent(pageA, connA.id),
        { timeout: 5000, intervals: [POLL_INTERVAL_MS] }
      ).toBeGreaterThan(sentAt1);
    } finally {
      await ctxA.close();
      await ctxB.close();
    }
  });

  test('simulateNetworkPreset("4g-train") runs its full outage against real infra and the session recovers', async ({ browser }) => {
    test.setTimeout(60000);
    const roomName = `network-fault-preset-${Date.now()}`;
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

      // '4g-train' combines websocket + datachannel + media (see
      // extension/core/webrtc-inspector.js's networkPresets map), so unlike
      // the media-only case above, LiveKit's own signaling may legitimately
      // notice this one and enter a transient reconnecting state — assert
      // eventual convergence back to 'connected', not that it never wavers.
      await pageA.evaluate(() => {
        window.__wrtcPreset = window.__webrtcInspector.simulateNetworkPreset('4g-train');
      });
      await pageA.evaluate(() => window.__wrtcPreset.done);

      await expect.poll(
        () => pageA.evaluate(() => window.__livekitTestHelpers.getConnectionState()),
        { timeout: RECONNECT_CONVERGENCE_TIMEOUT_MS, intervals: [POLL_INTERVAL_MS] }
      ).toBe('connected');

      await expect.poll(
        async () => closeTo(await sampleAliceColorOnBob(pageB, found), ORIGINAL_CAM.rgb, 40),
        { timeout: STATS_FLOWING_TIMEOUT_MS, intervals: [POLL_INTERVAL_MS] }
      ).toBe(true);
    } finally {
      await ctxA.close();
      await ctxB.close();
    }
  });

  test('registerNetworkPreset defines a custom flapping preset that runs to completion against real infra', async ({ browser }) => {
    test.setTimeout(60000);
    const roomName = `network-fault-custom-preset-${Date.now()}`;
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

      await pageA.evaluate(() => {
        window.__webrtcInspector.registerNetworkPreset('flaky-real-test', {
          durationMs: 1500,
          targets: ['media'],
          pattern: 'flapping',
          flapIntervalMs: 300,
        });
        window.__wrtcCustomPreset = window.__webrtcInspector.simulateNetworkPreset('flaky-real-test');
      });
      await pageA.evaluate(() => window.__wrtcCustomPreset.done);

      await expect.poll(
        () => pageA.evaluate(() => window.__webrtcInspector.getSnapshot().activeOutages),
        { timeout: 2000, intervals: [POLL_INTERVAL_MS] }
      ).not.toContain('media');

      await expect.poll(
        async () => closeTo(await sampleAliceColorOnBob(pageB, found), ORIGINAL_CAM.rgb, 40),
        { timeout: STATS_FLOWING_TIMEOUT_MS, intervals: [POLL_INTERVAL_MS] }
      ).toBe(true);
    } finally {
      await ctxA.close();
      await ctxB.close();
    }
  });
});
