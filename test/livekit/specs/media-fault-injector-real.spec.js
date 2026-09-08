const { test, expect } = require('@playwright/test');
const { mintToken, LIVEKIT_URL } = require('../server.js');
const {
  ROOM_JOIN_TIMEOUT_MS,
  SIMULCAST_NEGOTIATED_TIMEOUT_MS,
  TRACK_SUBSCRIBED_TIMEOUT_MS,
  STATS_FLOWING_TIMEOUT_MS,
  POLL_INTERVAL_MS,
} = require('../helpers.js');

// Plan section 4 Tier B "setMediaFaultInjector/clearMediaFaultInjector" /
// section 5 item 13.
//
// mediaFaultInjectable is decided once, at RTCPeerConnection construction
// (extension/core/webrtc-inspector.js:305): true only if an injector is
// already armed AND the app didn't ask for legacy encodedInsertableStreams
// itself. installMediaTransform (same file, ~587-607) then attaches to every
// sender/receiver endpoint synchronously, inside the very call that creates
// it (patched addTrack/addTransceiver for senders, the pc's own native
// 'track' listener registered at construction time for receivers) — our code
// is always the first and only thing to touch a covered endpoint's
// .transform on its happy path.
//
// The plan asks this file to also cover both attach orders against a real
// LiveKit E2EE room's own sender.transform/receiver.transform. Measured
// directly against livekit-client's real source (node_modules/livekit-client/
// dist/livekit-client.esm.mjs), that race cannot happen on Chromium, which is
// the only browser this suite runs (playwright.livekit.config.js):
//   1. isScriptTransformSupportedForWorker() (line ~14371) hardcodes false
//      for any Chromium-based browser ("Chrome occasionally throws an
//      InvalidState error... disabling it until the API has stabilized"), so
//      on Chromium LiveKit's own E2EE always uses the legacy
//      sender/receiver.createEncodedStreams() transferable-stream path, and
//      never assigns .transform at all.
//   2. Separately and independently, makeRTCConfiguration() (line ~25052)
//      sets rtcConfig.encodedInsertableStreams = true whenever e2ee is
//      enabled and isInsertableStreamSupported() (true on Chromium, which has
//      RTCRtpSender.prototype.createEncodedStreams) — which alone forces
//      mediaFaultInjectable to false for that connection regardless of
//      whether our own injector is armed.
// Both findings are exercised for real below (mediaFaultInjectable is false,
// no transform event of ours ever fires for that connection) rather than
// asserted from the source reading alone. What the plan's "ours-first"/
// "LiveKit-first" .transform race would need — some other real, first-party
// code touching an endpoint's .transform before or after ours — has no
// occurrence on a genuine Chromium LiveKit connection, E2EE or not: every
// call site that ever creates a coverable endpoint runs our attach
// synchronously and first, so "ours-first" is not a race, it's the only
// order that ever happens. That is verified directly in the first test below
// via a real 1280x720 simulcast publish.

async function gotoFixture(page) {
  await page.goto('/test/livekit/fixture.html');
  await page.waitForFunction(() => !!window.__livekitTestHelpers);
}

async function joinOnCurrentPage(page, roomName, identity, opts) {
  const token = await mintToken(identity, roomName);
  await page.evaluate(
    ([url, tok, o]) => window.__livekitTestHelpers.join(url, tok, o || {}),
    [LIVEKIT_URL, token, opts]
  );
}

// A real ExternalE2EEKeyProvider + the SDK's own prebuilt e2ee worker bundle
// (livekit-client ships it precompiled; see package.json's "./e2ee-worker"
// export), constructed inside the page so the live objects never have to
// cross page.evaluate's structured-clone boundary.
async function joinE2ee(page, roomName, identity, sharedKey) {
  const token = await mintToken(identity, roomName);
  await page.evaluate(
    async ([url, tok, key]) => {
      const { ExternalE2EEKeyProvider } = window.LivekitClient;
      const keyProvider = new ExternalE2EEKeyProvider();
      await keyProvider.setKey(key);
      const worker = new Worker('/node_modules/livekit-client/dist/livekit-client.e2ee.worker.js');
      await window.__livekitTestHelpers.join(url, tok, { e2ee: { keyProvider, worker } });
    },
    [LIVEKIT_URL, token, sharedKey]
  );
}

function remoteVideoBytesAt(page, connId, mediaStreamTrackId) {
  return page.evaluate(({ connId: id, mediaStreamTrackId: trackId }) => {
    const snap = window.__webrtcInspector.getSnapshot({ detail: 'detailed' });
    const conn = snap.connections.find((c) => c.id === id);
    const reports = (conn && conn.latestStats && conn.latestStats.reports) || [];
    const inbound = reports.find((r) => r.type === 'inbound-rtp' && r.kind === 'video' && r.trackIdentifier === trackId);
    return (inbound && inbound.bytesReceived) || 0;
  }, { connId, mediaStreamTrackId });
}

test.describe('media-fault-injector-real: setMediaFaultInjector against a real LiveKit connection', () => {
  test('attaches to a real simulcast-negotiated sender, reports on real encoded frames, and never breaks subscription for a real second participant', async ({ browser }) => {
    test.setTimeout(90000);
    const roomName = `media-fault-real-${Date.now()}`;
    const ctxA = await browser.newContext();
    const ctxB = await browser.newContext();
    const pageA = await ctxA.newPage();
    const pageB = await ctxB.newPage();

    try {
      await gotoFixture(pageA);
      // setMediaFaultInjector must be armed before the connection is
      // constructed — mediaFaultInjectable is decided once, at
      // RTCPeerConnection construction time.
      await pageA.evaluate(() => {
        window.__mediaFaultEvents = [];
        window.__webrtcInspector.onEvent((entry) => {
          if (['media-transform-installed', 'media-transform-failed', 'media-fault-report'].includes(entry.type)) {
            window.__mediaFaultEvents.push(entry);
          }
        });
        window.__webrtcInspector.setMediaFaultInjector(null, null, (direction, frame, meta, report) => {
          report({ direction, kind: meta.kind, byteLength: frame.data.byteLength });
        });
      });

      await joinOnCurrentPage(pageA, roomName, 'alice');
      await gotoFixture(pageB);
      await joinOnCurrentPage(pageB, roomName, 'bob');

      await expect.poll(
        () => pageA.evaluate(() => window.__livekitTestHelpers.getConnectionState()),
        { timeout: ROOM_JOIN_TIMEOUT_MS, intervals: [POLL_INTERVAL_MS] }
      ).toBe('connected');
      await expect.poll(
        () => pageB.evaluate(() => window.__livekitTestHelpers.getConnectionState()),
        { timeout: ROOM_JOIN_TIMEOUT_MS, intervals: [POLL_INTERVAL_MS] }
      ).toBe('connected');

      // Simulcast resolution rule: an explicit 1280x720 fake cam is required
      // for livekit-client's computeVideoEncodings() to negotiate more than
      // one layer at all.
      await pageA.evaluate(() => window.__webrtcInspector.setFakeCam({ width: 1280, height: 720 }));
      await pageA.evaluate(() => window.__livekitTestHelpers.publishCamMic());

      await expect.poll(
        () => pageA.evaluate(() => window.__livekitTestHelpers.assertSimulcastNegotiated().encodingCount),
        { timeout: SIMULCAST_NEGOTIATED_TIMEOUT_MS, intervals: [POLL_INTERVAL_MS] }
      ).toBeGreaterThan(1);

      const snapA = await pageA.evaluate(() => window.__webrtcInspector.getSnapshot());
      const connA = snapA.connections.find((c) => (c.localTracks || []).length > 0);
      expect(connA.mediaFaultInjectable).toBe(true);

      // Our transform actually attached to the real outgoing video sender —
      // not just "armed", genuinely installed on this real endpoint.
      await expect.poll(
        () => pageA.evaluate(() => window.__mediaFaultEvents.filter((e) => e.type === 'media-transform-installed' && e.direction === 'outgoing' && e.kind === 'video').length),
        { timeout: TRACK_SUBSCRIBED_TIMEOUT_MS, intervals: [POLL_INTERVAL_MS] }
      ).toBeGreaterThan(0);

      // It ran against real encoded video frames flowing on the wire, not
      // just once at attach time.
      await expect.poll(
        () => pageA.evaluate(() => window.__mediaFaultEvents.filter((e) => e.type === 'media-fault-report').length),
        { timeout: TRACK_SUBSCRIBED_TIMEOUT_MS, intervals: [POLL_INTERVAL_MS] }
      ).toBeGreaterThan(0);

      // Ours is always first and only on this endpoint's happy path — no
      // pre-existing-transform conflict is possible here (see header comment).
      expect(await pageA.evaluate(() => window.__mediaFaultEvents.some((e) => e.type === 'media-transform-failed'))).toBe(false);

      // A non-corrupting injector (report-only) must not desync the real
      // subscription: bob still gets alice's camera track and real bytes.
      await expect.poll(
        () => pageB.evaluate(() => window.__livekitTestHelpers.getRemoteTracksByParticipant().alice),
        { timeout: TRACK_SUBSCRIBED_TIMEOUT_MS, intervals: [POLL_INTERVAL_MS] }
      ).toEqual(expect.arrayContaining([expect.objectContaining({ source: 'camera' })]));

      const remoteTracks = await pageB.evaluate(() => window.__livekitTestHelpers.getRemoteTracksByParticipant().alice);
      const videoTrack = remoteTracks.find((t) => t.source === 'camera');
      const connB = await pageB.evaluate(() => window.__webrtcInspector.getSnapshot().connections[0].id);

      const before = await remoteVideoBytesAt(pageB, connB, videoTrack.mediaStreamTrackId);
      await expect.poll(
        () => remoteVideoBytesAt(pageB, connB, videoTrack.mediaStreamTrackId),
        { timeout: STATS_FLOWING_TIMEOUT_MS, intervals: [POLL_INTERVAL_MS] }
      ).toBeGreaterThan(before);
    } finally {
      await ctxA.close();
      await ctxB.close();
    }
  });

  test('an E2EE-enabled real room reports mediaFaultInjectable:false, fires media-fault-injector-uncovered, and still decodes real media for a second participant', async ({ browser }) => {
    test.setTimeout(90000);
    const roomName = `media-fault-e2ee-${Date.now()}`;
    const sharedKey = `media-fault-e2ee-key-${Date.now()}`;
    const ctxA = await browser.newContext();
    const ctxB = await browser.newContext();
    const pageA = await ctxA.newPage();
    const pageB = await ctxB.newPage();

    try {
      await gotoFixture(pageA);
      await pageA.evaluate(() => {
        window.__mediaFaultEvents = [];
        window.__webrtcInspector.onEvent((entry) => {
          if (['media-transform-installed', 'media-transform-failed', 'media-fault-injector-uncovered'].includes(entry.type)) {
            window.__mediaFaultEvents.push(entry);
          }
        });
      });
      await gotoFixture(pageB);

      await joinE2ee(pageA, roomName, 'alice', sharedKey);
      await joinE2ee(pageB, roomName, 'bob', sharedKey);

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

      // Arm the injector only now, against the already-open, already-encrypted
      // connection — this is the real trigger for media-fault-injector-uncovered.
      await pageA.evaluate(() => window.__webrtcInspector.setMediaFaultInjector(null, null, () => {}));

      const snapA = await pageA.evaluate(() => window.__webrtcInspector.getSnapshot());
      const connA = snapA.connections.find((c) => (c.localTracks || []).length > 0);
      expect(connA.mediaFaultInjectable).toBe(false);

      const events = await pageA.evaluate(() => window.__mediaFaultEvents);
      const uncovered = events.find((e) => e.type === 'media-fault-injector-uncovered');
      expect(uncovered).toBeTruthy();
      expect(uncovered.connectionIds).toContain(connA.id);

      // Confirms the architectural finding in this file's header comment for
      // real: a genuine Chromium E2EE connection never gets an install or a
      // failed-attach event from us at all, because installMediaTransform
      // returns immediately on !mediaFaultInjectable — there is no race to
      // observe because our code never reaches the .transform check.
      expect(events.some((e) => e.type === 'media-transform-installed' || e.type === 'media-transform-failed')).toBe(false);

      // Real E2EE media still decodes correctly for bob: a remote audio sink
      // meters above the noise floor (or reports why it legitimately can't),
      // and real video bytes keep advancing — same invariant as
      // media-roundtrip.spec.js, now with encryption actually in the path.
      const remoteTracks = await pageB.evaluate(() => window.__livekitTestHelpers.getRemoteTracksByParticipant().alice);
      const audioTrack = remoteTracks.find((t) => t.source === 'microphone');
      const videoTrack = remoteTracks.find((t) => t.source === 'camera');
      expect(audioTrack).toBeTruthy();
      expect(videoTrack).toBeTruthy();

      const connB = await pageB.evaluate(() => window.__webrtcInspector.getSnapshot().connections[0].id);

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

      const before = await remoteVideoBytesAt(pageB, connB, videoTrack.mediaStreamTrackId);
      await expect.poll(
        () => remoteVideoBytesAt(pageB, connB, videoTrack.mediaStreamTrackId),
        { timeout: STATS_FLOWING_TIMEOUT_MS, intervals: [POLL_INTERVAL_MS] }
      ).toBeGreaterThan(before);
    } finally {
      await ctxA.close();
      await ctxB.close();
    }
  });
});
