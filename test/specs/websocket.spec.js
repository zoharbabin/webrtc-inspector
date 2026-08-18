const { test, expect } = require('@playwright/test');
const { gotoFixture } = require('../helpers');

// window.WebSocket is patched to MockWebSocket by the base fixture (see
// test/fixtures/base.html) — no real network involved.

test.describe('WebSocket instrumentation', () => {
  test.beforeEach(async ({ page }) => {
    await gotoFixture(page);
    await page.evaluate(async () => {
      window.__ws = new WebSocket('wss://mock.test/app-message', 'proto-x');
      await window.testHelpers.wait(30); // let MockWebSocket's simulated open fire
      window.__wsMessages = [];
      window.__ws.addEventListener('message', (e) => window.__wsMessages.push(e.data));
    });
  });

  test('tracks a socket on creation with its URL', async ({ page }) => {
    const snap = await page.evaluate(() => window.__webrtcInspector.getSnapshot());
    expect(snap.webSockets.some((s) => s.url === 'wss://mock.test/app-message')).toBe(true);
  });

  test('reflects open state after connecting', async ({ page }) => {
    const snap = await page.evaluate(() => window.__webrtcInspector.getSnapshot());
    const record = snap.webSockets.find((s) => s.url === 'wss://mock.test/app-message');
    expect(record.state).toBe('open');
  });

  test('outgoing send() reaches the underlying socket and is counted', async ({ page }) => {
    await page.evaluate(() => window.__ws.send('plain-out'));
    const sent = await page.evaluate(() => window.__ws.sent);
    expect(sent).toContain('plain-out');
    const snap = await page.evaluate(() => window.__webrtcInspector.getSnapshot());
    const record = snap.webSockets.find((s) => s.url === 'wss://mock.test/app-message');
    expect(record.sentCount).toBe(1);
  });

  test('injectWebSocketMessage delivers a synthetic incoming message', async ({ page }) => {
    const wsId = await page.evaluate(() => window.__webrtcInspector.getSnapshot().webSockets[0].id);
    await page.evaluate((id) => window.__webrtcInspector.injectWebSocketMessage(id, 'synthetic-in'), wsId);
    await page.waitForFunction(() => window.__wsMessages.length >= 1);
    expect(await page.evaluate(() => window.__wsMessages[0])).toBe('synthetic-in');
    const snap = await page.evaluate(() => window.__webrtcInspector.getSnapshot());
    expect(snap.webSockets.find((s) => s.id === wsId).receivedCount).toBe(1);
  });

  test('interceptor rewrites outgoing and incoming messages in flight', async ({ page }) => {
    const wsId = await page.evaluate(() => window.__webrtcInspector.getSnapshot().webSockets[0].id);
    await page.evaluate(() => {
      window.__webrtcInspector.setWebSocketInterceptor((dir, ctx) => {
        if (dir === 'out' && ctx.data === 'rewrite-out') return ctx.data.toUpperCase();
        if (dir === 'in' && ctx.data === 'rewrite-in') return ctx.data.toUpperCase();
        return undefined;
      });
    });
    expect(await page.evaluate(() => window.__webrtcInspector.getSnapshot().webSocketInterceptorActive)).toBe(true);

    await page.evaluate(() => window.__ws.send('rewrite-out'));
    expect(await page.evaluate(() => window.__ws.sent[window.__ws.sent.length - 1])).toBe('REWRITE-OUT');

    await page.evaluate((id) => window.__webrtcInspector.injectWebSocketMessage(id, 'rewrite-in'), wsId);
    await page.waitForFunction(() => window.__wsMessages.length >= 1);
    expect(await page.evaluate(() => window.__wsMessages[0])).toBe('REWRITE-IN');
  });

  test('interceptor blocks outgoing and incoming messages in flight', async ({ page }) => {
    const wsId = await page.evaluate(() => window.__webrtcInspector.getSnapshot().webSockets[0].id);
    await page.evaluate(() => {
      window.__webrtcInspector.setWebSocketInterceptor((dir, ctx) => (ctx.data === 'block-me' ? false : undefined));
    });

    const sentCountBefore = await page.evaluate(() => window.__ws.sent.length);
    await page.evaluate(() => window.__ws.send('block-me'));
    expect(await page.evaluate(() => window.__ws.sent.length)).toBe(sentCountBefore);

    const receivedCountBefore = await page.evaluate(() => window.__wsMessages.length);
    await page.evaluate((id) => window.__webrtcInspector.injectWebSocketMessage(id, 'block-me'), wsId);
    await page.evaluate(() => window.testHelpers.wait(50));
    expect(await page.evaluate(() => window.__wsMessages.length)).toBe(receivedCountBefore);
  });

  test('clearWebSocketInterceptor is reflected in the snapshot', async ({ page }) => {
    await page.evaluate(() => {
      window.__webrtcInspector.setWebSocketInterceptor(() => false);
      window.__webrtcInspector.clearWebSocketInterceptor();
    });
    expect(await page.evaluate(() => window.__webrtcInspector.getSnapshot().webSocketInterceptorActive)).toBe(false);
  });
});
