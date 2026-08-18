const { test, expect } = require('@playwright/test');
const { gotoFixture } = require('../helpers');

// window.WebSocket is patched to MockWebSocket by the base fixture, and
// createLoopbackSession negotiates a real data channel with no signaling
// server — see test/fixtures/session-helpers.js and base.html.

test.describe('registerDecoder()', () => {
  test('decodes a data-channel message and attaches it to the message record', async ({ page }) => {
    await gotoFixture(page);
    const connectionIdA = await page.evaluate(async () => {
      const { connectionIdA } = await window.testHelpers.createLoopbackSession();
      window.__webrtcInspector.registerDecoder(
        (meta) => meta.kind === 'datachannel',
        (data) => ({ parsed: JSON.parse(data) })
      );
      window.__dcA.send(JSON.stringify({ hello: 'world' }));
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
    expect(msg.decoded).toEqual({ parsed: { hello: 'world' } });
    expect(msg.decoderId).toBeDefined();
  });

  test('records decodeError without breaking message delivery when decodeFn throws', async ({ page }) => {
    await gotoFixture(page);
    const connectionIdA = await page.evaluate(async () => {
      const { connectionIdA } = await window.testHelpers.createLoopbackSession();
      window.__webrtcInspector.registerDecoder(
        () => true,
        () => { throw new Error('boom'); }
      );
      window.__dcA.send('not-json');
      return connectionIdA;
    });
    await page.waitForFunction(
      (id) => {
        const conn = window.__webrtcInspector.getSnapshot().connections.find((c) => c.id === id);
        const dc = conn.dataChannels[0];
        return dc.lastMessages[dc.lastMessages.length - 1].decodeError !== undefined;
      },
      connectionIdA,
      { timeout: 2000 }
    );
    const snap = await page.evaluate(() => window.__webrtcInspector.getSnapshot());
    const dc = snap.connections.find((c) => c.id === connectionIdA).dataChannels[0];
    const msg = dc.lastMessages[dc.lastMessages.length - 1];
    expect(msg.decodeError).toContain('boom');
    expect(msg.preview).toBe('not-json');
  });

  test('first registered matching decoder wins', async ({ page }) => {
    await gotoFixture(page);
    const connectionIdA = await page.evaluate(async () => {
      const { connectionIdA } = await window.testHelpers.createLoopbackSession();
      window.__webrtcInspector.registerDecoder(() => true, () => 'first');
      window.__webrtcInspector.registerDecoder(() => true, () => 'second');
      window.__dcA.send('x');
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
    expect(dc.lastMessages[dc.lastMessages.length - 1].decoded).toBe('first');
  });

  test('an async decodeFn resolves and patches the message record', async ({ page }) => {
    await gotoFixture(page);
    const connectionIdA = await page.evaluate(async () => {
      const { connectionIdA } = await window.testHelpers.createLoopbackSession();
      window.__webrtcInspector.registerDecoder(
        () => true,
        async (data) => { await window.testHelpers.wait(20); return { async: data }; }
      );
      window.__dcA.send('payload');
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
    expect(dc.lastMessages[dc.lastMessages.length - 1].decoded).toEqual({ async: 'payload' });
  });

  test('an unregistered decoder never runs again', async ({ page }) => {
    await gotoFixture(page);
    const connectionIdA = await page.evaluate(async () => {
      const { connectionIdA } = await window.testHelpers.createLoopbackSession();
      const unregister = window.__webrtcInspector.registerDecoder(() => true, () => 'decoded-value');
      unregister();
      window.__dcA.send('after-unregister');
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
    expect(msg.decoded).toBeUndefined();
    expect(msg.decodeError).toBeUndefined();
    expect(msg.preview).toBe('after-unregister');
  });

  test('decodes an outgoing WebSocket message scoped by socketId', async ({ page }) => {
    await gotoFixture(page);
    const wsId = await page.evaluate(async () => {
      window.__ws = new WebSocket('wss://mock.test/decoder', 'proto-x');
      await window.testHelpers.wait(30);
      window.__webrtcInspector.registerDecoder(
        (meta) => meta.kind === 'websocket',
        (data) => ({ echoed: data })
      );
      window.__ws.send('ping');
      return window.__webrtcInspector.getSnapshot().webSockets[0].id;
    });
    await page.waitForFunction(
      (id) => {
        const ws = window.__webrtcInspector.getSnapshot().webSockets.find((s) => s.id === id);
        return ws.lastMessages[ws.lastMessages.length - 1].decoded !== undefined;
      },
      wsId,
      { timeout: 2000 }
    );
    const snap = await page.evaluate(() => window.__webrtcInspector.getSnapshot());
    const ws = snap.webSockets.find((s) => s.id === wsId);
    expect(ws.lastMessages[ws.lastMessages.length - 1].decoded).toEqual({ echoed: 'ping' });
  });
});
