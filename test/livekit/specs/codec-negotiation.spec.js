const { test, expect } = require('@playwright/test');
const { mintToken, LIVEKIT_URL } = require('../server.js');
const { ROOM_JOIN_TIMEOUT_MS, SIMULCAST_NEGOTIATED_TIMEOUT_MS, TRACK_SUBSCRIBED_TIMEOUT_MS, POLL_INTERVAL_MS } = require('../helpers.js');

// Plan section 4 Tier B "registerDecoder/setSuggestDecoder/setLabeler" /
// section 5 item 12. registerDecoder/setSuggestDecoder operate purely on
// data-channel and WebSocket message payloads (test/specs/suggest-decoder.spec.js,
// test/specs/message-decoder.spec.js) — they have no access to SDP or codec
// negotiation at all. What's genuinely worth confirming against a real
// session is that attaching them to LiveKit's own internal data channels
// (the same risk class as datachannel-signaling-safety.spec.js) never
// interferes with the real multi-codec offer/answer happening on the same
// PC's media m-lines, since both run through the same connection record.
//
// setLabeler only supports two meta.kind values — 'connection' (by ICE
// server URL) and 'websocket' (by URL); see extension/core/webrtc-inspector.js's
// computeLabel call sites. There is no track-kind labeling API at all, so
// "labeling survives LiveKit's track ID scheme" is tested here as the real,
// adjacent invariant: our own getSnapshot() track records report the raw
// MediaStreamTrack.id, which must stay correct and distinguishable from
// LiveKit's own parallel trackSid scheme even while a labeler is active.
//
// Real finding from measuring this directly, now fixed in the extension:
// LiveKit fetches its TURN server list from its own signaling and applies it
// to the already-constructed publisher PC via pc.setConfiguration() — never
// at the RTCPeerConnection constructor. webrtc-inspector.js only ever
// captured the configuration passed to the constructor, so
// record.configuration (and therefore setLabeler's URL matching and
// exportWebrtcInternalsDump()'s rtcConfiguration field) stayed permanently
// empty for every real LiveKit connection, even once the live PC had a real
// TURN server configured. Fixed by also patching
// RTCPeerConnection.prototype.setConfiguration to refresh record.configuration
// from the browser's own getConfiguration() after every call.

async function gotoFixture(page) {
  await page.goto('/test/livekit/fixture.html');
  await page.waitForFunction(() => !!window.__livekitTestHelpers);
}

// Hooks must be registered after gotoFixture() but before this connects, on
// the same page — join() must never navigate again itself, or a page.goto()
// against the same URL reloads the page and wipes out whatever was just
// registered before the room ever connects.
async function joinOnCurrentPage(page, roomName, identity) {
  const token = await mintToken(identity, roomName);
  await page.evaluate(
    ([url, tok]) => window.__livekitTestHelpers.join(url, tok, {}),
    [LIVEKIT_URL, token]
  );
}

test.describe('codec-negotiation: decoder/labeler hooks against a real multi-codec LiveKit offer', () => {
  test('registerDecoder/setSuggestDecoder on LiveKit\'s own data channel do not interfere with real simulcast/codec negotiation', async ({ browser }) => {
    test.setTimeout(60000);
    const roomName = `codec-neg-decoder-${Date.now()}`;
    const ctx = await browser.newContext();
    const page = await ctx.newPage();

    try {
      await gotoFixture(page);
      await page.evaluate(() => {
        window.__decoderCalls = 0;
        window.__suggestCalls = 0;
        window.__webrtcInspector.registerDecoder(
          (meta) => meta.kind === 'datachannel' && meta.label === '_reliable',
          () => { window.__decoderCalls++; return { via: 'registered' }; }
        );
        window.__webrtcInspector.setSuggestDecoder(() => { window.__suggestCalls++; return { guess: 'fallback' }; });
      });

      await joinOnCurrentPage(page, roomName, 'alice');
      await expect.poll(
        () => page.evaluate(() => window.__livekitTestHelpers.getConnectionState()),
        { timeout: ROOM_JOIN_TIMEOUT_MS, intervals: [POLL_INTERVAL_MS] }
      ).toBe('connected');

      await page.evaluate(() => window.__livekitTestHelpers.publishCamMic());

      // A real multi-layer simulcast negotiation completing at all is proof
      // the decoder hooks (registered before join(), so active for every
      // message LiveKit's own _reliable channel carries from the start)
      // never touched the media path.
      await expect.poll(
        () => page.evaluate(() => window.__livekitTestHelpers.assertSimulcastNegotiated().encodingCount),
        { timeout: SIMULCAST_NEGOTIATED_TIMEOUT_MS, intervals: [POLL_INTERVAL_MS] }
      ).toBeGreaterThan(1);

      const snap = await page.evaluate(() => window.__webrtcInspector.getSnapshot());
      const conn = snap.connections.find((c) => (c.localTracks || []).length > 0);
      const sdpResult = await page.evaluate((connId) => window.__webrtcInspector.getSdp(connId), conn.id);
      const localSdp = sdpResult.local.sdp;

      // Real structure a synthetic loopback offer never produces: simulcast
      // markers plus an RTX payload paired to the primary video codec.
      expect(localSdp).toMatch(/a=simulcast:/);
      expect(localSdp).toMatch(/a=rtpmap:\d+ rtx\/90000/);

      // publishCamMic() alone never guarantees any traffic on '_reliable' —
      // measured directly, per datachannel-signaling-safety.spec.js's own
      // finding, LiveKit only sends on it in response to an explicit
      // publishData() call (or other protocol events like active-speaker
      // updates, neither of which connect()+publish alone triggers).
      await page.evaluate(() => window.__lkRoom.localParticipant.publishData(
        new TextEncoder().encode('codec-negotiation-probe'), { reliable: true }
      ));

      // The registered decoder actually ran against real protobuf traffic on
      // LiveKit's own channel (not just a synthetic app message) — proof the
      // hook was genuinely exercised throughout, not merely present and unused.
      await expect.poll(
        () => page.evaluate(() => window.__decoderCalls),
        { timeout: TRACK_SUBSCRIBED_TIMEOUT_MS, intervals: [POLL_INTERVAL_MS] }
      ).toBeGreaterThan(0);

      // setSuggestDecoder is a single global fallback shared by every
      // unmatched datachannel AND websocket message (runDecoders' two call
      // sites) — real traffic on '_lossy', '_data_track', and the signaling
      // WebSocket all legitimately fall through to it too, since our
      // registered decoder only matches '_reliable'. What matters is that
      // both hooks kept running throughout without desyncing the room.
      expect(await page.evaluate(() => window.__suggestCalls)).toBeGreaterThan(0);

      expect(await page.evaluate(() => window.__livekitTestHelpers.getConnectionState())).toBe('connected');
    } finally {
      await ctx.close();
    }
  });

  test('setLabeler labels a real LiveKit connection by its real TURN URL, and our track ids stay distinct from LiveKit\'s own trackSid scheme', async ({ browser }) => {
    test.setTimeout(60000);
    const roomName = `codec-neg-labeler-${Date.now()}`;
    const ctx = await browser.newContext();
    const page = await ctx.newPage();

    try {
      await gotoFixture(page);
      await page.evaluate(() => {
        window.__webrtcInspector.setLabeler((meta) => {
          if (meta.kind === 'connection' && meta.urls.some((u) => u.startsWith('turn:'))) return 'real-turn-server';
          return null;
        });
      });

      await joinOnCurrentPage(page, roomName, 'alice');
      await expect.poll(
        () => page.evaluate(() => window.__livekitTestHelpers.getConnectionState()),
        { timeout: ROOM_JOIN_TIMEOUT_MS, intervals: [POLL_INTERVAL_MS] }
      ).toBe('connected');
      await page.evaluate(() => window.__livekitTestHelpers.publishCamMic());
      await expect.poll(
        () => page.evaluate(() => window.__livekitTestHelpers.getLocalVideoSources().length),
        { timeout: TRACK_SUBSCRIBED_TIMEOUT_MS, intervals: [POLL_INTERVAL_MS] }
      ).toBeGreaterThan(0);

      const snap = await page.evaluate(() => window.__webrtcInspector.getSnapshot());
      const conn = snap.connections.find((c) => (c.localTracks || []).length > 0);
      expect(conn.label).toBe('real-turn-server');
      expect(snap.labelerActive).toBe(true);

      // Our own track id (the raw MediaStreamTrack.id) must be reported
      // correctly and must not collide with or get replaced by LiveKit's own
      // trackSid, which is a completely separate identifier scheme carried
      // in the LiveKit protocol layer, not on the RTCPeerConnection.
      const localVideoSources = await page.evaluate(() => window.__livekitTestHelpers.getLocalVideoSources());
      const cam = localVideoSources.find((s) => s.source === 'camera');
      expect(cam).toBeTruthy();
      expect(cam.trackSid).toMatch(/^TR_/);
      const ourTrack = conn.localTracks.find((t) => t.trackId === cam.mediaStreamTrackId);
      expect(ourTrack).toBeTruthy();
      expect(ourTrack.trackId).not.toBe(cam.trackSid);
    } finally {
      await ctx.close();
    }
  });
});
