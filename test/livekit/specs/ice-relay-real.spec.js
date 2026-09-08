const { test, expect } = require('@playwright/test');
const { mintToken, LIVEKIT_URL } = require('../server.js');
const { ROOM_JOIN_TIMEOUT_MS, POLL_INTERVAL_MS } = require('../helpers.js');

// Plan section 4 Tier A "setIceCandidateFilter" / section 5 item 9.
// test/specs/ice-candidate-filter.spec.js only ever drops candidates on a
// same-page loopback pc pair with no real TURN server behind it, so a
// dropped 'host' type just means the pair never connects — it never proves
// a *relay* pair can actually carry media. test/livekit/server.js already
// stands up a real embedded TURN listener. This file forces every candidate
// except 'relay' off the table and asserts the connection still carries
// real media through the embedded TURN server.
//
// Two real findings from measuring this directly, both incorporated below:
//
// 1. setIceCandidateFilter alone (dropping only 'host' from the app-visible
//    icecandidate/addIceCandidate path) is NOT sufficient to force a
//    relay-only path. Chrome's ICE agent still discovers a working 'srflx'
//    address on its own (LiveKit's dev TURN server also answers plain STUN
//    binding requests) and negotiates directly through it — ICE always
//    prefers a cheaper working pair over relay, independent of what the
//    app-level candidate filter advertised. Forcing genuine relay-only
//    requires the real iceTransportPolicy: 'relay' RTCConfiguration flag,
//    which only the app (not this extension) can set. This is passed here
//    via room.connect()'s connectOptions.rtcConfig — a RoomConnectOptions
//    field, not a RoomOptions field (a real bug in fixture.js's join() was
//    fixed alongside this test: it built RoomOptions from its opts param
//    and called room.connect(url, token) with no connectOptions at all, so
//    rtcConfig was silently dropped no matter what was passed).
// 2. Even with iceTransportPolicy: 'relay' actually in effect — confirmed by
//    conn.localCandidateTypes containing only 'relay', proving Chrome never
//    gathered a host/srflx candidate at all — the nominated candidate-pair's
//    local-candidate stats report is still consistently labeled 'prflx' by
//    Chrome's getStats(), not 'relay'. This is a known Chrome stats quirk:
//    the winning pair's local candidate can be reported as peer-reflexive
//    even when the only candidate ever gathered was a relay allocation.
//    Asserting the nominated pair's reported type is literally 'relay' is
//    therefore the wrong check; the real invariant is that no non-relay
//    candidate type ever appears in localCandidateTypes.

async function join(page, roomName, identity) {
  await page.goto('/test/livekit/fixture.html');
  await page.waitForFunction(() => !!window.__livekitTestHelpers);
  // Registered before join() even starts, and setIceCandidateFilter is
  // applied synchronously from the 'pc-created' event — emit() calls
  // listeners synchronously inside the RTCPeerConnection constructor patch,
  // before the constructor returns and before ICE gathering can start — so
  // this always wins the race against the very first candidate. Combined
  // with iceTransportPolicy: 'relay' below as defense in depth: this proves
  // our own filter feature doesn't fight with or break a real relay-forced
  // negotiation.
  await page.evaluate(() => {
    window.__webrtcInspector.onEvent((entry) => {
      if (entry.type === 'pc-created') {
        window.__webrtcInspector.setIceCandidateFilter(entry.connectionId, (type) => type === 'relay');
      }
    });
  });
  const token = await mintToken(identity, roomName);
  await page.evaluate(
    ([url, tok]) => window.__livekitTestHelpers.join(url, tok, {}, { rtcConfig: { iceTransportPolicy: 'relay' } }),
    [LIVEKIT_URL, token]
  );
}

test.describe('ice-relay-real: forcing a real relay-only path through the embedded TURN server', () => {
  test('a relay-only ICE policy plus setIceCandidateFilter still connects and carries real media through the embedded TURN server', async ({ browser }) => {
    test.setTimeout(60000);
    const roomName = `ice-relay-${Date.now()}`;
    const ctx = await browser.newContext();
    const page = await ctx.newPage();

    try {
      await join(page, roomName, 'alice');
      await page.evaluate(() => window.__livekitTestHelpers.publishCamMic());

      await expect.poll(
        () => page.evaluate(() => window.__livekitTestHelpers.getConnectionState()),
        { timeout: ROOM_JOIN_TIMEOUT_MS, intervals: [POLL_INTERVAL_MS] }
      ).toBe('connected');

      // Confirm no non-relay candidate ever appeared on the real connection —
      // not just that connection state happened to reach 'connected' some
      // other way. See finding #2 above for why we don't assert the
      // nominated pair's reported local-candidate type directly.
      const snap = await page.evaluate(() => window.__webrtcInspector.getSnapshot());
      const conn = snap.connections.find((c) => (c.localTracks || []).length > 0);
      expect(conn).toBeTruthy();
      expect(conn.localCandidateTypes.length).toBeGreaterThan(0);
      expect(conn.localCandidateTypes.every((t) => t === 'relay')).toBe(true);

      // Real end-to-end media, not just a nominated pair: outbound bytes on
      // this real relay-only path keep advancing.
      const bytesAt = () => page.evaluate((connId) => {
        const s = window.__webrtcInspector.getSnapshot({ detail: 'detailed' });
        const c = s.connections.find((x) => x.id === connId);
        const reports = (c && c.latestStats && c.latestStats.reports) || [];
        return reports.filter((r) => r.type === 'outbound-rtp' && r.kind === 'video')
          .reduce((sum, r) => sum + (r.bytesSent || 0), 0);
      }, conn.id);

      const before = await bytesAt();
      await expect.poll(bytesAt, { timeout: ROOM_JOIN_TIMEOUT_MS, intervals: [POLL_INTERVAL_MS] })
        .toBeGreaterThan(before);
    } finally {
      await ctx.close();
    }
  });
});
