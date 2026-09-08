const { test, expect } = require('@playwright/test');
const { mintToken, LIVEKIT_URL } = require('../server.js');
const { ROOM_JOIN_TIMEOUT_MS, POLL_INTERVAL_MS } = require('../helpers.js');

// Plan section 4 Tier A data-channel row / section 5 item 7.
// LiveKit runs its own reliable/lossy data channels (labels '_reliable' and
// '_lossy') to carry its protobuf DataPacket framing — used for
// publishData()/DataReceived and other SFU-to-client signaling. Every
// existing data-channel test (test/specs/datachannel.spec.js) only ever
// exercises an app-created channel, never a channel a real client SDK
// depends on for its own correctness. This file confirms that
// setDataChannelInterceptor/injectDataChannelMessage on LiveKit's own
// channels observes real protobuf traffic without corrupting it, and that
// deliberately malformed injection/blocking doesn't take the room down.

async function join(page, roomName, identity) {
  await page.goto('/test/livekit/fixture.html');
  await page.waitForFunction(() => !!window.__livekitTestHelpers);
  const token = await mintToken(identity, roomName);
  await page.evaluate(
    ([url, tok]) => window.__livekitTestHelpers.join(url, tok, {}),
    [LIVEKIT_URL, token]
  );
}

test.describe('datachannel-signaling-safety: intercept/inject on LiveKit\'s own internal data channels', () => {
  test('a pass-through interceptor observes real protobuf DataPacket traffic without corrupting it', async ({ browser }) => {
    test.setTimeout(60000);
    const roomName = `dc-safety-passthrough-${Date.now()}`;
    const ctxA = await browser.newContext();
    const ctxB = await browser.newContext();
    const pageA = await ctxA.newPage();
    const pageB = await ctxB.newPage();

    try {
      await join(pageA, roomName, 'alice');
      await join(pageB, roomName, 'bob');
      await expect.poll(
        () => pageA.evaluate(() => window.__livekitTestHelpers.getConnectionState()),
        { timeout: ROOM_JOIN_TIMEOUT_MS, intervals: [POLL_INTERVAL_MS] }
      ).toBe('connected');
      await expect.poll(
        () => pageB.evaluate(() => window.__livekitTestHelpers.getConnectionState()),
        { timeout: ROOM_JOIN_TIMEOUT_MS, intervals: [POLL_INTERVAL_MS] }
      ).toBe('connected');

      // LiveKit opens its internal channels on the publisher pc as soon as
      // the room connects, before any app-level publishTrack/publishData —
      // this is real SFU-owned signaling infrastructure, not something our
      // instrumentation has to wait for an app to create.
      await expect.poll(
        () => pageA.evaluate(() => {
          const snap = window.__webrtcInspector.getSnapshot();
          return snap.connections.flatMap((c) => c.dataChannels.map((d) => d.label));
        }),
        { timeout: ROOM_JOIN_TIMEOUT_MS, intervals: [POLL_INTERVAL_MS] }
      ).toEqual(expect.arrayContaining(['_reliable']));

      await pageA.evaluate(() => {
        window.__dcSeen = [];
        window.__webrtcInspector.setDataChannelInterceptor((dir, info) => {
          window.__dcSeen.push({ dir, label: info.label, isUint8: info.data instanceof Uint8Array || info.data instanceof ArrayBuffer });
          return undefined; // pass through unchanged
        });
      });

      await pageB.evaluate(() => {
        window.__dataReceived = [];
        window.__lkRoom.on('dataReceived', (payload, participant) => {
          window.__dataReceived.push({
            text: new TextDecoder().decode(payload),
            identity: participant && participant.identity,
          });
        });
      });

      await pageA.evaluate(() => window.__lkRoom.localParticipant.publishData(
        new TextEncoder().encode('hello-from-alice'), { reliable: true }
      ));

      await expect.poll(
        () => pageB.evaluate(() => window.__dataReceived.map((d) => d.text)),
        { timeout: ROOM_JOIN_TIMEOUT_MS, intervals: [POLL_INTERVAL_MS] }
      ).toContain('hello-from-alice');

      const received = await pageB.evaluate(() => window.__dataReceived[0]);
      expect(received.identity).toBe('alice');

      // The interceptor genuinely saw real outbound protobuf-framed traffic
      // on LiveKit's own channel — proof this isn't just observing an
      // app-level channel that happens to share instrumentation code.
      const seen = await pageA.evaluate(() => window.__dcSeen);
      expect(seen.some((e) => e.dir === 'out' && e.label === '_reliable' && e.isUint8)).toBe(true);

      // Passing the interceptor through unmodified must not have desynced
      // LiveKit's client-side state: the room stays connected on both ends.
      expect(await pageA.evaluate(() => window.__livekitTestHelpers.getConnectionState())).toBe('connected');
      expect(await pageB.evaluate(() => window.__livekitTestHelpers.getConnectionState())).toBe('connected');
    } finally {
      await ctxA.close();
      await ctxB.close();
    }
  });

  test('blocking one message and injecting a malformed one does not corrupt the channel for subsequent real traffic', async ({ browser }) => {
    test.setTimeout(60000);
    const roomName = `dc-safety-malformed-${Date.now()}`;
    const ctxA = await browser.newContext();
    const ctxB = await browser.newContext();
    const pageA = await ctxA.newPage();
    const pageB = await ctxB.newPage();

    try {
      await join(pageA, roomName, 'alice');
      await join(pageB, roomName, 'bob');
      await expect.poll(
        () => pageA.evaluate(() => window.__livekitTestHelpers.getConnectionState()),
        { timeout: ROOM_JOIN_TIMEOUT_MS, intervals: [POLL_INTERVAL_MS] }
      ).toBe('connected');
      await expect.poll(
        () => pageB.evaluate(() => window.__livekitTestHelpers.getConnectionState()),
        { timeout: ROOM_JOIN_TIMEOUT_MS, intervals: [POLL_INTERVAL_MS] }
      ).toBe('connected');
      await expect.poll(
        () => pageA.evaluate(() => {
          const snap = window.__webrtcInspector.getSnapshot();
          return snap.connections.flatMap((c) => c.dataChannels.map((d) => d.label));
        }),
        { timeout: ROOM_JOIN_TIMEOUT_MS, intervals: [POLL_INTERVAL_MS] }
      ).toEqual(expect.arrayContaining(['_reliable']));

      await pageB.evaluate(() => {
        window.__dataReceived = [];
        window.__lkRoom.on('dataReceived', (payload, participant) => {
          window.__dataReceived.push({
            text: new TextDecoder().decode(payload),
            identity: participant && participant.identity,
          });
        });
      });

      // Block exactly one outbound message on alice's own channel, then let
      // everything after it through unmodified.
      await pageA.evaluate(() => {
        window.__blockNext = true;
        window.__webrtcInspector.setDataChannelInterceptor((dir, info) => {
          if (dir !== 'out' || info.label !== '_reliable') return undefined;
          if (window.__blockNext) {
            window.__blockNext = false;
            return false; // block this one message
          }
          return undefined;
        });
      });

      await pageA.evaluate(() => window.__lkRoom.localParticipant.publishData(
        new TextEncoder().encode('should-be-blocked'), { reliable: true }
      ));
      await pageA.evaluate(() => window.__lkRoom.localParticipant.publishData(
        new TextEncoder().encode('should-arrive'), { reliable: true }
      ));

      await expect.poll(
        () => pageB.evaluate(() => window.__dataReceived.map((d) => d.text)),
        { timeout: ROOM_JOIN_TIMEOUT_MS, intervals: [POLL_INTERVAL_MS] }
      ).toContain('should-arrive');

      const texts = await pageB.evaluate(() => window.__dataReceived.map((d) => d.text));
      expect(texts).not.toContain('should-be-blocked');

      // Now inject a malformed (non-protobuf) inbound message directly on
      // bob's receiving channel, bypassing LiveKit's own send path entirely.
      // The safety invariant under test is that this must not crash the
      // page or desync the room — LiveKit is free to silently drop/ignore
      // bytes it can't decode as a DataPacket.
      const connB = await pageB.evaluate(() => window.__webrtcInspector.getSnapshot().connections[0]);
      const pageErrors = [];
      pageB.on('pageerror', (err) => pageErrors.push(String(err)));
      await pageB.evaluate(
        (connId) => window.__webrtcInspector.injectDataChannelMessage(
          connId, '_reliable', new Uint8Array([0xff, 0x00, 0xde, 0xad, 0xbe, 0xef])
        ),
        connB.id
      );
      await pageB.waitForTimeout(500);
      expect(pageErrors).toEqual([]);
      expect(await pageB.evaluate(() => window.__livekitTestHelpers.getConnectionState())).toBe('connected');

      // Real traffic still flows after the malformed injection — the
      // channel itself is not corrupted by having carried garbage bytes.
      await pageA.evaluate(() => window.__lkRoom.localParticipant.publishData(
        new TextEncoder().encode('still-works-after-garbage'), { reliable: true }
      ));
      await expect.poll(
        () => pageB.evaluate(() => window.__dataReceived.map((d) => d.text)),
        { timeout: ROOM_JOIN_TIMEOUT_MS, intervals: [POLL_INTERVAL_MS] }
      ).toContain('still-works-after-garbage');
    } finally {
      await ctxA.close();
      await ctxB.close();
    }
  });
});
