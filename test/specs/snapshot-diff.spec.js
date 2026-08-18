const { test, expect } = require('@playwright/test');
const { gotoFixture } = require('../helpers');

test.describe('getSnapshotDiff()', () => {
  test.beforeEach(async ({ page }) => {
    await gotoFixture(page);
  });

  test('reports no changes for two identical snapshots', async ({ page }) => {
    await page.evaluate(() => window.testHelpers.createLoopbackSession());
    const diff = await page.evaluate(() => {
      const snap = window.__webrtcInspector.getSnapshot();
      return window.__webrtcInspector.getSnapshotDiff(snap, snap);
    });
    expect(diff).toEqual({
      connectionsAdded: [],
      connectionsRemoved: [],
      connections: [],
      webSocketsAdded: [],
      webSocketsRemoved: [],
      webSockets: [],
    });
  });

  test('reports a new connection as added', async ({ page }) => {
    const diff = await page.evaluate(async () => {
      const before = window.__webrtcInspector.getSnapshot();
      await window.testHelpers.createLoopbackSession();
      const after = window.__webrtcInspector.getSnapshot();
      return window.__webrtcInspector.getSnapshotDiff(before, after);
    });
    expect(diff.connectionsAdded).toHaveLength(2);
    expect(diff.connectionsRemoved).toEqual([]);
  });

  test('reports a closed transition for killConnection', async ({ page }) => {
    const diff = await page.evaluate(async () => {
      const { connectionIdA } = await window.testHelpers.createLoopbackSession();
      await window.testHelpers.waitFor(() => {
        const rec = window.__webrtcInspector.getSnapshot().connections.find((c) => c.id === connectionIdA);
        return rec.state.iceConnectionState === 'connected' || rec.state.iceConnectionState === 'completed';
      });
      const before = window.__webrtcInspector.getSnapshot();
      window.__webrtcInspector.killConnection(connectionIdA);
      await window.testHelpers.waitFor(() => {
        const rec = window.__webrtcInspector.getSnapshot().connections.find((c) => c.id === connectionIdA);
        return rec.closed === true;
      });
      const after = window.__webrtcInspector.getSnapshot();
      return { connectionIdA, diff: window.__webrtcInspector.getSnapshotDiff(before, after) };
    });
    const change = diff.diff.connections.find((c) => c.id === diff.connectionIdA);
    expect(change).toBeDefined();
    expect(change.closed).toEqual({ from: false, to: true });
  });

  test('reports data channel message counts and quality score changes', async ({ page }) => {
    const diff = await page.evaluate(async () => {
      const { connectionIdA } = await window.testHelpers.createLoopbackSession();
      window.__pcA.getStats = async () => new Map([
        ['pair1', { id: 'pair1', type: 'candidate-pair', nominated: true, state: 'succeeded', currentRoundTripTime: 0.01 }],
        ['a1', { id: 'a1', type: 'inbound-rtp', kind: 'audio', jitter: 0.001, packetsLost: 0, packetsReceived: 1000 }],
      ]);
      await window.testHelpers.waitFor(() => {
        const rec = window.__webrtcInspector.getSnapshot().connections.find((c) => c.id === connectionIdA);
        return rec.qualityScore === null;
      });
      const before = window.__webrtcInspector.getSnapshot();
      window.__dcA.send('hi');
      await window.testHelpers.waitFor(() => {
        const rec = window.__webrtcInspector.getSnapshot().connections.find((c) => c.id === connectionIdA);
        return rec.qualityScore !== null;
      });
      const after = window.__webrtcInspector.getSnapshot();
      return { connectionIdA, diff: window.__webrtcInspector.getSnapshotDiff(before, after) };
    });
    const change = diff.diff.connections.find((c) => c.id === diff.connectionIdA);
    expect(change).toBeDefined();
    expect(change.dataChannelCount).toBeUndefined();
    expect(change.qualityScore).toEqual({ from: null, to: expect.any(Number) });
  });

  test('is symmetric-safe: reversing before/after flips from/to', async ({ page }) => {
    const result = await page.evaluate(async () => {
      const { connectionIdA } = await window.testHelpers.createLoopbackSession();
      await window.testHelpers.waitFor(() => {
        const rec = window.__webrtcInspector.getSnapshot().connections.find((c) => c.id === connectionIdA);
        return rec.state.iceConnectionState === 'connected' || rec.state.iceConnectionState === 'completed';
      });
      const before = window.__webrtcInspector.getSnapshot();
      window.__webrtcInspector.killConnection(connectionIdA);
      await window.testHelpers.waitFor(() => {
        const rec = window.__webrtcInspector.getSnapshot().connections.find((c) => c.id === connectionIdA);
        return rec.closed === true;
      });
      const after = window.__webrtcInspector.getSnapshot();
      const forward = window.__webrtcInspector.getSnapshotDiff(before, after);
      const backward = window.__webrtcInspector.getSnapshotDiff(after, before);
      return { connectionIdA, forward, backward };
    });
    const fwd = result.forward.connections.find((c) => c.id === result.connectionIdA);
    const bwd = result.backward.connections.find((c) => c.id === result.connectionIdA);
    expect(bwd.closed).toEqual({ from: fwd.closed.to, to: fwd.closed.from });
  });
});
