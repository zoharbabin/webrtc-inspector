const { test, expect } = require('@playwright/test');
const { mintToken, LIVEKIT_URL } = require('../server.js');
const { ROOM_JOIN_TIMEOUT_MS, SIMULCAST_NEGOTIATED_TIMEOUT_MS, POLL_INTERVAL_MS } = require('../helpers.js');

// Plan section 4 Tier A "getSdp" / section 5 item 6.
// test/specs/peer-connection.spec.js only ever exercises getSdp() against a
// same-page loopback offer/answer, which never negotiates simulcast, RTX, or
// a real multi-m-line unified-plan session the way a real SFU does. This
// file confirms getSdp() captures a real LiveKit offer/answer intact.
// Per the plan's guidance, assertions target structure present (m-line kinds,
// simulcast/RTX markers), not a fixed m-line count, since the exact count
// varies with codec negotiation and is not the thing under test.

async function joinAndPublish(page, roomName, identity) {
  await page.goto('/test/livekit/fixture.html');
  await page.waitForFunction(() => !!window.__livekitTestHelpers);
  const token = await mintToken(identity, roomName);
  await page.evaluate(
    ([url, tok]) => window.__livekitTestHelpers.join(url, tok, {}),
    [LIVEKIT_URL, token]
  );
  await page.evaluate(() => window.__livekitTestHelpers.publishCamMic());
}

function countMlines(sdp, kind) {
  return sdp.split('\n').filter((line) => line.startsWith(`m=${kind} `)).length;
}

test.describe('getSdp against a real LiveKit offer/answer', () => {
  test('captures a real simulcast/RTX-bearing, multi-m-line unified-plan session intact', async ({ browser }) => {
    test.setTimeout(60000);
    const roomName = `sdp-real-${Date.now()}`;
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

      const snap = await pageA.evaluate(() => window.__webrtcInspector.getSnapshot());
      const conn = snap.connections.find((c) => (c.localTracks || []).length > 0);
      expect(conn).toBeTruthy();

      const sdpResult = await pageA.evaluate((connId) => window.__webrtcInspector.getSdp(connId), conn.id);
      expect(sdpResult.local && typeof sdpResult.local.sdp).toBe('string');
      expect(sdpResult.remote && typeof sdpResult.remote.sdp).toBe('string');
      const localSdp = sdpResult.local.sdp;
      const remoteSdp = sdpResult.remote.sdp;
      expect(localSdp.length).toBeGreaterThan(0);
      expect(remoteSdp.length).toBeGreaterThan(0);

      // Unified-plan session description: starts with the mandatory
      // session-level v=/o=/s=/t= lines before any m-line.
      expect(localSdp.startsWith('v=0')).toBe(true);
      expect(remoteSdp.startsWith('v=0')).toBe(true);

      // Real multi-m-line structure (mic + camera), not a synthetic
      // single-m-line loopback offer. Count present, not asserted to any
      // fixed number — LiveKit may bundle/reuse m-lines across renegotiations.
      expect(countMlines(localSdp, 'audio')).toBeGreaterThan(0);
      expect(countMlines(localSdp, 'video')).toBeGreaterThan(0);
      expect(countMlines(remoteSdp, 'audio')).toBeGreaterThan(0);
      expect(countMlines(remoteSdp, 'video')).toBeGreaterThan(0);

      // Real simulcast negotiation marker (a=simulcast + the matching rid
      // lines), only ever produced by a genuine multi-layer publish — the
      // loopback suite never has more than one encoding, so it never emits
      // this either.
      expect(localSdp).toMatch(/a=simulcast:/);
      expect(localSdp).toMatch(/a=rid:\S+ send/);

      // Real RTX negotiation: Chrome's unified-plan video m-line always
      // offers an RTX payload type paired to the primary video codec via
      // apt=, for loss recovery. A synthetic loopback offer never includes
      // this since test/specs never touches a real send path with RTCP NACK.
      expect(localSdp).toMatch(/a=rtpmap:\d+ rtx\/90000/);
      expect(localSdp).toMatch(/a=fmtp:\d+ apt=\d+/);
    } finally {
      await ctxA.close();
    }
  });
});
