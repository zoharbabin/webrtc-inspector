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
