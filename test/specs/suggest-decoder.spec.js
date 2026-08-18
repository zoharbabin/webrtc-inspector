const { test, expect } = require('@playwright/test');
const { gotoFixture } = require('../helpers');

// setSuggestDecoder() is the advisory layer on top of registerDecoder()'s
// no-match path (see #27) — never a real decode, always tagged advisory:true
// under a `suggested` field distinct from `decoded`/`decodeError`.

test.describe('setSuggestDecoder()', () => {
  test('suggests a best-guess label when no decoder matches', async ({ page }) => {
    await gotoFixture(page);
    const connectionIdA = await page.evaluate(async () => {
      const { connectionIdA } = await window.testHelpers.createLoopbackSession();
      window.__webrtcInspector.setSuggestDecoder((data) => ({ guess: `looks like: ${data}` }));
      window.__dcA.send('unrecognized-payload');
      return connectionIdA;
    });
    await page.waitForFunction(
      (id) => {
        const conn = window.__webrtcInspector.getSnapshot().connections.find((c) => c.id === id);
        const dc = conn.dataChannels[0];
        return dc.lastMessages[dc.lastMessages.length - 1].suggested !== undefined;
      },
      connectionIdA,
      { timeout: 2000 }
    );
    const snap = await page.evaluate(() => window.__webrtcInspector.getSnapshot());
    const dc = snap.connections.find((c) => c.id === connectionIdA).dataChannels[0];
    const msg = dc.lastMessages[dc.lastMessages.length - 1];
    expect(msg.suggested).toEqual({ guess: 'looks like: unrecognized-payload' });
    expect(msg.advisory).toBe(true);
    expect(msg.decoded).toBeUndefined();
    expect(snap.suggestDecoderActive).toBe(true);
  });

  test('does not run when a registered decoder already matches', async ({ page }) => {
    await gotoFixture(page);
    const connectionIdA = await page.evaluate(async () => {
      const { connectionIdA } = await window.testHelpers.createLoopbackSession();
      let suggestCalls = 0;
      window.__webrtcInspector.setSuggestDecoder(() => { suggestCalls++; return { guess: 'x' }; });
      window.__webrtcInspector.registerDecoder(() => true, (data) => ({ parsed: data }));
      window.__dcA.send('recognized-payload');
      window.__suggestCalls = () => suggestCalls;
      return connectionIdA;
    });
    await page.waitForFunction(
      (id) => {
        const conn = window.__webrtcInspector.getSnapshot().connections.find((c) => c.id === id);
        const dc = conn.dataChannels[0];
        return dc.lastMessages[dc.lastMessages.length - 1].decoded !== undefined;
      },
      connectionIdA,
      { timeout: 2000 }
    );
    const snap = await page.evaluate(() => window.__webrtcInspector.getSnapshot());
    const dc = snap.connections.find((c) => c.id === connectionIdA).dataChannels[0];
    const msg = dc.lastMessages[dc.lastMessages.length - 1];
    expect(msg.decoded).toEqual({ parsed: 'recognized-payload' });
    expect(msg.suggested).toBeUndefined();
    const suggestCalls = await page.evaluate(() => window.__suggestCalls());
    expect(suggestCalls).toBe(0);
  });

  test('records suggestionError without breaking message delivery when the hook throws', async ({ page }) => {
    await gotoFixture(page);
    const connectionIdA = await page.evaluate(async () => {
      const { connectionIdA } = await window.testHelpers.createLoopbackSession();
      window.__webrtcInspector.setSuggestDecoder(() => { throw new Error('llm unavailable'); });
      window.__dcA.send('payload');
      return connectionIdA;
    });
    await page.waitForFunction(
      (id) => {
        const conn = window.__webrtcInspector.getSnapshot().connections.find((c) => c.id === id);
        const dc = conn.dataChannels[0];
        return dc.lastMessages[dc.lastMessages.length - 1].suggestionError !== undefined;
      },
      connectionIdA,
      { timeout: 2000 }
    );
    const snap = await page.evaluate(() => window.__webrtcInspector.getSnapshot());
    const dc = snap.connections.find((c) => c.id === connectionIdA).dataChannels[0];
    const msg = dc.lastMessages[dc.lastMessages.length - 1];
    expect(msg.suggestionError).toContain('llm unavailable');
    expect(msg.advisory).toBe(true);
    expect(msg.preview).toBe('payload');
  });

  test('an async suggestDecoder resolves and patches the message record', async ({ page }) => {
    await gotoFixture(page);
    const connectionIdA = await page.evaluate(async () => {
      const { connectionIdA } = await window.testHelpers.createLoopbackSession();
      window.__webrtcInspector.setSuggestDecoder(async (data) => {
        await window.testHelpers.wait(20);
        return { guess: data };
      });
      window.__dcA.send('async-payload');
      return connectionIdA;
    });
    await page.waitForFunction(
      (id) => {
        const conn = window.__webrtcInspector.getSnapshot().connections.find((c) => c.id === id);
        const dc = conn.dataChannels[0];
        return dc.lastMessages[dc.lastMessages.length - 1].suggested !== undefined;
      },
      connectionIdA,
      { timeout: 2000 }
    );
    const snap = await page.evaluate(() => window.__webrtcInspector.getSnapshot());
    const dc = snap.connections.find((c) => c.id === connectionIdA).dataChannels[0];
    expect(dc.lastMessages[dc.lastMessages.length - 1].suggested).toEqual({ guess: 'async-payload' });
  });

  test('clearSuggestDecoder stops the hook from running', async ({ page }) => {
    await gotoFixture(page);
    const connectionIdA = await page.evaluate(async () => {
      const { connectionIdA } = await window.testHelpers.createLoopbackSession();
      window.__webrtcInspector.setSuggestDecoder(() => ({ guess: 'stale' }));
      window.__webrtcInspector.clearSuggestDecoder();
      window.__dcA.send('after-clear');
      return connectionIdA;
    });
    await page.waitForFunction(
      (id) => {
        const conn = window.__webrtcInspector.getSnapshot().connections.find((c) => c.id === id);
        return conn.dataChannels[0].lastMessages.length > 0;
      },
      connectionIdA,
      { timeout: 2000 }
    );
    const snap = await page.evaluate(() => window.__webrtcInspector.getSnapshot());
    const dc = snap.connections.find((c) => c.id === connectionIdA).dataChannels[0];
    const msg = dc.lastMessages[dc.lastMessages.length - 1];
    expect(msg.suggested).toBeUndefined();
    expect(msg.advisory).toBeUndefined();
    expect(snap.suggestDecoderActive).toBe(false);
  });

  test('suggests a best-guess label for an outgoing WebSocket message scoped by socketId', async ({ page }) => {
    await gotoFixture(page);
    const wsId = await page.evaluate(async () => {
      window.__ws = new WebSocket('wss://mock.test/suggest', 'proto-x');
      await window.testHelpers.wait(30);
      window.__webrtcInspector.setSuggestDecoder((data, meta) => ({ guess: data, kind: meta.kind }));
      window.__ws.send('ping');
      return window.__webrtcInspector.getSnapshot().webSockets[0].id;
    });
    await page.waitForFunction(
      (id) => {
        const ws = window.__webrtcInspector.getSnapshot().webSockets.find((s) => s.id === id);
        return ws.lastMessages[ws.lastMessages.length - 1].suggested !== undefined;
      },
      wsId,
      { timeout: 2000 }
    );
    const snap = await page.evaluate(() => window.__webrtcInspector.getSnapshot());
    const ws = snap.webSockets.find((s) => s.id === wsId);
    expect(ws.lastMessages[ws.lastMessages.length - 1].suggested).toEqual({ guess: 'ping', kind: 'websocket' });
  });
});
