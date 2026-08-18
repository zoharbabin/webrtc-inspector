const { test, expect } = require('@playwright/test');
const { gotoFixture } = require('../helpers');

test.describe('Network-fault primitives', () => {
  test.beforeEach(async ({ page }) => {
    await gotoFixture(page);
  });

  test('killConnection closes the peer connection and marks it closed', async ({ page }) => {
    const connectionIdA = await page.evaluate(async () => {
      const { connectionIdA } = await window.testHelpers.createLoopbackSession();
      window.__webrtcInspector.killConnection(connectionIdA);
      return connectionIdA;
    });
    expect(await page.evaluate(() => window.__pcA.connectionState === 'closed' || window.__pcA.signalingState === 'closed')).toBe(true);
    await page.waitForFunction(
      (id) => window.__webrtcInspector.getSnapshot().connections.find((c) => c.id === id).closed === true,
      connectionIdA
    );
  });

  test('killConnection on an unknown id throws', async ({ page }) => {
    const threw = await page.evaluate(() => {
      try {
        window.__webrtcInspector.killConnection(999999);
        return false;
      } catch {
        return true;
      }
    });
    expect(threw).toBe(true);
  });

  test('simulateNetworkLoss blocks and then restores data-channel delivery', async ({ page }) => {
    await page.evaluate(async () => {
      await window.testHelpers.createLoopbackSession();
      window.__dcBMessages = [];
      window.__dcB.addEventListener('message', (e) => window.__dcBMessages.push(e.data));
    });

    const result = await page.evaluate(async () => {
      const loss = window.__webrtcInspector.simulateNetworkLoss(150, { targets: ['datachannel'] });
      window.__dcA.send('during-outage');
      await window.testHelpers.wait(50);
      const duringOutage = window.__dcBMessages.length;
      await loss.done;
      window.__dcA.send('after-recovery');
      await window.testHelpers.waitFor(() => window.__dcBMessages.length >= 1);
      return { duringOutage, afterRecovery: window.__dcBMessages.length, lastMessage: window.__dcBMessages[window.__dcBMessages.length - 1] };
    });

    expect(result.duringOutage).toBe(0);
    expect(result.afterRecovery).toBeGreaterThanOrEqual(1);
    expect(result.lastMessage).toBe('after-recovery');
  });

  test('simulateNetworkLoss.stop() ends the outage early', async ({ page }) => {
    await page.evaluate(async () => {
      await window.testHelpers.createLoopbackSession();
      window.__dcBMessages = [];
      window.__dcB.addEventListener('message', (e) => window.__dcBMessages.push(e.data));
    });

    const delivered = await page.evaluate(async () => {
      const loss = window.__webrtcInspector.simulateNetworkLoss(10000, { targets: ['datachannel'] });
      loss.stop();
      await loss.done;
      window.__dcA.send('after-manual-stop');
      await window.testHelpers.waitFor(() => window.__dcBMessages.length >= 1);
      return window.__dcBMessages.length;
    });

    expect(delivered).toBeGreaterThanOrEqual(1);
  });

  test('simulateNetworkLoss composes with an active data-channel interceptor', async ({ page }) => {
    await page.evaluate(async () => {
      await window.testHelpers.createLoopbackSession();
      window.__dcBMessages = [];
      window.__dcB.addEventListener('message', (e) => window.__dcBMessages.push(e.data));
    });

    const result = await page.evaluate(async () => {
      window.__webrtcInspector.setDataChannelInterceptor((dir, ctx) => (dir === 'out' ? ctx.data.toUpperCase() : undefined));
      const loss = window.__webrtcInspector.simulateNetworkLoss(100, { targets: ['datachannel'] });
      await loss.done;
      window.__dcA.send('interceptor-still-active');
      await window.testHelpers.waitFor(() => window.__dcBMessages.length >= 1);
      window.__webrtcInspector.clearDataChannelInterceptor();
      return window.__dcBMessages[0];
    });

    expect(result).toBe('INTERCEPTOR-STILL-ACTIVE');
  });

  test("simulateNetworkLoss with targets: ['media'] drops real outgoing video frames, then auto-restores", async ({ page }) => {
    const result = await page.evaluate(async () => {
      await window.__webrtcInspector.setFakeCam({ width: 64, height: 48 });
      await window.testHelpers.createLoopbackSession('media-loss', async (pcA) => {
        const stream = await navigator.mediaDevices.getUserMedia({ video: true });
        stream.getTracks().forEach((t) => pcA.addTrack(t, stream));
      });
      const loss = window.__webrtcInspector.simulateNetworkLoss(10000, { targets: ['media'] });
      await window.testHelpers.wait(500);
      const statsDuring = await window.__pcA.getStats();
      let duringPackets = 0;
      statsDuring.forEach((s) => { if (s.type === 'outbound-rtp' && s.kind === 'video') duringPackets += s.packetsSent || 0; });
      loss.stop();
      await loss.done;
      await window.testHelpers.wait(500);
      const statsAfter = await window.__pcA.getStats();
      let afterPackets = 0;
      statsAfter.forEach((s) => { if (s.type === 'outbound-rtp' && s.kind === 'video') afterPackets += s.packetsSent || 0; });
      return { duringPackets, afterPackets };
    });
    expect(result.duringPackets).toBe(0);
    expect(result.afterPackets).toBeGreaterThan(0);
  });

  test("simulateNetworkLoss with targets: ['media'] restores a previously active setMediaFaultInjector after the outage", async ({ page }) => {
    const result = await page.evaluate(async () => {
      window.__calls = 0;
      window.__webrtcInspector.setMediaFaultInjector(null, 'video', () => { window.__calls++; });
      await window.__webrtcInspector.setFakeCam({ width: 64, height: 48 });
      await window.testHelpers.createLoopbackSession('media-loss-compose', async (pcA) => {
        const stream = await navigator.mediaDevices.getUserMedia({ video: true });
        stream.getTracks().forEach((t) => pcA.addTrack(t, stream));
      });
      await window.testHelpers.waitFor(() => window.__calls > 0);
      const loss = window.__webrtcInspector.simulateNetworkLoss(300, { targets: ['media'] });
      await loss.done;
      const callsRightAfterRestore = window.__calls;
      await window.testHelpers.wait(300);
      const activeAfter = window.__webrtcInspector.getSnapshot().mediaFaultInjectorActive;
      return { grew: window.__calls > callsRightAfterRestore, activeAfter };
    });
    expect(result.grew).toBe(true);
    expect(result.activeAfter).toBe(true);
  });

  test('does not block websocket/datachannel targets when only media is requested', async ({ page }) => {
    await page.evaluate(() => window.testHelpers.createLoopbackSession());
    const active = await page.evaluate(async () => {
      const loss = window.__webrtcInspector.simulateNetworkLoss(300, { targets: ['media'] });
      window.__dcA.send('still-flows');
      loss.stop();
      return window.__dcA.readyState;
    });
    expect(active).toBe('open');
  });
});
