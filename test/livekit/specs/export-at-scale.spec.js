const { test, expect } = require('@playwright/test');
const { mintToken, LIVEKIT_URL } = require('../server.js');
const { ROOM_JOIN_TIMEOUT_MS, TRACK_SUBSCRIBED_TIMEOUT_MS, STATS_FLOWING_TIMEOUT_MS, POLL_INTERVAL_MS } = require('../helpers.js');

// Plan section 4 Tier B "exportBundle/exportWebrtcInternalsDump" / section 5
// item 14. Confirms both export formats capture a real 3-participant LiveKit
// session completely, stay bounded in size under real eviction load (not a
// synthetic bypass of the caps), and separate camera from screen-share
// tracks correctly in the export output.
//
// The two caps this exercises for real, both in extension/core/webrtc-inspector.js:
//   - config.maxConnectionHistory (100): evictClosedConnections() (~line 1304)
//     only ever deletes a *closed* connection record, oldest first, once
//     connectionsById.size exceeds 100 — a live connection is never evicted
//     no matter how many other connections exist. Exercised below by opening
//     and closing 110 real, throwaway RTCPeerConnections alongside the one
//     real LiveKit session, then confirming the cap held while the live
//     session's own connection record is still fully present in both exports.
//   - The per-record 200-message cap on data-channel/websocket records
//     (dcRecord.messages.length > 200 → shift(), three call sites). Not
//     directly observable as a raw array in either export — getSnapshot()
//     (which both exports build on) only ever exposes a capped `messageCount`
//     (dataChannels[].messageCount, literally d.messages.length) and the last
//     10 messages. Exercised below by sending 220 real messages over LiveKit's
//     own `_reliable` data channel via publishData(), then confirming
//     messageCount settles at exactly 200 (the array capped, not the count of
//     messages actually sent) rather than growing unbounded.
//
// Camera vs screen-share separability is a different field than
// topology.spec.js's existing coverage: that file asserts on LiveKit's own
// pub.source ('camera' vs 'screen_share'). This file asserts on the
// extension's own, separate localTracks[].sourceTag field (set by the
// patched getUserMedia/getDisplayMedia — 'real-device' for the camera/mic
// tracks here since setFakeCam/setFakeMic are never armed in this test, and
// 'display-capture' unconditionally for every getDisplayMedia()-served
// track), which is what exportBundle's snapshot actually carries.

async function gotoFixture(page) {
  await page.goto('/test/livekit/fixture.html');
  await page.waitForFunction(() => !!window.__livekitTestHelpers);
}

async function joinOnCurrentPage(page, roomName, identity) {
  const token = await mintToken(identity, roomName);
  await page.evaluate(
    ([url, tok]) => window.__livekitTestHelpers.join(url, tok, {}),
    [LIVEKIT_URL, token]
  );
}

test.describe('export-at-scale: exportBundle/exportWebrtcInternalsDump against a real multi-participant session under real eviction load', () => {
  test('stay bounded under real 100-connection and 200-message load, and keep camera/screen tracks separable', async ({ browser }) => {
    test.setTimeout(180000);
    const roomName = `export-at-scale-${Date.now()}`;
    const ctxA = await browser.newContext();
    const ctxB = await browser.newContext();
    const ctxC = await browser.newContext();
    const pageA = await ctxA.newPage();
    const pageB = await ctxB.newPage();
    const pageC = await ctxC.newPage();

    try {
      await gotoFixture(pageA);
      await gotoFixture(pageB);
      await gotoFixture(pageC);

      await joinOnCurrentPage(pageA, roomName, 'alice');
      await joinOnCurrentPage(pageB, roomName, 'bob');
      await joinOnCurrentPage(pageC, roomName, 'carol');

      for (const page of [pageA, pageB, pageC]) {
        await expect.poll(
          () => page.evaluate(() => window.__livekitTestHelpers.getConnectionState()),
          { timeout: ROOM_JOIN_TIMEOUT_MS, intervals: [POLL_INTERVAL_MS] }
        ).toBe('connected');
      }

      // Alice publishes both camera+mic and a screen share, so her session
      // carries two distinctly-tagged video tracks plus audio.
      await pageA.evaluate(() => window.__livekitTestHelpers.publishCamMic());
      await pageA.evaluate(() => window.__livekitTestHelpers.publishScreenShare());

      await expect.poll(
        () => pageB.evaluate(() => window.__livekitTestHelpers.getRemoteTracksByParticipant().alice),
        { timeout: TRACK_SUBSCRIBED_TIMEOUT_MS, intervals: [POLL_INTERVAL_MS] }
      ).toEqual(expect.arrayContaining([
        expect.objectContaining({ source: 'camera' }),
        expect.objectContaining({ source: 'screen_share' }),
      ]));

      // Real per-connection message load: 220 real payloads over LiveKit's
      // own reliable data channel, well past the 200-message cap.
      await pageA.evaluate(async () => {
        for (let i = 0; i < 220; i++) {
          window.__lkRoom.localParticipant.publishData(
            new TextEncoder().encode(`export-at-scale-${i}`), { reliable: true }
          );
        }
      });

      await expect.poll(
        () => pageA.evaluate(() => {
          const snap = window.__webrtcInspector.getSnapshot();
          const conn = snap.connections.find((c) => (c.localTracks || []).length > 0);
          const dc = conn && conn.dataChannels.find((d) => d.label === '_reliable');
          return dc ? dc.messageCount : -1;
        }),
        { timeout: TRACK_SUBSCRIBED_TIMEOUT_MS, intervals: [POLL_INTERVAL_MS] }
      ).toBe(200);

      // Real connection-count load: 110 real, throwaway RTCPeerConnections,
      // opened and immediately closed, alongside the one live LiveKit session
      // (which itself may be one or two real PCs depending on
      // singlePeerConnection). evictClosedConnections() only ever drops
      // closed records, so the live session's own record must survive.
      await pageA.evaluate(() => {
        for (let i = 0; i < 110; i++) {
          const pc = new RTCPeerConnection();
          pc.close();
        }
      });

      const liveConnIdBefore = await pageA.evaluate(() => {
        const snap = window.__webrtcInspector.getSnapshot();
        const conn = snap.connections.find((c) => (c.localTracks || []).length > 0);
        return conn && conn.id;
      });
      expect(liveConnIdBefore).toBeTruthy();

      // Give the 2s stats poller at least one tick before exporting, so
      // statsHistory isn't asserted on before it ever had a chance to fill.
      await expect.poll(
        () => pageA.evaluate((connId) => {
          const snap = window.__webrtcInspector.getSnapshot();
          const conn = snap.connections.find((c) => c.id === connId);
          return !!(conn && conn.latestStats);
        }, liveConnIdBefore),
        { timeout: STATS_FLOWING_TIMEOUT_MS, intervals: [POLL_INTERVAL_MS] }
      ).toBe(true);

      const bundle = await pageA.evaluate(() => window.__webrtcInspector.exportBundle());

      // The connection-count cap held: never more than maxConnectionHistory
      // (100) records, even though 110+ throwaway connections plus the real
      // session's own connection(s) were all created.
      expect(bundle.snapshot.connections.length).toBeLessThanOrEqual(100);

      // The real, live LiveKit connection specifically survived eviction —
      // it was never closed, so evictClosedConnections() cannot have touched
      // it regardless of how many closed dummy records were competing for
      // the same 100 slots.
      const liveConn = bundle.snapshot.connections.find((c) => c.id === liveConnIdBefore);
      expect(liveConn).toBeTruthy();
      expect(liveConn.closed).toBe(false);

      // Camera vs screen-share tracks stay separable in the export via the
      // extension's own sourceTag field, distinct from LiveKit's pub.source.
      const localVideoSources = await pageA.evaluate(() => window.__livekitTestHelpers.getLocalVideoSources());
      const camSource = localVideoSources.find((s) => s.source === 'camera');
      const screenSource = localVideoSources.find((s) => s.source === 'screen_share');
      expect(camSource).toBeTruthy();
      expect(screenSource).toBeTruthy();

      const camTrack = liveConn.localTracks.find((t) => t.trackId === camSource.mediaStreamTrackId);
      const screenTrack = liveConn.localTracks.find((t) => t.trackId === screenSource.mediaStreamTrackId);
      expect(camTrack).toBeTruthy();
      expect(screenTrack).toBeTruthy();
      expect(camTrack.sourceTag).toBe('real-device');
      expect(screenTrack.sourceTag).toBe('display-capture');
      expect(camTrack.sourceTag).not.toBe(screenTrack.sourceTag);

      // The message cap held in the export too, not just in a live snapshot
      // taken mid-test.
      const dcInBundle = liveConn.dataChannels.find((d) => d.label === '_reliable');
      expect(dcInBundle).toBeTruthy();
      expect(dcInBundle.messageCount).toBe(200);
      expect(dcInBundle.lastMessages.length).toBeLessThanOrEqual(10);

      // fullLog and per-connection statsHistory are both genuinely present
      // and non-trivial for the real session — not just an empty shell.
      expect(bundle.fullLog.length).toBeGreaterThan(0);
      const liveStatsEntry = bundle.statsHistory.find((s) => s.connectionId === liveConnIdBefore);
      expect(liveStatsEntry).toBeTruthy();
      expect(liveStatsEntry.stats.length).toBeGreaterThan(0);

      // exportWebrtcInternalsDump: same bounded-connection-count invariant,
      // and the real connection's entry carries a real rtcConfiguration,
      // update log and stats map, keyed by the same connection id scheme.
      const dump = await pageA.evaluate(() => window.__webrtcInspector.exportWebrtcInternalsDump());
      const pcIds = Object.keys(dump.PeerConnections);
      expect(pcIds.length).toBeLessThanOrEqual(100);
      expect(pcIds).toContain(String(liveConnIdBefore));

      const liveDumpEntry = dump.PeerConnections[String(liveConnIdBefore)];
      expect(liveDumpEntry.rtcConfiguration).toBeTruthy();
      expect(liveDumpEntry.updateLog.length).toBeGreaterThan(0);
      expect(Object.keys(liveDumpEntry.stats).length).toBeGreaterThan(0);

      // The real session kept working throughout all of this load, for every
      // participant, not just the one under test.
      for (const page of [pageA, pageB, pageC]) {
        expect(await page.evaluate(() => window.__livekitTestHelpers.getConnectionState())).toBe('connected');
      }
    } finally {
      await ctxA.close();
      await ctxB.close();
      await ctxC.close();
    }
  });
});
