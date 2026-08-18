const { test, expect } = require('@playwright/test');
const { gotoFixture } = require('../helpers');

// Every case negotiates its own loopback session and wires message listeners
// via evaluate(), since RTCDataChannel/MessageEvent instances can't cross the
// Node/browser boundary — page-side arrays collect delivered payloads instead.

test.describe('RTCDataChannel instrumentation', () => {
  test.beforeEach(async ({ page }) => {
    await gotoFixture(page);
    await page.evaluate(async () => {
      await window.testHelpers.createLoopbackSession();
      window.__dcAMessages = [];
      window.__dcBMessages = [];
      window.__dcA.addEventListener('message', (e) => window.__dcAMessages.push(e.data));
      window.__dcB.addEventListener('message', (e) => window.__dcBMessages.push(e.data));
    });
  });

  test('delivers a message end to end', async ({ page }) => {
    await page.evaluate(() => window.__dcA.send('hello from A'));
    await page.waitForFunction(() => window.__dcBMessages.length >= 1);
    expect(await page.evaluate(() => window.__dcBMessages[0])).toBe('hello from A');
  });

  test('records the outbound message on the sending connection', async ({ page }) => {
    await page.evaluate(() => window.__dcA.send('hello from A'));
    await page.waitForFunction(() => window.__dcBMessages.length >= 1);
    const snap = await page.evaluate(() => window.__webrtcInspector.getSnapshot());
    const recA = snap.connections[0];
    expect(recA.dataChannels[0].messageCount).toBeGreaterThanOrEqual(1);
  });

  test('injectDataChannelMessage sends from the target connection to its peer', async ({ page }) => {
    // Connection 2 is B — this sends from B's channel, so it must arrive at A.
    await page.evaluate(() => window.__webrtcInspector.injectDataChannelMessage(2, 'test-channel', 'injected via inspector API'));
    await page.waitForFunction(() => window.__dcAMessages.length >= 1);
    expect(await page.evaluate(() => window.__dcAMessages[0])).toBe('injected via inspector API');
  });

  test('records a remote data channel on the receiving connection', async ({ page }) => {
    const snap = await page.evaluate(() => window.__webrtcInspector.getSnapshot());
    const recB = snap.connections[1];
    expect(recB.dataChannels.some((d) => d.origin === 'remote' && d.label === 'test-channel')).toBe(true);
  });

  test('interceptor rewrites an outgoing message in flight', async ({ page }) => {
    await page.evaluate(() => {
      window.__webrtcInspector.setDataChannelInterceptor((dir, ctx) =>
        dir === 'out' && ctx.label === 'test-channel' && ctx.data === 'rewrite me' ? ctx.data.toUpperCase() : undefined
      );
      window.__dcA.send('rewrite me');
    });
    await page.waitForFunction(() => window.__dcBMessages.length >= 1);
    expect(await page.evaluate(() => window.__dcBMessages[0])).toBe('REWRITE ME');
  });

  test('interceptor blocks an outgoing message in flight', async ({ page }) => {
    await page.evaluate(() => {
      window.__webrtcInspector.setDataChannelInterceptor((dir, ctx) => (dir === 'out' && ctx.data === 'block-this' ? false : undefined));
      window.__dcA.send('block-this');
    });
    await page.evaluate(() => window.testHelpers.wait(300));
    expect(await page.evaluate(() => window.__dcBMessages.length)).toBe(0);
  });

  test('clearDataChannelInterceptor stops rewriting/blocking', async ({ page }) => {
    await page.evaluate(() => {
      window.__webrtcInspector.setDataChannelInterceptor(() => false);
      window.__webrtcInspector.clearDataChannelInterceptor();
      window.__dcA.send('passes through');
    });
    await page.waitForFunction(() => window.__dcBMessages.length >= 1);
    expect(await page.evaluate(() => window.__dcBMessages[0])).toBe('passes through');
  });
});
