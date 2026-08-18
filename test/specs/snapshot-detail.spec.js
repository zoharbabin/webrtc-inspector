const { test, expect } = require('@playwright/test');
const { gotoFixture } = require('../helpers');

test.describe('getSnapshot() detail modes', () => {
  test.beforeEach(async ({ page }) => {
    await gotoFixture(page);
    await page.evaluate(() => window.testHelpers.createLoopbackSession());
    await page.evaluate(() => {
      window.__dcA.send('hello');
      window.__pcA.getStats = async () => new Map([
        ['pair1', { id: 'pair1', type: 'candidate-pair', nominated: true, state: 'succeeded', currentRoundTripTime: 0.01 }],
      ]);
    });
    await page.waitForFunction(() => window.__webrtcInspector.getSnapshot().connections[0].dataChannels[0].messageCount > 0);
  });

  test('defaults to detailed output with no opts', async ({ page }) => {
    const snap = await page.evaluate(() => window.__webrtcInspector.getSnapshot());
    const conn = snap.connections[0];
    expect(snap.recentLog).toBeDefined();
    expect(conn.latestStats).toBeDefined();
    expect(conn.dataChannels[0].lastMessages).toHaveLength(1);
    expect(conn.dataChannels[0].lastMessages[0].preview).toBe('hello');
  });

  test("detail: 'detailed' matches the no-opts default", async ({ page }) => {
    const snap = await page.evaluate(() => window.__webrtcInspector.getSnapshot({ detail: 'detailed' }));
    const conn = snap.connections[0];
    expect(snap.recentLog).toBeDefined();
    expect(conn.latestStats).toBeDefined();
    expect(conn.dataChannels[0].lastMessages).toHaveLength(1);
    expect(conn.dataChannels[0].lastMessages[0].preview).toBe('hello');
  });

  test("detail: 'concise' drops raw stats/log/message dumps but keeps derived fields", async ({ page }) => {
    const snap = await page.evaluate(() => window.__webrtcInspector.getSnapshot({ detail: 'concise' }));
    const conn = snap.connections[0];

    expect(snap.recentLog).toBeUndefined();
    expect(conn.latestStats).toBeUndefined();
    expect(conn.dataChannels[0].lastMessages).toBeUndefined();

    expect(conn.dataChannels[0].messageCount).toBe(1);
    expect(conn.state).toBeDefined();
    expect(conn.selectedCandidateType).toBeDefined();
    expect(snap.fakeMicActive).toBe(false);
  });
});
