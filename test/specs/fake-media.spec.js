const { test, expect } = require('@playwright/test');
const { gotoFixture, SILENT_WAV_BASE64 } = require('../helpers');

test.describe('Fake mic/cam and track lifecycle', () => {
  test.beforeEach(async ({ page }) => {
    await gotoFixture(page);
    await page.evaluate((wav) => { window.__SILENT_WAV = wav; }, SILENT_WAV_BASE64);
  });

  test('setFakeMic + getUserMedia serves a tagged fake track, reflected in fakeMicActive', async ({ page }) => {
    await page.evaluate(async () => {
      const { connectionIdA } = await window.testHelpers.createLoopbackSession();
      await window.__webrtcInspector.setFakeMic(window.__SILENT_WAV);
      const stream = await navigator.mediaDevices.getUserMedia({ audio: true });
      window.__fakeAudioStream = stream;
      stream.getTracks().forEach((t) => window.__pcA.addTrack(t, stream));
      window.__connectionIdA = connectionIdA;
    });
    const snap = await page.evaluate(() => window.__webrtcInspector.getSnapshot());
    expect(snap.fakeMicActive).toBe(true);
    const connectionIdA = await page.evaluate(() => window.__connectionIdA);
    const recA = snap.connections.find((c) => c.id === connectionIdA);
    expect(recA.localTracks.some((t) => t.sourceTag === 'fake-mic')).toBe(true);
  });

  test('setFakeCam + getUserMedia serves a tagged fake video track, reflected in fakeCamActive', async ({ page }) => {
    await page.evaluate(async () => {
      await window.testHelpers.createLoopbackSession();
      await window.__webrtcInspector.setFakeCam({ width: 64, height: 48 });
      const stream = await navigator.mediaDevices.getUserMedia({ video: true });
      window.__pcA.addTransceiver(stream.getVideoTracks()[0], { direction: 'sendonly' });
    });
    const snap = await page.evaluate(() => window.__webrtcInspector.getSnapshot());
    expect(snap.fakeCamActive).toBe(true);
  });

  test('stopping a local track directly is reflected as ended', async ({ page }) => {
    const connectionIdA = await page.evaluate(async () => {
      const { connectionIdA } = await window.testHelpers.createLoopbackSession();
      await window.__webrtcInspector.setFakeMic(window.__SILENT_WAV);
      const stream = await navigator.mediaDevices.getUserMedia({ audio: true });
      stream.getTracks().forEach((t) => window.__pcA.addTrack(t, stream));
      window.__fakeAudioStream = stream;
      return connectionIdA;
    });
    await page.evaluate(() => window.__fakeAudioStream.getAudioTracks()[0].stop());
    await page.waitForFunction(
      (id) => window.__webrtcInspector.getSnapshot().connections.find((c) => c.id === id).localTracks[0].status === 'ended',
      connectionIdA
    );
    const snap = await page.evaluate(() => window.__webrtcInspector.getSnapshot());
    const recA = snap.connections.find((c) => c.id === connectionIdA);
    expect(recA.localTracks.find((t) => t.sourceTag === 'fake-mic').status).toBe('ended');
  });

  test('meters remote audio track level as a number', async ({ page }) => {
    const connectionIdB = await page.evaluate(async () => {
      await window.__webrtcInspector.setFakeMic(window.__SILENT_WAV);
      const stream = await navigator.mediaDevices.getUserMedia({ audio: true });
      // Track must be added before the offer/answer round, or the peer never
      // renegotiates and the remote 'track' event on pcB never fires.
      const { connectionIdB } = await window.testHelpers.createLoopbackSession('test-channel', (pcA) => {
        stream.getTracks().forEach((t) => pcA.addTrack(t, stream));
      });
      window.__webrtcInspector.playIntoFakeMic();
      return connectionIdB;
    });
    // Let ICE finish gathering + the level-meter interval (250ms) sample at least once.
    await page.waitForFunction(
      (id) => {
        const recB = window.__webrtcInspector.getSnapshot().connections.find((c) => c.id === id);
        const track = recB && recB.remoteTracks.find((t) => t.kind === 'audio');
        return !!track && typeof track.level === 'number';
      },
      connectionIdB,
      { timeout: 3000 }
    );
    const snap = await page.evaluate(() => window.__webrtcInspector.getSnapshot());
    const recB = snap.connections.find((c) => c.id === connectionIdB);
    expect(typeof recB.remoteTracks.find((t) => t.kind === 'audio').level).toBe('number');
  });

  test('getFakeMicTrack returns a fresh clone tagged fake-mic', async ({ page }) => {
    const tag = await page.evaluate(async () => {
      await window.__webrtcInspector.setFakeMic(window.__SILENT_WAV);
      const track = window.__webrtcInspector.getFakeMicTrack();
      return track.kind;
    });
    expect(tag).toBe('audio');
  });

  test('getRemoteTrackStream returns a live MediaStream for a remote track', async ({ page }) => {
    const { connectionIdB, trackId } = await page.evaluate(async () => {
      await window.__webrtcInspector.setFakeMic(window.__SILENT_WAV);
      const stream = await navigator.mediaDevices.getUserMedia({ audio: true });
      const { connectionIdB } = await window.testHelpers.createLoopbackSession('test-channel', (pcA) => {
        stream.getTracks().forEach((t) => pcA.addTrack(t, stream));
      });
      await window.testHelpers.waitFor(() => {
        const recB = window.__webrtcInspector.getSnapshot().connections.find((c) => c.id === connectionIdB);
        return !!recB && recB.remoteTracks.length > 0;
      });
      const recB = window.__webrtcInspector.getSnapshot().connections.find((c) => c.id === connectionIdB);
      return { connectionIdB, trackId: recB.remoteTracks[0].trackId };
    });
    const result = await page.evaluate(
      ({ connectionIdB, trackId }) => {
        const stream = window.__webrtcInspector.getRemoteTrackStream(connectionIdB, trackId);
        return { isStream: stream instanceof MediaStream, trackCount: stream.getTracks().length };
      },
      { connectionIdB, trackId }
    );
    expect(result.isStream).toBe(true);
    expect(result.trackCount).toBe(1);
  });

  test('clearFakeMic/clearFakeCam clear the active flags', async ({ page }) => {
    await page.evaluate(async () => {
      await window.__webrtcInspector.setFakeMic(window.__SILENT_WAV);
      await window.__webrtcInspector.setFakeCam({ width: 64, height: 48 });
      window.__webrtcInspector.clearFakeMic();
      window.__webrtcInspector.clearFakeCam();
    });
    const snap = await page.evaluate(() => window.__webrtcInspector.getSnapshot());
    expect(snap.fakeMicActive).toBe(false);
    expect(snap.fakeCamActive).toBe(false);
  });
});
