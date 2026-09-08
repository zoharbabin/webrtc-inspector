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
      // `done` resolves only after every blacked-out sender has its track back,
      // so reading sender.track immediately after it, with no polling, is what
      // asserts that contract. Polling here would pass either way.
      await loss.done;
      const restored = sender.track === originalTrack;
      await window.testHelpers.wait(200);
      const p1 = await packets();
      await window.testHelpers.wait(800);
      const afterDelta = (await packets()) - p1;
      return { trackDuring, restored, duringDelta, afterDelta, signaling: window.__pcA.signalingState, state: window.__pcA.connectionState };
    });
    expect(result.trackDuring).toBeNull();
    // Firefox keeps sending ~1 RTP packet/s on a track-less video sender; Chromium and WebKit send none.
    expect(result.duringDelta).toBeLessThanOrEqual(browserName === 'firefox' ? 1 : 0);
    expect(result.restored).toBe(true);
    expect(result.afterDelta).toBeGreaterThan(0);
    expect(result.signaling).toBe('stable');
    expect(result.state).toBe('connected');
  });

  test("simulateNetworkLoss with targets: ['media'] restores the app's own mid-outage replaceTrack, not the track it displaced", async ({ page }) => {
    const result = await page.evaluate(async () => {
      await window.__webrtcInspector.setFakeCam({ width: 64, height: 48 });
      await window.testHelpers.createLoopbackSession('media-loss-app-swap', async (pcA) => {
        const stream = await navigator.mediaDevices.getUserMedia({ video: true });
        stream.getTracks().forEach((t) => pcA.addTrack(t, stream));
      });
      const sender = window.__pcA.getSenders().find((s) => s.track && s.track.kind === 'video');
      const originalTrack = sender.track;
      const appTrack = originalTrack.clone();
      // Long enough that the dark-track poll below can't race the restore.
      const loss = window.__webrtcInspector.simulateNetworkLoss(5000, { targets: ['media'] });
      await window.testHelpers.wait(50);
      await sender.replaceTrack(appTrack); // the app swaps cameras while we are blacked out
      // The re-blackout is fire-and-forget, and sender.track only flips when
      // replaceTrack's promise settles, so poll instead of reading it once.
      const darkDuringOutage = await window.testHelpers.waitFor(() => sender.track === null, 1000, 10);
      loss.stop();
      await loss.done;
      await window.testHelpers.wait(300);
      return { darkDuringOutage, keptAppTrack: sender.track === appTrack, revertedToOriginal: sender.track === originalTrack };
    });
    expect(result.darkDuringOutage).toBe(true);
    expect(result.keptAppTrack).toBe(true);
    expect(result.revertedToOriginal).toBe(false);
  });

  test("simulateNetworkLoss with targets: ['media'] gives back no track if the app cleared it mid-outage", async ({ page }) => {
    const result = await page.evaluate(async () => {
      await window.__webrtcInspector.setFakeCam({ width: 64, height: 48 });
      await window.testHelpers.createLoopbackSession('media-loss-app-clear', async (pcA) => {
        const stream = await navigator.mediaDevices.getUserMedia({ video: true });
        stream.getTracks().forEach((t) => pcA.addTrack(t, stream));
      });
      const sender = window.__pcA.getSenders().find((s) => s.track && s.track.kind === 'video');
      const loss = window.__webrtcInspector.simulateNetworkLoss(300, { targets: ['media'] });
      await window.testHelpers.wait(50);
      await sender.replaceTrack(null); // the app itself drops the track mid-outage
      await loss.done;
      await window.testHelpers.wait(400);
      return { trackAfter: sender.track };
    });
    expect(result.trackAfter).toBeNull();
  });

  test("simulateNetworkLoss with targets: ['media'] blacks out a sender the app adds mid-outage", async ({ page, browserName }) => {
    const result = await page.evaluate(async () => {
      const packets = async () => {
        const stats = await window.__pcA.getStats();
        let n = 0;
        stats.forEach((s) => { if (s.type === 'outbound-rtp' && s.kind === 'video') n += s.packetsSent || 0; });
        return n;
      };
      await window.__webrtcInspector.setFakeCam({ width: 64, height: 48 });
      await window.testHelpers.createLoopbackSession('media-loss-late-add');
      const stream = await navigator.mediaDevices.getUserMedia({ video: true });
      const track = stream.getVideoTracks()[0];

      const loss = window.__webrtcInspector.simulateNetworkLoss(10000, { targets: ['media'] });
      const sender = window.__pcA.addTrack(track, stream); // added while the outage is running
      await window.__pcA.setLocalDescription();
      await window.__pcB.setRemoteDescription(window.__pcA.localDescription);
      await window.__pcB.setLocalDescription();
      await window.__pcA.setRemoteDescription(window.__pcB.localDescription);
      await window.testHelpers.wait(400);
      const trackDuring = sender.track;
      const p0 = await packets();
      await window.testHelpers.wait(800);
      const duringDelta = (await packets()) - p0;

      loss.stop();
      await loss.done;
      const restored = sender.track === track; // `done` already waited for the restore
      await window.testHelpers.wait(200);
      const p1 = await packets();
      await window.testHelpers.wait(1000);
      const afterDelta = (await packets()) - p1;
      return { trackDuring, duringDelta, restored, afterDelta };
    });
    expect(result.trackDuring).toBeNull();
    // Firefox keeps sending ~1 RTP packet/s on a track-less video sender; Chromium and WebKit send none.
    expect(result.duringDelta).toBeLessThanOrEqual(browserName === 'firefox' ? 2 : 0);
    expect(result.restored).toBe(true);
    expect(result.afterDelta).toBeGreaterThan(0);
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

  // Overlapping outages are ref-counted, so two windows on the same target
  // nest: the last one to end lifts the block. The hard case is FIFO order,
  // where the outage that started first also ends first while the second is
  // still running. Save-and-restore semantics break there in three ways at
  // once, so each target gets a test that the page is fully working afterwards.
  test('overlapping data-channel outages nest and both restore cleanly', async ({ page }) => {
    const result = await page.evaluate(async () => {
      await window.testHelpers.createLoopbackSession();
      window.__dcBMessages = [];
      window.__dcB.addEventListener('message', (e) => window.__dcBMessages.push(e.data));

      const first = window.__webrtcInspector.simulateNetworkLoss(200, { targets: ['datachannel'] });
      const second = window.__webrtcInspector.simulateNetworkLoss(1200, { targets: ['datachannel'] });
      await first.done; // first window over, second still running

      window.__dcA.send('leak-check');
      await window.testHelpers.wait(150);
      const leakedDuringRemainingOutage = window.__dcBMessages.length > 0;

      second.stop();
      await second.done;
      window.__dcA.send('after-both');
      const delivered = await window.testHelpers.waitFor(() => window.__dcBMessages.includes('after-both'), 2000);
      return { leakedDuringRemainingOutage, delivered, activeOutages: window.__webrtcInspector.getSnapshot().activeOutages };
    });
    expect(result.leakedDuringRemainingOutage).toBe(false);
    expect(result.delivered).toBe(true);
    expect(result.activeOutages).toEqual([]);
  });

  test('overlapping http outages nest and fetch works again afterwards', async ({ page }) => {
    const result = await page.evaluate(async () => {
      const tryFetch = () => fetch('/test/fixtures/base.html').then((r) => r.status, () => null);

      const first = window.__webrtcInspector.simulateNetworkLoss(200, { targets: ['http'] });
      const second = window.__webrtcInspector.simulateNetworkLoss(1200, { targets: ['http'] });
      await first.done;
      const duringRemainingOutage = await tryFetch(); // must still be blocked

      second.stop();
      await second.done;
      const afterBoth = await tryFetch();
      return { duringRemainingOutage, afterBoth, httpBlocked: window.__webrtcInspector.getSnapshot().httpBlocked };
    });
    expect(result.duringRemainingOutage).toBeNull();
    expect(result.afterBoth).toBe(200);
    expect(result.httpBlocked).toBe(false);
  });

  test('overlapping websocket outages nest and sends flow again afterwards', async ({ page }) => {
    const result = await page.evaluate(async () => {
      const ws = new WebSocket('wss://example.test/signal');
      await window.testHelpers.waitFor(() => ws.readyState === 1);

      const first = window.__webrtcInspector.simulateNetworkLoss(200, { targets: ['websocket'] });
      const second = window.__webrtcInspector.simulateNetworkLoss(1200, { targets: ['websocket'] });
      await first.done;
      ws.send('leak-check');
      const leakedDuringRemainingOutage = ws.sent.includes('leak-check');

      second.stop();
      await second.done;
      ws.send('after-both');
      return { leakedDuringRemainingOutage, deliveredAfter: ws.sent.includes('after-both') };
    });
    expect(result.leakedDuringRemainingOutage).toBe(false);
    expect(result.deliveredAfter).toBe(true);
  });

  test('overlapping media outages nest: no packets leak, and the track comes back once', async ({ page, browserName }) => {
    const result = await page.evaluate(async () => {
      const packets = async () => {
        const stats = await window.__pcA.getStats();
        let n = 0;
        stats.forEach((s) => { if (s.type === 'outbound-rtp' && s.kind === 'video') n += s.packetsSent || 0; });
        return n;
      };
      await window.__webrtcInspector.setFakeCam({ width: 64, height: 48 });
      await window.testHelpers.createLoopbackSession('media-overlap', async (pcA) => {
        const stream = await navigator.mediaDevices.getUserMedia({ video: true });
        stream.getTracks().forEach((t) => pcA.addTrack(t, stream));
      });
      await window.testHelpers.waitFor(async () => (await packets()) > 0, 5000);
      const sender = window.__pcA.getSenders().find((s) => s.track && s.track.kind === 'video');
      const originalTrack = sender.track;

      const first = window.__webrtcInspector.simulateNetworkLoss(300, { targets: ['media'] });
      await window.testHelpers.wait(80);
      const second = window.__webrtcInspector.simulateNetworkLoss(3000, { targets: ['media'] });
      await first.done; // first window over, second still running
      await window.testHelpers.wait(300);
      const trackWhileSecondRuns = sender.track;
      const p0 = await packets();
      await window.testHelpers.wait(900);
      const leakedPackets = (await packets()) - p0;

      second.stop();
      await second.done;
      const restored = sender.track === originalTrack; // `done` already waited for the restore
      await window.testHelpers.wait(200);
      const p1 = await packets();
      await window.testHelpers.wait(900);
      const afterDelta = (await packets()) - p1;
      return { trackWhileSecondRuns, leakedPackets, restored, afterDelta };
    });
    expect(result.trackWhileSecondRuns).toBeNull();
    // Firefox keeps sending ~1 RTP packet/s on a track-less video sender; Chromium and WebKit send none.
    expect(result.leakedPackets).toBeLessThanOrEqual(browserName === 'firefox' ? 2 : 0);
    expect(result.restored).toBe(true);
    expect(result.afterDelta).toBeGreaterThan(0);
  });

  test('overlapping outages never disturb the app\'s own interceptors', async ({ page }) => {
    const result = await page.evaluate(async () => {
      await window.testHelpers.createLoopbackSession();
      window.__dcBMessages = [];
      window.__dcB.addEventListener('message', (e) => window.__dcBMessages.push(e.data));
      window.__webrtcInspector.setDataChannelInterceptor((dir, ctx) => (dir === 'out' ? ctx.data.toUpperCase() : undefined));

      const snapDuring = [];
      const first = window.__webrtcInspector.simulateNetworkLoss(200, { targets: ['datachannel'] });
      const second = window.__webrtcInspector.simulateNetworkLoss(900, { targets: ['datachannel'] });
      snapDuring.push(window.__webrtcInspector.getSnapshot().dataChannelInterceptorActive);
      await first.done;
      snapDuring.push(window.__webrtcInspector.getSnapshot().dataChannelInterceptorActive);
      second.stop();
      await second.done;

      window.__dcA.send('still-intercepted');
      await window.testHelpers.waitFor(() => window.__dcBMessages.length >= 1, 2000);
      const snap = window.__webrtcInspector.getSnapshot();
      window.__webrtcInspector.clearDataChannelInterceptor();
      return { snapDuring, delivered: window.__dcBMessages[0], activeAfter: snap.dataChannelInterceptorActive };
    });
    // The interceptor flag reports only the app's own hook, so it stays true
    // throughout: an outage is no longer implemented by swapping into that slot.
    expect(result.snapDuring).toEqual([true, true]);
    expect(result.delivered).toBe('STILL-INTERCEPTED');
    expect(result.activeAfter).toBe(true);
  });

  test('activeOutages reports every down target and clears on restore', async ({ page }) => {
    const result = await page.evaluate(async () => {
      const snap = () => window.__webrtcInspector.getSnapshot().activeOutages.slice().sort();
      const before = snap();
      const a = window.__webrtcInspector.simulateNetworkLoss(5000, { targets: ['http', 'websocket'] });
      const withA = snap();
      const b = window.__webrtcInspector.simulateNetworkLoss(5000, { targets: ['websocket', 'datachannel'] });
      const withBoth = snap();
      a.stop();
      await a.done;
      const afterA = snap(); // websocket is still held by b
      b.stop();
      await b.done;
      return { before, withA, withBoth, afterA, afterBoth: snap() };
    });
    expect(result.before).toEqual([]);
    expect(result.withA).toEqual(['http', 'websocket']);
    expect(result.withBoth).toEqual(['datachannel', 'http', 'websocket']);
    expect(result.afterA).toEqual(['datachannel', 'websocket']);
    expect(result.afterBoth).toEqual([]);
  });

  test('stop() is idempotent and does not lift another overlapping outage', async ({ page }) => {
    const result = await page.evaluate(async () => {
      await window.testHelpers.createLoopbackSession();
      window.__dcBMessages = [];
      window.__dcB.addEventListener('message', (e) => window.__dcBMessages.push(e.data));

      const first = window.__webrtcInspector.simulateNetworkLoss(5000, { targets: ['datachannel'] });
      const second = window.__webrtcInspector.simulateNetworkLoss(5000, { targets: ['datachannel'] });
      first.stop();
      first.stop();
      first.stop(); // extra stops must not decrement second's hold
      await first.done;
      window.__dcA.send('leak-check');
      await window.testHelpers.wait(150);
      const leaked = window.__dcBMessages.length > 0;
      const stillDown = window.__webrtcInspector.getSnapshot().activeOutages;

      second.stop();
      await second.done;
      window.__dcA.send('after-both');
      const delivered = await window.testHelpers.waitFor(() => window.__dcBMessages.includes('after-both'), 2000);
      return { leaked, stillDown, delivered, activeAfter: window.__webrtcInspector.getSnapshot().activeOutages };
    });
    expect(result.leaked).toBe(false);
    expect(result.stillDown).toEqual(['datachannel']);
    expect(result.delivered).toBe(true);
    expect(result.activeAfter).toEqual([]);
  });

  test('blocks inbound data-channel messages, not just outbound', async ({ page }) => {
    const result = await page.evaluate(async () => {
      await window.testHelpers.createLoopbackSession();
      window.__dcAMessages = [];
      window.__dcA.addEventListener('message', (e) => window.__dcAMessages.push(e.data));

      const loss = window.__webrtcInspector.simulateNetworkLoss(400, { targets: ['datachannel'] });
      window.__dcB.send('inbound-during-outage'); // B is not instrumented as the sender here
      await window.testHelpers.wait(200);
      const duringOutage = window.__dcAMessages.length;
      await loss.done;
      window.__dcB.send('inbound-after');
      const delivered = await window.testHelpers.waitFor(() => window.__dcAMessages.includes('inbound-after'), 2000);
      return { duringOutage, delivered };
    });
    expect(result.duringOutage).toBe(0);
    expect(result.delivered).toBe(true);
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
