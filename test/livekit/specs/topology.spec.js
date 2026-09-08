const { test, expect } = require('@playwright/test');
const { mintToken, LIVEKIT_URL } = require('../server.js');
const { ROOM_JOIN_TIMEOUT_MS, SIMULCAST_NEGOTIATED_TIMEOUT_MS, POLL_INTERVAL_MS } = require('../helpers.js');

// Real LiveKit negotiates one of two topologies (plan section 1):
//   - modern default: a single PC per client, both publishing and
//     subscribing over it (livekit-client's singlePeerConnection: true)
//   - legacy: a separate publisher PC and subscriber PC
// Assertions below never assume which PC is "the" one — they read whatever
// getSnapshot() reports and check counts/roles, not indices.

async function joinAndPublish(page, roomName, identity, opts) {
  await page.goto('/test/livekit/fixture.html');
  await page.waitForFunction(() => !!window.__livekitTestHelpers);
  const token = await mintToken(identity, roomName);
  await page.evaluate(
    ([url, tok, o]) => window.__livekitTestHelpers.join(url, tok, o),
    [LIVEKIT_URL, token, opts || {}]
  );
  await page.evaluate(() => window.__livekitTestHelpers.publishCamMic());
}

// Distinct fake-cam colors per identity, sampled remotely to verify
// getRemoteTrackStream() attributes the right inbound track to the right
// participant, not just "some" track from "some" connection.
const FAKE_CAM_COLORS = {
  alice: { color: '#ff0000', text: 'alice', rgb: [255, 0, 0] },
  bob: { color: '#00ff00', text: 'bob', rgb: [0, 255, 0] },
  carol: { color: '#0000ff', text: 'carol', rgb: [0, 0, 255] },
};

async function joinAndPublishWithFakeCam(page, roomName, identity, opts) {
  await page.goto('/test/livekit/fixture.html');
  await page.waitForFunction(() => !!window.__livekitTestHelpers);
  const cam = FAKE_CAM_COLORS[identity];
  await page.evaluate(([color, text]) => window.__webrtcInspector.setFakeCam({ color, text }), [cam.color, cam.text]);
  const token = await mintToken(identity, roomName);
  await page.evaluate(
    ([url, tok, o]) => window.__livekitTestHelpers.join(url, tok, o),
    [LIVEKIT_URL, token, opts || {}]
  );
  await page.evaluate(() => window.__livekitTestHelpers.publishCamMic());
}

test.describe('real LiveKit topology', () => {
  test('default single-PC negotiation: two participants join, publish, and negotiate simulcast', async ({ browser }) => {
    const roomName = `topology-default-${Date.now()}`;
    const ctxA = await browser.newContext();
    const ctxB = await browser.newContext();
    const pageA = await ctxA.newPage();
    const pageB = await ctxB.newPage();

    try {
      await joinAndPublish(pageA, roomName, 'alice', {});
      await joinAndPublish(pageB, roomName, 'bob', {});

      await expect.poll(
        () => pageA.evaluate(() => window.__livekitTestHelpers.getConnectionState()),
        { timeout: ROOM_JOIN_TIMEOUT_MS, intervals: [POLL_INTERVAL_MS] }
      ).toBe('connected');

      await expect.poll(
        () => pageA.evaluate(() => window.__livekitTestHelpers.assertSimulcastNegotiated().encodingCount),
        { timeout: SIMULCAST_NEGOTIATED_TIMEOUT_MS, intervals: [POLL_INTERVAL_MS] }
      ).toBeGreaterThan(1);
      const info = await pageA.evaluate(() => window.__livekitTestHelpers.assertSimulcastNegotiated());
      expect(info.encodingCount).toBeGreaterThan(1);
      if (info.sdpHasSimulcast !== null) expect(info.sdpHasSimulcast).toBe(true);

      const snapA = await pageA.evaluate(() => window.__webrtcInspector.getSnapshot());
      // Topology-agnostic: at least one PC, all reporting a healthy state.
      expect(snapA.connections.length).toBeGreaterThanOrEqual(1);
      snapA.connections.forEach((c) => expect(['connected', 'completed']).toContain(c.state.connectionState));
    } finally {
      await ctxA.close();
      await ctxB.close();
    }
  });

  test('legacy dual-PC negotiation (singlePeerConnection: false)', async ({ browser }) => {
    const roomName = `topology-legacy-${Date.now()}`;
    const ctxA = await browser.newContext();
    const ctxB = await browser.newContext();
    const pageA = await ctxA.newPage();
    const pageB = await ctxB.newPage();

    try {
      await joinAndPublish(pageA, roomName, 'alice', { singlePeerConnection: false });
      await joinAndPublish(pageB, roomName, 'bob', { singlePeerConnection: false });

      await expect.poll(
        () => pageA.evaluate(() => window.__livekitTestHelpers.getConnectionState()),
        { timeout: ROOM_JOIN_TIMEOUT_MS, intervals: [POLL_INTERVAL_MS] }
      ).toBe('connected');

      const snapA = await pageA.evaluate(() => window.__webrtcInspector.getSnapshot());
      expect(snapA.connections.length).toBeGreaterThanOrEqual(1);
      snapA.connections.forEach((c) => expect(['connected', 'completed']).toContain(c.state.connectionState));
    } finally {
      await ctxA.close();
      await ctxB.close();
    }
  });

  test('per-participant getRemoteTrackStream attribution across 3 clients with distinguishable fake-cam content', async ({ browser }) => {
    const roomName = `topology-attribution-${Date.now()}`;
    const identities = ['alice', 'bob', 'carol'];
    const ctxs = await Promise.all(identities.map(() => browser.newContext()));
    const pages = await Promise.all(ctxs.map((ctx) => ctx.newPage()));

    try {
      for (let i = 0; i < identities.length; i++) {
        await joinAndPublishWithFakeCam(pages[i], roomName, identities[i], {});
      }

      // alice (pages[0]) must see both remote participants subscribed before
      // attribution can be checked.
      await expect.poll(
        () => pages[0].evaluate(() => Object.keys(window.__livekitTestHelpers.getRemoteTracksByParticipant()).length),
        { timeout: ROOM_JOIN_TIMEOUT_MS, intervals: [POLL_INTERVAL_MS] }
      ).toBe(2);

      for (const identity of ['bob', 'carol']) {
        const remoteByParticipant = await pages[0].evaluate(() => window.__livekitTestHelpers.getRemoteTracksByParticipant());
        const videoTrack = remoteByParticipant[identity].find((t) => t.source === 'camera');
        expect(videoTrack).toBeTruthy();

        const snapA = await pages[0].evaluate(() => window.__webrtcInspector.getSnapshot());
        let found = null;
        for (const conn of snapA.connections) {
          const match = (conn.remoteTracks || []).find((rt) => rt.trackId === videoTrack.mediaStreamTrackId);
          if (match) { found = { connectionId: conn.id, trackId: match.trackId }; break; }
        }
        expect(found).toBeTruthy();

        const rgb = await pages[0].evaluate(
          ([connId, trackId]) => {
            const stream = window.__webrtcInspector.getRemoteTrackStream(connId, trackId);
            return window.__livekitTestHelpers.sampleStreamColor(stream);
          },
          [found.connectionId, found.trackId]
        );
        const expected = FAKE_CAM_COLORS[identity].rgb;
        expect(Math.abs(rgb.r - expected[0])).toBeLessThan(40);
        expect(Math.abs(rgb.g - expected[1])).toBeLessThan(40);
        expect(Math.abs(rgb.b - expected[2])).toBeLessThan(40);
      }
    } finally {
      await Promise.all(ctxs.map((ctx) => ctx.close()));
    }
  });

  test('simultaneous camera + screen-share publish: two distinct outbound video tracks, correctly tagged', async ({ browser }) => {
    const roomName = `topology-camscreen-${Date.now()}`;
    const ctxA = await browser.newContext();
    const ctxB = await browser.newContext();
    const pageA = await ctxA.newPage();
    const pageB = await ctxB.newPage();

    try {
      await joinAndPublish(pageA, roomName, 'alice', {});
      await joinAndPublish(pageB, roomName, 'bob', {});
      await pageA.evaluate(() => window.__livekitTestHelpers.publishScreenShare());

      const sources = await pageA.evaluate(() => window.__livekitTestHelpers.getLocalVideoSources());
      expect(sources.length).toBe(2);
      expect(sources.map((s) => s.source).sort()).toEqual(['camera', 'screen_share']);
    } finally {
      await ctxA.close();
      await ctxB.close();
    }
  });
});
