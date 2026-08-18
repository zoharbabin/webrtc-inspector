const { test, expect } = require('@playwright/test');
const { gotoFixture } = require('../helpers');

// setIceCandidateFilter(connId, fn) drops candidates by type before they
// reach addIceCandidate (incoming) or the page's own onicecandidate handler
// (outgoing) — e.g. to force a direct-only or TURN-only path in tests. In
// headless Chromium's pure-loopback fixture every real gathered candidate is
// type 'host' (no STUN/TURN configured), so filtering on 'host' is the
// deterministic way to exercise "all candidates dropped" here.

test.describe('setIceCandidateFilter()', () => {
  test('drops incoming candidates before they reach addIceCandidate', async ({ page }) => {
    await gotoFixture(page);
    const result = await page.evaluate(async () => {
      const ids = [];
      const unsubscribe = window.__webrtcInspector.onEvent((entry) => { if (entry.type === 'pc-created') ids.push(entry.connectionId); });
      const pcA = new RTCPeerConnection({ iceServers: [] });
      const pcB = new RTCPeerConnection({ iceServers: [] });
      unsubscribe();
      const [, connectionIdB] = ids;
      window.__webrtcInspector.setIceCandidateFilter(connectionIdB, (type) => type !== 'host');
      pcA.onicecandidate = (e) => { if (e.candidate) pcB.addIceCandidate(e.candidate); };
      pcB.onicecandidate = (e) => { if (e.candidate) pcA.addIceCandidate(e.candidate); };
      pcA.createDataChannel('x');
      const offer = await pcA.createOffer();
      await pcA.setLocalDescription(offer);
      await pcB.setRemoteDescription(offer);
      const answer = await pcB.createAnswer();
      await pcB.setLocalDescription(answer);
      await pcA.setRemoteDescription(answer);
      await window.testHelpers.wait(1500);
      const recB = window.__webrtcInspector.getSnapshot().connections.find((c) => c.id === connectionIdB);
      return { remoteCandidateTypes: recB.remoteCandidateTypes, iceConnectionState: pcB.iceConnectionState };
    });
    expect(result.remoteCandidateTypes).toEqual([]);
    expect(['new', 'checking']).toContain(result.iceConnectionState);
  });

  test("drops outgoing candidates before they reach the app's onicecandidate handler", async ({ page }) => {
    await gotoFixture(page);
    const result = await page.evaluate(async () => {
      const ids = [];
      const unsubscribe = window.__webrtcInspector.onEvent((entry) => { if (entry.type === 'pc-created') ids.push(entry.connectionId); });
      const pcA = new RTCPeerConnection({ iceServers: [] });
      unsubscribe();
      const connectionIdA = ids[0];
      window.__webrtcInspector.setIceCandidateFilter(connectionIdA, (type) => type !== 'host');
      let seenByApp = 0;
      pcA.onicecandidate = (e) => { if (e.candidate) seenByApp++; };
      pcA.createDataChannel('x');
      const offer = await pcA.createOffer();
      await pcA.setLocalDescription(offer);
      await window.testHelpers.wait(1000);
      const recA = window.__webrtcInspector.getSnapshot().connections.find((c) => c.id === connectionIdA);
      return { seenByApp, localCandidateTypes: recA.localCandidateTypes };
    });
    expect(result.seenByApp).toBe(0);
    expect(result.localCandidateTypes).toEqual([]);
  });

  test('a filter predicate returning true lets candidates through normally', async ({ page }) => {
    await gotoFixture(page);
    const connectionIdA = await page.evaluate(async () => {
      const ids = [];
      const unsubscribe = window.__webrtcInspector.onEvent((entry) => { if (entry.type === 'pc-created') ids.push(entry.connectionId); });
      const { connectionIdA: id } = await window.testHelpers.createLoopbackSession('test-channel', () => {
        unsubscribe();
        window.__webrtcInspector.setIceCandidateFilter(ids[0], () => true);
      });
      return id;
    });
    const snap = await page.evaluate(() => window.__webrtcInspector.getSnapshot());
    const recA = snap.connections.find((c) => c.id === connectionIdA);
    expect(recA.localCandidateTypes.length).toBeGreaterThan(0);
  });

  test('a throwing filter predicate does not drop the candidate', async ({ page }) => {
    await gotoFixture(page);
    const connectionIdA = await page.evaluate(async () => {
      const ids = [];
      const unsubscribe = window.__webrtcInspector.onEvent((entry) => { if (entry.type === 'pc-created') ids.push(entry.connectionId); });
      const { connectionIdA: id } = await window.testHelpers.createLoopbackSession('test-channel', () => {
        unsubscribe();
        window.__webrtcInspector.setIceCandidateFilter(ids[0], () => { throw new Error('boom'); });
      });
      return id;
    });
    const snap = await page.evaluate(() => window.__webrtcInspector.getSnapshot());
    const recA = snap.connections.find((c) => c.id === connectionIdA);
    expect(recA.localCandidateTypes.length).toBeGreaterThan(0);
  });

  test('clearIceCandidateFilter stops dropping and is reflected in the snapshot', async ({ page }) => {
    await gotoFixture(page);
    const connectionIdA = await page.evaluate(async () => {
      const ids = [];
      const unsubscribe = window.__webrtcInspector.onEvent((entry) => { if (entry.type === 'pc-created') ids.push(entry.connectionId); });
      const { connectionIdA: id } = await window.testHelpers.createLoopbackSession('test-channel', () => {
        unsubscribe();
        window.__webrtcInspector.setIceCandidateFilter(ids[0], () => false);
        window.__webrtcInspector.clearIceCandidateFilter(ids[0]);
      });
      return id;
    });
    const snap = await page.evaluate(() => window.__webrtcInspector.getSnapshot());
    expect(snap.iceCandidateFilterActive).toBe(false);
    const recA = snap.connections.find((c) => c.id === connectionIdA);
    expect(recA.localCandidateTypes.length).toBeGreaterThan(0);
  });

  test('filter is scoped per connectionId — an unfiltered connection is unaffected', async ({ page }) => {
    await gotoFixture(page);
    const { filteredActive, otherConnected } = await page.evaluate(async () => {
      const ids = [];
      const unsubscribe = window.__webrtcInspector.onEvent((entry) => { if (entry.type === 'pc-created') ids.push(entry.connectionId); });
      const pcA = new RTCPeerConnection({ iceServers: [] });
      const pcB = new RTCPeerConnection({ iceServers: [] });
      unsubscribe();
      const [, connectionIdB] = ids;
      window.__webrtcInspector.setIceCandidateFilter(connectionIdB, () => false);
      const filteredActive = window.__webrtcInspector.getSnapshot().iceCandidateFilterActive;

      pcA.close();
      pcB.close();
      const { connectionIdA: idA2 } = await window.testHelpers.createLoopbackSession('other-channel');
      const recA2 = window.__webrtcInspector.getSnapshot().connections.find((c) => c.id === idA2);
      return { filteredActive, otherConnected: recA2.localCandidateTypes.length > 0 };
    });
    expect(filteredActive).toBe(true);
    expect(otherConnected).toBe(true);
  });
});
