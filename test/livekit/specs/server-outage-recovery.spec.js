const { test, expect } = require('@playwright/test');
const { mintToken, LIVEKIT_URL, killServer, restartServer } = require('../server.js');
const {
  ROOM_JOIN_TIMEOUT_MS,
  SIMULCAST_NEGOTIATED_TIMEOUT_MS,
  SERVER_OUTAGE_RECOVERY_TIMEOUT_MS,
  POLL_INTERVAL_MS,
} = require('../helpers.js');

// Plan section 4/5 item 16, new for this build order wave: the one failure
// mode a fixture with no real server process cannot model at all. Distinct
// from reconnect-conflict.spec.js's killConnection/restartIce, which race
// LiveKit's client-side recovery against *our own* fault injection on an
// otherwise-healthy server. Here the server itself is SIGKILLed
// (test/livekit/server.js's killServer(), reached over the loopback-only
// control server started in global-setup.js, since this spec's worker
// process cannot reach the LiveKitDevServer instance directly) and respawned
// from scratch. --dev keeps room state in memory only, so the respawned
// server has no memory of the pre-crash room: livekit-client falls back to a
// full rejoin, not a resume. Assertions are written for that: fresh
// connection id, fresh SDP/ICE, no continuity of pre-crash connection state.

const CAM = { color: '#9933ff', text: 'outage', rgb: [153, 51, 255] };
const KNOWN_ROOM_STATES = ['disconnected', 'connecting', 'connected', 'reconnecting', 'signalReconnecting'];

async function joinAndPublish(page, roomName, identity) {
  await page.goto('/test/livekit/fixture.html');
  await page.waitForFunction(() => !!window.__livekitTestHelpers);
  // Explicit 1280x720: setFakeCam's fake track bypasses videoCaptureDefaults
  // entirely (getUserMedia returns a clone of the canvas track regardless of
  // requested constraints), and its own default of 320x240 is too small for
  // LiveKit's computeVideoEncodings() to negotiate multiple simulcast layers
  // (see fixture.js's buildRoomOptions comment).
  await page.evaluate(
    ([color, text]) => window.__webrtcInspector.setFakeCam({ color, text, width: 1280, height: 720 }),
    [CAM.color, CAM.text]
  );
  const token = await mintToken(identity, roomName);
  await page.evaluate(
    ([url, tok]) => window.__livekitTestHelpers.join(url, tok, {}),
    [LIVEKIT_URL, token]
  );
  await page.evaluate(() => window.__livekitTestHelpers.publishCamMic());
}

test.describe('server-outage-recovery: killing and respawning the real livekit-server process mid-session', () => {
  // Serialized deliberately (see playwright.livekit.config.js's workers: 1):
  // this test owns the one shared livekit-server process for its duration.
  test('a full server crash mid-session forces a clean full rejoin, not a resume, and every extension API keeps working after', async ({ browser }) => {
    test.setTimeout(SERVER_OUTAGE_RECOVERY_TIMEOUT_MS + 60000);
    const roomName = `server-outage-${Date.now()}`;
    const ctxA = await browser.newContext();
    const pageA = await ctxA.newPage();

    try {
      await joinAndPublish(pageA, roomName, 'alice');
      await expect.poll(
        () => pageA.evaluate(() => window.__livekitTestHelpers.getConnectionState()),
        { timeout: ROOM_JOIN_TIMEOUT_MS, intervals: [POLL_INTERVAL_MS] }
      ).toBe('connected');
      await expect.poll(
        () => pageA.evaluate(() => window.__livekitTestHelpers.assertSimulcastNegotiated().encodingCount),
        { timeout: SIMULCAST_NEGOTIATED_TIMEOUT_MS, intervals: [POLL_INTERVAL_MS] }
      ).toBeGreaterThan(1);

      const snapBefore = await pageA.evaluate(() => window.__webrtcInspector.getSnapshot());
      const connBefore = snapBefore.connections.find((c) => !c.closed);
      expect(connBefore).toBeTruthy();
      expect(connBefore.localSdpSummary).toBeTruthy();

      await killServer();

      // connectionState must pass through a real degraded state and never
      // get stuck reporting something self-contradictory — never silently
      // "connected" while the server is actually down.
      let sawDegraded = false;
      const degradedDeadline = Date.now() + 10000;
      while (Date.now() < degradedDeadline) {
        const state = await pageA.evaluate(() => window.__livekitTestHelpers.getConnectionState());
        expect(KNOWN_ROOM_STATES).toContain(state);
        if (state !== 'connected') { sawDegraded = true; break; }
        await new Promise((r) => setTimeout(r, POLL_INTERVAL_MS));
      }
      expect(sawDegraded).toBe(true);

      await restartServer();

      // Full rejoin, not a resume: eventual reconvergence to 'connected'.
      await expect.poll(
        () => pageA.evaluate(() => window.__livekitTestHelpers.getConnectionState()),
        { timeout: SERVER_OUTAGE_RECOVERY_TIMEOUT_MS, intervals: [POLL_INTERVAL_MS] }
      ).toBe('connected');

      // A fresh negotiation happened: a new connection id with its own fresh
      // SDP/ICE, not a resumption of the pre-crash connection's state.
      let snapAfter;
      let connAfter;
      await expect.poll(
        async () => {
          snapAfter = await pageA.evaluate(() => window.__webrtcInspector.getSnapshot());
          connAfter = snapAfter.connections.find((c) => !c.closed && c.id !== connBefore.id);
          return connAfter && connAfter.localSdpSummary ? true : null;
        },
        { timeout: SERVER_OUTAGE_RECOVERY_TIMEOUT_MS, intervals: [POLL_INTERVAL_MS] }
      ).toBe(true);

      expect(connAfter.id).not.toBe(connBefore.id);
      expect(connAfter.remoteSdpSummary).toBeTruthy();
      expect(connAfter.localCandidateTypes.length).toBeGreaterThan(0);
      const preCrashRecord = snapAfter.connections.find((c) => c.id === connBefore.id);
      if (preCrashRecord) expect(preCrashRecord.closed).toBe(true);

      // exportBundle/exportWebrtcInternalsDump stay coherent across the
      // crash/respawn boundary.
      const bundle = await pageA.evaluate(() => window.__webrtcInspector.exportBundle());
      expect(bundle.exportedAt).toBeTruthy();
      expect(bundle.snapshot.connections.length).toBeGreaterThan(0);
      const dump = await pageA.evaluate(() => window.__webrtcInspector.exportWebrtcInternalsDump());
      expect(dump.PeerConnections).toBeTruthy();
      expect(Object.keys(dump.PeerConnections).length).toBeGreaterThan(0);

      // Fault-injection methods still function against the newly negotiated
      // connection: getSdp for real content, capEncoding for a real mutation.
      const sdp = await pageA.evaluate((connId) => window.__webrtcInspector.getSdp(connId), connAfter.id);
      expect(typeof sdp.local.sdp).toBe('string');
      expect(sdp.local.sdp.length).toBeGreaterThan(0);

      const sources = await pageA.evaluate(() => window.__livekitTestHelpers.getLocalVideoSources());
      expect(sources.length).toBeGreaterThan(0);
      await pageA.evaluate(
        ([connId, trackId]) => window.__webrtcInspector.capEncoding(connId, 'video', { maxBitrate: 100000 }, trackId),
        [connAfter.id, sources[0].mediaStreamTrackId]
      );
    } finally {
      await ctxA.close();
    }
  });
});
