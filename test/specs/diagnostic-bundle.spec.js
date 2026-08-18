const { test, expect } = require('@playwright/test');
const { gotoFixture } = require('../helpers');

test.describe('exportBundle()', () => {
  test.beforeEach(async ({ page }) => {
    await gotoFixture(page);
  });

  test('returns a JSON-serializable bundle with exportedAt, version, and a detailed snapshot', async ({ page }) => {
    const bundle = await page.evaluate(async () => {
      await window.testHelpers.createLoopbackSession();
      return JSON.parse(JSON.stringify(window.__webrtcInspector.exportBundle()));
    });
    expect(typeof bundle.exportedAt).toBe('number');
    expect(bundle.version).toBe('1.4.0');
    expect(Array.isArray(bundle.snapshot.connections)).toBe(true);
    expect(bundle.snapshot.connections.length).toBe(2);
    expect(Array.isArray(bundle.fullLog)).toBe(true);
    expect(Array.isArray(bundle.statsHistory)).toBe(true);
  });

  test('fullLog is not capped at the 100 entries getSnapshot() keeps in recentLog', async ({ page }) => {
    const result = await page.evaluate(async () => {
      await window.testHelpers.createLoopbackSession();
      for (let i = 0; i < 150; i++) window.__dcA.send(`msg-${i}`);
      await window.testHelpers.waitFor(() => window.__webrtcInspector.getSnapshot().recentLog.length >= 100);
      const snap = window.__webrtcInspector.getSnapshot();
      const bundle = window.__webrtcInspector.exportBundle();
      return { recentLogLength: snap.recentLog.length, fullLogLength: bundle.fullLog.length };
    });
    expect(result.recentLogLength).toBe(100);
    expect(result.fullLogLength).toBeGreaterThan(100);
  });

  test('statsHistory has one entry per connection with its full stats sample history', async ({ page }) => {
    const result = await page.evaluate(async () => {
      const { connectionIdA, connectionIdB } = await window.testHelpers.createLoopbackSession();
      await window.testHelpers.wait(2100);
      const bundle = window.__webrtcInspector.exportBundle();
      return { statsHistory: bundle.statsHistory, connectionIdA, connectionIdB };
    });
    const ids = result.statsHistory.map((s) => s.connectionId).sort();
    expect(ids).toEqual([result.connectionIdA, result.connectionIdB].sort((a, b) => a - b));
    result.statsHistory.forEach((entry) => {
      expect(entry.stats.length).toBeGreaterThan(0);
    });
  });

  test('exportBundle() does not mutate live state — the log keeps growing after export', async ({ page }) => {
    const result = await page.evaluate(async () => {
      await window.testHelpers.createLoopbackSession();
      const before = window.__webrtcInspector.exportBundle().fullLog.length;
      window.__dcA.send('after-export');
      await window.testHelpers.wait(100);
      const after = window.__webrtcInspector.exportBundle().fullLog.length;
      return { before, after };
    });
    expect(result.after).toBeGreaterThan(result.before);
  });
});
