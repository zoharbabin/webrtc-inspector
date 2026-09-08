const { test, expect } = require('@playwright/test');
const { mintToken, LIVEKIT_URL } = require('../server.js');
const { ROOM_JOIN_TIMEOUT_MS, RECONNECT_CONVERGENCE_TIMEOUT_MS, POLL_INTERVAL_MS } = require('../helpers.js');

// Plan section 4 Tier A WebSocket row / section 5 item 8. Built alongside
// datachannel-signaling-safety.spec.js: same risk class, moved up from
// Tier B per the plan's finding #18.
// test/fixtures/base.html only ever exercises a hand-rolled MockWebSocket,
// and test/specs/websocket.spec.js only ever sends plain strings over it —
// nothing in the existing suite touches LiveKit's real protobuf-over-
// WebSocket signaling channel. This file confirms setWebSocketInterceptor/
// injectWebSocketMessage on that real, live signaling socket observe real
// traffic without altering it. Injecting a malformed message does NOT go
// unnoticed by LiveKit (measured directly against this real client): its
// protobuf decode throws, which the client treats as a dead signal
// connection, closing the socket and running its own real resume-signal
// and ICE-restart recovery. The safety invariant this file actually
// verifies is that this real failure path never crashes the page and
// genuinely converges back to a healthy, signaling-capable state (proven
// by a real signaling round-trip completing afterward), not that nothing
// happens.

test.describe('signaling-socket-safety: intercept/inject on LiveKit\'s real protobuf signaling WebSocket', () => {
  test('a pass-through interceptor observes real signaling traffic through a full connect + publish, without altering it', async ({ browser }) => {
    test.setTimeout(60000);
    const roomName = `ws-safety-passthrough-${Date.now()}`;
    const ctx = await browser.newContext();
    const page = await ctx.newPage();

    try {
      await page.goto('/test/livekit/fixture.html');
      await page.waitForFunction(() => !!window.__livekitTestHelpers);

      // Installed before connect(), so it's guaranteed to see the very
      // first signaling message (WebSocket construction happens inside
      // room.connect()) — the same registration-order guarantee the
      // extension relies on for the data-channel interceptor.
      await page.evaluate(() => {
        window.__wsSeen = [];
        window.__webrtcInspector.setWebSocketInterceptor((dir, info) => {
          window.__wsSeen.push({
            dir,
            url: info.url,
            isBinary: info.data instanceof ArrayBuffer || (typeof Blob !== 'undefined' && info.data instanceof Blob),
          });
          return undefined; // pass through unchanged
        });
      });

      const token = await mintToken('alice', roomName);
      await page.evaluate(
        ([url, tok]) => window.__livekitTestHelpers.join(url, tok, {}),
        [LIVEKIT_URL, token]
      );
      await expect.poll(
        () => page.evaluate(() => window.__livekitTestHelpers.getConnectionState()),
        { timeout: ROOM_JOIN_TIMEOUT_MS, intervals: [POLL_INTERVAL_MS] }
      ).toBe('connected');

      const snap = await page.evaluate(() => window.__webrtcInspector.getSnapshot());
      const signalingSocket = snap.webSockets.find((s) => s.url.includes('/rtc'));
      expect(signalingSocket).toBeTruthy();
      expect(signalingSocket.state).toBe('open');
      expect(signalingSocket.sentCount).toBeGreaterThan(0);
      expect(signalingSocket.receivedCount).toBeGreaterThan(0);

      // A real publish is itself a signaling round-trip (AddTrack request,
      // TrackPublished response) — proof the interceptor being attached
      // throughout connect + publish never desynced the client.
      await page.evaluate(() => window.__livekitTestHelpers.publishCamMic());
      await expect.poll(
        () => page.evaluate(() => window.__livekitTestHelpers.getLocalVideoSources().length),
        { timeout: ROOM_JOIN_TIMEOUT_MS, intervals: [POLL_INTERVAL_MS] }
      ).toBeGreaterThan(0);

      const seen = await page.evaluate(() => window.__wsSeen);
      expect(seen.length).toBeGreaterThan(0);
      expect(seen.some((e) => e.dir === 'out' && e.url.includes('/rtc'))).toBe(true);
      expect(seen.some((e) => e.dir === 'in' && e.url.includes('/rtc'))).toBe(true);
      // LiveKit's signaling protocol is protobuf-framed, so every real
      // signaling message is binary — never a plain string, unlike
      // test/specs/websocket.spec.js's MockWebSocket stand-in.
      expect(seen.every((e) => e.isBinary)).toBe(true);
    } finally {
      await ctx.close();
    }
  });

  test('injecting a malformed message on the live signaling socket triggers LiveKit\'s own real recovery, not a crash: it reconnects and a real signaling round-trip still completes afterward', async ({ browser }) => {
    test.setTimeout(60000);
    const roomName = `ws-safety-malformed-${Date.now()}`;
    const ctx = await browser.newContext();
    const page = await ctx.newPage();

    try {
      await page.goto('/test/livekit/fixture.html');
      await page.waitForFunction(() => !!window.__livekitTestHelpers);
      const token = await mintToken('alice', roomName);
      await page.evaluate(
        ([url, tok]) => window.__livekitTestHelpers.join(url, tok, {}),
        [LIVEKIT_URL, token]
      );
      await expect.poll(
        () => page.evaluate(() => window.__livekitTestHelpers.getConnectionState()),
        { timeout: ROOM_JOIN_TIMEOUT_MS, intervals: [POLL_INTERVAL_MS] }
      ).toBe('connected');

      const snap = await page.evaluate(() => window.__webrtcInspector.getSnapshot());
      const signalingSocket = snap.webSockets.find((s) => s.url.includes('/rtc'));
      expect(signalingSocket).toBeTruthy();

      const pageErrors = [];
      page.on('pageerror', (err) => pageErrors.push(String(err)));

      // Garbage bytes are not a valid protobuf-framed Signal envelope.
      // Measured directly against this real client: it does NOT silently
      // drop what it can't parse. protobuf-es throws ("illegal tag: field
      // no ... wire type ..."), livekit-client's reading loop treats that
      // as a dead signal connection, closes the WebSocket itself, and runs
      // its own real resume-signal + ICE-restart recovery — room.state goes
      // connected -> signalReconnecting -> connected within a few seconds.
      // The safety invariant this test actually covers is narrower than
      // "nothing happens": the decode failure must never crash the page,
      // and the client's own recovery must genuinely converge back to a
      // healthy, signaling-capable state, not get stuck reconnecting
      // forever or silently desync while claiming to be connected.
      await page.evaluate(
        (socketId) => window.__webrtcInspector.injectWebSocketMessage(
          socketId, new Uint8Array([0xff, 0xff, 0x00, 0xde, 0xad, 0xbe, 0xef]).buffer
        ),
        signalingSocket.id
      );

      await expect.poll(
        () => page.evaluate(() => window.__livekitTestHelpers.getConnectionState()),
        { timeout: RECONNECT_CONVERGENCE_TIMEOUT_MS, intervals: [POLL_INTERVAL_MS] }
      ).toBe('connected');
      expect(pageErrors).toEqual([]);

      // A real signaling round-trip (publish -> AddTrack request ->
      // TrackPublished response) completes on the other side of that real
      // recovery — proof the client's internal signaling state converged
      // back to genuinely healthy, not just to a connected-looking label.
      await page.evaluate(() => window.__livekitTestHelpers.publishCamMic());
      await expect.poll(
        () => page.evaluate(() => window.__livekitTestHelpers.getLocalVideoSources().length),
        { timeout: ROOM_JOIN_TIMEOUT_MS, intervals: [POLL_INTERVAL_MS] }
      ).toBeGreaterThan(0);
    } finally {
      await ctx.close();
    }
  });
});
