const { test, expect } = require('@playwright/test');
const { mintToken, LIVEKIT_URL } = require('../server.js');
const {
  ROOM_JOIN_TIMEOUT_MS,
  SIMULCAST_NEGOTIATED_TIMEOUT_MS,
  CAP_ENCODING_SETTLE_TIMEOUT_MS,
  POLL_INTERVAL_MS,
} = require('../helpers.js');

// Plan section 4 Tier A "getTrackDiagnostics" / section 5 item 5.
// test/specs/peer-connection.spec.js only ever observes qualityLimitationReason
// as 'none' on an unconstrained loopback track, because nothing in that suite
// actually constrains the encoder. Here the sender is deliberately bandwidth-
// starved on a real 1280x720 connection so the browser's real encoder reports
// a real limitation. Per the plan's flake policy, only a valid non-'none'
// value is asserted (cpu/bandwidth/other), never one specific enum, since a
// GPU-less CI runner under contention can legitimately report 'cpu' for
// reasons unrelated to the injected bandwidth cap.
//
// setFakeCam's own content (a solid fill + a small text overlay) is near-zero
// entropy: measured directly against real getStats() on this suite's infra,
// a 20kbps capEncoding() cap never moves qualityLimitationReason off 'none'
// for it, because the encoder can represent that content at any bitrate
// without degrading. To force a *real*, unavoidable limitation, this file
// additionally publishes a second, synthetic per-frame random-block noise
// track via room.localParticipant.publishTrack() (real LiveKit publish API,
// not the extension) and caps that — content no encoder can compress into a
// 4000bps budget without degrading. This deliberately goes through a fresh
// addTrack/negotiation rather than replaceOutgoingTrack(): replaceTrack()
// used to swap the RTCRtpSender's live track without the extension's
// record.localTracks bookkeeping ever picking up the new track id, which
// would have made getTrackDiagnostics() on a replaced track return null
// forever. Fixed directly in webrtc-inspector.js (replaceTrack's success
// handler now updates record.localTracks itself) — this file keeps using
// publishTrack() anyway since a fresh negotiated track is also the simplest
// way to get a second, independently cappable encoder for this test.

const CAM = { color: '#33cc99', text: 'diag', rgb: [51, 204, 153] };
const VALID_LIMITATION_REASONS = ['cpu', 'bandwidth', 'other'];
const VALID_QUALITY_FLAGS = ['ok', 'degraded', 'bad'];

async function joinAndPublishWithFakeCam(page, roomName, identity) {
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

async function joinOnly(page, roomName, identity) {
  await page.goto('/test/livekit/fixture.html');
  await page.waitForFunction(() => !!window.__livekitTestHelpers);
  const token = await mintToken(identity, roomName);
  await page.evaluate(
    ([url, tok]) => window.__livekitTestHelpers.join(url, tok, {}),
    [LIVEKIT_URL, token]
  );
}

// Publishes a second, independent video track carrying per-frame
// random-block noise (no page-JS access to the underlying encoder, so this
// is the only way to force genuinely incompressible content) via LiveKit's
// own publishTrack() — a real addTrack/negotiation, so the extension's
// normal local-track bookkeeping picks it up like any other published
// track. Returns the new track's real MediaStreamTrack id.
async function publishIncompressibleNoiseTrack(page) {
  return page.evaluate(async () => {
    const canvas = document.createElement('canvas');
    canvas.width = 1280;
    canvas.height = 720;
    const ctx = canvas.getContext('2d');
    const cols = 32;
    const rows = 18;
    const cw = canvas.width / cols;
    const ch = canvas.height / rows;
    const draw = () => {
      for (let y = 0; y < rows; y++) {
        for (let x = 0; x < cols; x++) {
          ctx.fillStyle = `rgb(${(Math.random() * 255) | 0},${(Math.random() * 255) | 0},${(Math.random() * 255) | 0})`;
          ctx.fillRect(x * cw, y * ch, cw, ch);
        }
      }
    };
    draw();
    window.__noiseTrackTimer = setInterval(draw, 66);
    const noiseTrack = canvas.captureStream(15).getVideoTracks()[0];
    // simulcast: false — capEncoding() applies maxBitrate uniformly across
    // every RTCRtpEncodingParameters entry (real extension behavior: it caps
    // a sender, not a specific simulcast layer). A 3-layer simulcast sender
    // would get all three layers pinned to the same tiny budget at once,
    // which measured directly against real getStats() falls below the real
    // encoder's per-layer floor: bytesSent goes flat forever on every layer
    // instead of degrading, and qualityLimitationReason never leaves 'none'.
    // A single negotiated layer has no such floor collision.
    const pub = await window.__lkRoom.localParticipant.publishTrack(noiseTrack, { simulcast: false });
    return pub.track.mediaStreamTrack.id;
  });
}

test.describe('getTrackDiagnostics against real simulcast layer-switching', () => {
  test('a real bandwidth-starved sender reports a valid non-\'none\' qualityLimitationReason', async ({ browser }) => {
    // Generous enough to cover CAP_ENCODING_SETTLE_TIMEOUT_MS's own 25s
    // worst case on top of joining/simulcast-negotiation, not just the
    // fast path.
    test.setTimeout(90000);
    const roomName = `track-diagnostics-local-${Date.now()}`;
    const ctxA = await browser.newContext();
    const pageA = await ctxA.newPage();

    try {
      await joinAndPublishWithFakeCam(pageA, roomName, 'alice');

      await expect.poll(
        () => pageA.evaluate(() => window.__livekitTestHelpers.assertSimulcastNegotiated().encodingCount),
        { timeout: SIMULCAST_NEGOTIATED_TIMEOUT_MS, intervals: [POLL_INTERVAL_MS] }
      ).toBeGreaterThan(1);

      const noiseTrackId = await publishIncompressibleNoiseTrack(pageA);
      const snap = await pageA.evaluate(() => window.__webrtcInspector.getSnapshot());
      const connA = snap.connections.find((c) => (c.localTracks || []).some((t) => t.trackId === noiseTrackId));
      expect(connA).toBeTruthy();

      // maintain-resolution is the wrong lever here, measured directly against
      // real getStats(): it disables Chrome's resolution/framerate quality
      // scaler, which is the exact mechanism that ever sets
      // qualityLimitationReason to 'bandwidth' in the first place. Forced to
      // hold 1280x720 at a 4000bps budget with no scaler active, the real
      // encoder doesn't degrade in place — its outbound-rtp bytesSent simply
      // stalls (confirmed flat across dozens of consecutive polls), so it
      // never reports any limitation at all. Omitting degradationPreference
      // (Chrome's real default lets the scaler shrink resolution/framerate to
      // fit) is what actually lets the encoder register the cap as a genuine
      // bandwidth limitation. Re-applied on every poll iteration, not just
      // once: LiveKit runs its own post-publish setParameters() pass on a
      // freshly published track (to install its simulcast encoding config)
      // that can race ours and win, silently lifting the cap back off —
      // re-asserting it each tick converges regardless of that race instead
      // of depending on winning it once.
      const applyCap = () => pageA.evaluate(
        ([connId, trackId]) => window.__webrtcInspector.capEncoding(
          connId, 'video', { maxBitrate: 4000 }, trackId
        ),
        [connA.id, noiseTrackId]
      );
      await applyCap();

      let observedReason = null;
      await expect.poll(
        async () => {
          await applyCap();
          const diag = await pageA.evaluate(
            (trackId) => window.__webrtcInspector.getTrackDiagnostics([trackId]),
            noiseTrackId
          );
          observedReason = diag && diag.qualityLimitationReason;
          return observedReason && observedReason !== 'none' ? observedReason : null;
        },
        { timeout: CAP_ENCODING_SETTLE_TIMEOUT_MS, intervals: [POLL_INTERVAL_MS] }
      ).not.toBeNull();

      console.log(`[track-diagnostics-real] observed local qualityLimitationReason: ${observedReason}`);
      expect(VALID_LIMITATION_REASONS).toContain(observedReason);

      const diag = await pageA.evaluate(
        (trackId) => window.__webrtcInspector.getTrackDiagnostics([trackId]),
        noiseTrackId
      );
      expect(diag.connectionId).toBe(connA.id);
      expect(diag.kind).toBe('video');
      expect(diag.status).toBe('live');
      expect(diag.qualityScore === null || typeof diag.qualityScore === 'number').toBe(true);
    } finally {
      await ctxA.close();
    }
  });

  test('a subscriber\'s remote track diagnostics report valid, self-consistent values under the same real constraint', async ({ browser }) => {
    test.setTimeout(60000);
    const roomName = `track-diagnostics-remote-${Date.now()}`;
    const ctxA = await browser.newContext();
    const ctxB = await browser.newContext();
    const pageA = await ctxA.newPage();
    const pageB = await ctxB.newPage();

    try {
      await joinAndPublishWithFakeCam(pageA, roomName, 'alice');
      await joinOnly(pageB, roomName, 'bob');

      await expect.poll(
        () => pageA.evaluate(() => window.__livekitTestHelpers.assertSimulcastNegotiated().encodingCount),
        { timeout: SIMULCAST_NEGOTIATED_TIMEOUT_MS, intervals: [POLL_INTERVAL_MS] }
      ).toBeGreaterThan(1);

      await expect.poll(
        () => pageB.evaluate(() => Object.keys(window.__livekitTestHelpers.getRemoteTracksByParticipant()).length),
        { timeout: ROOM_JOIN_TIMEOUT_MS, intervals: [POLL_INTERVAL_MS] }
      ).toBe(1);

      const sources = await pageA.evaluate(() => window.__livekitTestHelpers.getLocalVideoSources());
      const localTrackId = sources[0].mediaStreamTrackId;
      const snapA = await pageA.evaluate(() => window.__webrtcInspector.getSnapshot());
      const connA = snapA.connections.find((c) => (c.localTracks || []).some((t) => t.trackId === localTrackId));
      await pageA.evaluate(
        ([connId, trackId]) => window.__webrtcInspector.capEncoding(
          connId, 'video', { maxBitrate: 4000, degradationPreference: 'maintain-resolution' }, trackId
        ),
        [connA.id, localTrackId]
      );

      const remoteByParticipant = await pageB.evaluate(() => window.__livekitTestHelpers.getRemoteTracksByParticipant());
      const remoteVideo = remoteByParticipant.alice.find((t) => t.source === 'camera');
      expect(remoteVideo).toBeTruthy();

      let lastDiag = null;
      await expect.poll(
        async () => {
          lastDiag = await pageB.evaluate(
            (trackId) => window.__webrtcInspector.getTrackDiagnostics([trackId]),
            remoteVideo.mediaStreamTrackId
          );
          return lastDiag;
        },
        { timeout: CAP_ENCODING_SETTLE_TIMEOUT_MS, intervals: [POLL_INTERVAL_MS] }
      ).not.toBeNull();

      expect(lastDiag.kind).toBe('video');
      expect(['live', 'ended']).toContain(lastDiag.status);
      expect(Number.isFinite(lastDiag.freezeRatio) || lastDiag.freezeRatio === null).toBe(true);
      expect(lastDiag.qualityFlag === null || VALID_QUALITY_FLAGS.includes(lastDiag.qualityFlag)).toBe(true);
      expect(lastDiag.qualityScore === null || typeof lastDiag.qualityScore === 'number').toBe(true);
    } finally {
      await ctxA.close();
      await ctxB.close();
    }
  });
});
