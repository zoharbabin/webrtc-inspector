const { test, expect } = require('@playwright/test');
const { gotoFixture } = require('../helpers');

test.describe('restartIce()', () => {
  test.beforeEach(async ({ page }) => {
    await gotoFixture(page);
  });

  test('calls the real pc.restartIce() — triggers negotiationneeded without closing the connection', async ({ page }) => {
    const result = await page.evaluate(async () => {
      const { connectionIdA } = await window.testHelpers.createLoopbackSession();
      const negotiationNeeded = new Promise((resolve) => {
        window.__pcA.onnegotiationneeded = () => resolve(true);
      });
      window.__webrtcInspector.restartIce(connectionIdA);
      const fired = await Promise.race([negotiationNeeded, window.testHelpers.wait(2000).then(() => false)]);
      return { fired, signalingState: window.__pcA.signalingState, connectionState: window.__pcA.connectionState };
    });
    expect(result.fired).toBe(true);
    expect(result.connectionState).not.toBe('closed');
  });

  test('emits an ice-restart event with connectionId and prior ICE/connection state', async ({ page }) => {
    const result = await page.evaluate(async () => {
      const { connectionIdA } = await window.testHelpers.createLoopbackSession();
      window.__events = [];
      window.__webrtcInspector.onEvent((e) => window.__events.push(e));
      window.__webrtcInspector.restartIce(connectionIdA);
      const evt = window.__events.find((e) => e.type === 'ice-restart');
      return { evt, connectionIdA };
    });
    expect(result.evt).toBeDefined();
    expect(result.evt.connectionId).toBe(result.connectionIdA);
    expect(typeof result.evt.iceConnectionState).toBe('string');
    expect(typeof result.evt.connectionState).toBe('string');
  });

  test('throws for an unknown connection id', async ({ page }) => {
    const threw = await page.evaluate(() => {
      try {
        window.__webrtcInspector.restartIce(999999);
        return false;
      } catch {
        return true;
      }
    });
    expect(threw).toBe(true);
  });
});
