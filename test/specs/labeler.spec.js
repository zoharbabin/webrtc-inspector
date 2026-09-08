const { test, expect } = require('@playwright/test');
const { gotoFixture } = require('../helpers');

// setLabeler() lets a consumer map URL/hostname patterns (TURN/STUN server
// for connections, signaling server for WebSockets) to a friendly name in
// getSnapshot() output, without this tool knowing any vendor specifics.

test.describe('setLabeler()', () => {
  test('labels a connection from its ICE server URLs', async ({ page }) => {
    await gotoFixture(page);
    const connectionIdA = await page.evaluate(() => {
      window.__webrtcInspector.setLabeler((meta) => {
        if (meta.kind === 'connection' && meta.urls.some((u) => u.includes('acme-turn'))) return 'Acme prod';
        return null;
      });
      let id;
      const unsubscribe = window.__webrtcInspector.onEvent((entry) => { if (entry.type === 'pc-created') id = entry.connectionId; });
      window.__pcA = new RTCPeerConnection({ iceServers: [{ urls: 'turn:acme-turn.example.com:3478', username: 'u', credential: 'p' }] });
      unsubscribe();
      return id;
    });
    const snap = await page.evaluate(() => window.__webrtcInspector.getSnapshot());
    const recA = snap.connections.find((c) => c.id === connectionIdA);
    expect(recA.label).toBe('Acme prod');
    expect(snap.labelerActive).toBe(true);
  });

  test('leaves label null for a connection the labeler does not recognize', async ({ page }) => {
    await gotoFixture(page);
    const connectionIdA = await page.evaluate(async () => {
      window.__webrtcInspector.setLabeler((meta) => (meta.kind === 'connection' && meta.urls.includes('turn:known.example.com') ? 'known' : null));
      const { connectionIdA: id } = await window.testHelpers.createLoopbackSession();
      return id;
    });
    const snap = await page.evaluate(() => window.__webrtcInspector.getSnapshot());
    const recA = snap.connections.find((c) => c.id === connectionIdA);
    expect(recA.label).toBeNull();
  });

  test('labels a WebSocket from its URL', async ({ page }) => {
    await gotoFixture(page);
    const wsId = await page.evaluate(async () => {
      window.__webrtcInspector.setLabeler((meta) => (meta.kind === 'websocket' && meta.url.includes('signaling.acme') ? 'Acme signaling' : null));
      window.__ws = new WebSocket('wss://signaling.acme.example.com/rooms/1');
      await window.testHelpers.wait(30);
      return window.__webrtcInspector.getSnapshot().webSockets[0].id;
    });
    const snap = await page.evaluate(() => window.__webrtcInspector.getSnapshot());
    const ws = snap.webSockets.find((s) => s.id === wsId);
    expect(ws.label).toBe('Acme signaling');
  });

  test('does not break the snapshot when the labeler throws', async ({ page }) => {
    await gotoFixture(page);
    const connectionIdA = await page.evaluate(async () => {
      window.__webrtcInspector.setLabeler(() => { throw new Error('boom'); });
      const { connectionIdA: id } = await window.testHelpers.createLoopbackSession();
      return id;
    });
    const snap = await page.evaluate(() => window.__webrtcInspector.getSnapshot());
    const recA = snap.connections.find((c) => c.id === connectionIdA);
    expect(recA.label).toBeNull();
  });

  test('clearLabeler stops labeling and is reflected in the snapshot', async ({ page }) => {
    await gotoFixture(page);
    const connectionIdA = await page.evaluate(async () => {
      window.__webrtcInspector.setLabeler(() => 'stale');
      window.__webrtcInspector.clearLabeler();
      const { connectionIdA: id } = await window.testHelpers.createLoopbackSession();
      return id;
    });
    const snap = await page.evaluate(() => window.__webrtcInspector.getSnapshot());
    const recA = snap.connections.find((c) => c.id === connectionIdA);
    expect(recA.label).toBeNull();
    expect(snap.labelerActive).toBe(false);
  });

  // Real discrepancy found while validating against a real LiveKit session
  // (~/Downloads/webrtc-inspector-livekit-e2e-plan.md section 8): LiveKit
  // fetches its TURN server list from its own signaling and applies it to
  // the already-constructed publisher PC via pc.setConfiguration(), never at
  // the RTCPeerConnection constructor. record.configuration used to stay
  // frozen at whatever was passed to the constructor forever, so a
  // connection's real, current ICE servers were invisible to setLabeler's
  // URL matching. No SFU is needed to reproduce this — any app that calls
  // setConfiguration() after construction hits the same gap — so it's
  // reproduced here as a plain loopback case, distilled from the real
  // LiveKit finding in test/livekit/specs/codec-negotiation.spec.js.
  test('setConfiguration() after construction is picked up by the labeler, not just the constructor-time config', async ({ page }) => {
    await gotoFixture(page);
    const connectionId = await page.evaluate(() => {
      window.__webrtcInspector.setLabeler((meta) => {
        if (meta.kind === 'connection' && meta.urls.some((u) => u.includes('acme-turn'))) return 'Acme prod';
        return null;
      });
      let id;
      const unsubscribe = window.__webrtcInspector.onEvent((entry) => { if (entry.type === 'pc-created') id = entry.connectionId; });
      window.__pcLate = new RTCPeerConnection();
      unsubscribe();
      return id;
    });

    // Before setConfiguration(), the labeler has nothing to match.
    const before = await page.evaluate(() => window.__webrtcInspector.getSnapshot());
    expect(before.connections.find((c) => c.id === connectionId).label).toBeNull();

    await page.evaluate(() => {
      window.__pcLate.setConfiguration({ iceServers: [{ urls: 'turn:acme-turn.example.com:3478', username: 'u', credential: 'p' }] });
    });

    const after = await page.evaluate(() => window.__webrtcInspector.getSnapshot());
    expect(after.connections.find((c) => c.id === connectionId).label).toBe('Acme prod');

    const dump = await page.evaluate(() => window.__webrtcInspector.exportWebrtcInternalsDump());
    const dumpUrls = dump.PeerConnections[String(connectionId)].rtcConfiguration.iceServers[0].urls;
    expect([].concat(dumpUrls)).toContain('turn:acme-turn.example.com:3478');
  });

  test('getSnapshotDiff reports a label change', async ({ page }) => {
    await gotoFixture(page);
    const { before, connectionIdA } = await page.evaluate(async () => {
      const { connectionIdA: id } = await window.testHelpers.createLoopbackSession();
      const before = window.__webrtcInspector.getSnapshot();
      return { before, connectionIdA: id };
    });
    await page.evaluate(() => {
      window.__webrtcInspector.setLabeler(() => 'now labeled');
    });
    const after = await page.evaluate(() => window.__webrtcInspector.getSnapshot());
    const diff = await page.evaluate(([b, a]) => window.__webrtcInspector.getSnapshotDiff(b, a), [before, after]);
    const connDiff = diff.connections.find((c) => c.id === connectionIdA);
    expect(connDiff.label).toEqual({ from: null, to: 'now labeled' });
  });
});
