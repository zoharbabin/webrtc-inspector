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

  // The media target is transform-free: every live sender gets replaceTrack(null)
  // for the outage and its track back on restore. That works mid-call on a
  // connection created before the outage, with no injector armed and no
  // renegotiation.
  test("simulateNetworkLoss with targets: ['media'] blacks out outgoing video mid-call, then auto-restores", async ({ page, browserName }) => {
    const result = await page.evaluate(async () => {
      const packets = async () => {
        const stats = await window.__pcA.getStats();
        let n = 0;
        stats.forEach((s) => { if (s.type === 'outbound-rtp' && s.kind === 'video') n += s.packetsSent || 0; });
        return n;
      };
      await window.__webrtcInspector.setFakeCam({ width: 64, height: 48 });
      await window.testHelpers.createLoopbackSession('media-loss', async (pcA) => {
        const stream = await navigator.mediaDevices.getUserMedia({ video: true });
        stream.getTracks().forEach((t) => pcA.addTrack(t, stream));
      });
      await window.testHelpers.waitFor(async () => (await packets()) > 0, 5000);
      const sender = window.__pcA.getSenders().find((s) => s.track && s.track.kind === 'video');
      const originalTrack = sender.track;

      const loss = window.__webrtcInspector.simulateNetworkLoss(10000, { targets: ['media'] });
      await window.testHelpers.wait(200); // let in-flight packets drain
      const trackDuring = sender.track;
      const p0 = await packets();
      await window.testHelpers.wait(800);
      const duringDelta = (await packets()) - p0;

      loss.stop();
      await loss.done;
      await window.testHelpers.waitFor(() => sender.track === originalTrack, 2000);
      await window.testHelpers.wait(200);
      const p1 = await packets();
      await window.testHelpers.wait(800);
      const afterDelta = (await packets()) - p1;
      return { trackDuring, restored: sender.track === originalTrack, duringDelta, afterDelta, signaling: window.__pcA.signalingState, state: window.__pcA.connectionState };
    });
    expect(result.trackDuring).toBeNull();
    // Firefox keeps sending ~1 RTP packet/s on a track-less video sender; Chromium and WebKit send none.
    expect(result.duringDelta).toBeLessThanOrEqual(browserName === 'firefox' ? 1 : 0);
    expect(result.restored).toBe(true);
    expect(result.afterDelta).toBeGreaterThan(0);
    expect(result.signaling).toBe('stable');
    expect(result.state).toBe('connected');
  });

  test("simulateNetworkLoss with targets: ['media'] leaves the app's own replaceTrack during the outage alone", async ({ page }) => {
    const result = await page.evaluate(async () => {
      await window.__webrtcInspector.setFakeCam({ width: 64, height: 48 });
      await window.testHelpers.createLoopbackSession('media-loss-app-swap', async (pcA) => {
        const stream = await navigator.mediaDevices.getUserMedia({ video: true });
        stream.getTracks().forEach((t) => pcA.addTrack(t, stream));
      });
      const sender = window.__pcA.getSenders().find((s) => s.track && s.track.kind === 'video');
      const originalTrack = sender.track;
      const appTrack = originalTrack.clone();
      const loss = window.__webrtcInspector.simulateNetworkLoss(300, { targets: ['media'] });
      await window.testHelpers.wait(50);
      await sender.replaceTrack(appTrack); // the app swaps cameras while we are blacked out
      await loss.done;
      await window.testHelpers.wait(300);
      return { keptAppTrack: sender.track === appTrack, revertedToOriginal: sender.track === originalTrack };
    });
    expect(result.keptAppTrack).toBe(true);
    expect(result.revertedToOriginal).toBe(false);
  });

  test("simulateNetworkLoss with targets: ['media'] keeps a previously armed setMediaFaultInjector running after the outage", async ({ page }) => {
    const result = await page.evaluate(async () => {
      window.__reports = 0;
      window.__webrtcInspector.onEvent((e) => { if (e.type === 'media-fault-report') window.__reports++; });
      window.__webrtcInspector.setMediaFaultInjector(null, 'video', (d, f, m, report) => { report(1); });
      await window.__webrtcInspector.setFakeCam({ width: 64, height: 48 });
      await window.testHelpers.createLoopbackSession('media-loss-compose', async (pcA) => {
        const stream = await navigator.mediaDevices.getUserMedia({ video: true });
        stream.getTracks().forEach((t) => pcA.addTrack(t, stream));
      });
      await window.testHelpers.waitFor(() => window.__reports > 0, 5000);
      const loss = window.__webrtcInspector.simulateNetworkLoss(300, { targets: ['media'] });
      await loss.done;
      await window.testHelpers.wait(200);
      const afterRestore = window.__reports;
      const grew = await window.testHelpers.waitFor(() => window.__reports > afterRestore, 3000);
      const activeAfter = window.__webrtcInspector.getSnapshot().mediaFaultInjectorActive;
      return { grew, activeAfter };
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
