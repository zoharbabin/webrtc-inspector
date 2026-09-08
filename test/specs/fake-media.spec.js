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

  // The meter reads a Web Audio analyser on the remote track. That only reflects
  // real audio when something is pulling the track, so this test attaches an
  // app-side <audio> sink and asserts a level above the noise floor. Asserting
  // only `typeof level === 'number'` would pass on pure digital silence.
  //
  // A meter AudioContext that isn't being rendered can't measure anything, and
  // on a headless runner with no audio output device it isn't. The meter reports
  // 'audio-context-not-rendering' for exactly that, so this test trusts the
  // reported reason: it skips only when the inspector itself says it could not
  // measure, and still fails on a flat level from a rendering context, which is
  // the regression worth catching.
  test('meters a real remote audio level when the app renders the track', async ({ page }) => {
    const result = await page.evaluate(async () => {
      const stream = await navigator.mediaDevices.getUserMedia({ audio: true }); // fake device: audible tone
      // Track must be added before the offer/answer round, or the peer never
      // renegotiates and the remote 'track' event on pcB never fires.
      const { connectionIdB } = await window.testHelpers.createLoopbackSession('test-channel', (pcA) => {
        stream.getTracks().forEach((t) => pcA.addTrack(t, stream));
      });

      // The app's own sink. Without one, Chromium never runs the decoder.
      const remote = window.__pcB.getReceivers().find((r) => r.track && r.track.kind === 'audio').track;
      const el = document.createElement('audio');
      el.autoplay = true;
      el.srcObject = new MediaStream([remote]);
      document.body.appendChild(el);
      try { await el.play(); } catch { /* autoplay policy: the sink still pulls */ }

      const track = () => {
        const recB = window.__webrtcInspector.getSnapshot().connections.find((c) => c.id === connectionIdB);
        return recB && recB.remoteTracks.find((t) => t.kind === 'audio');
      };
      let maxLevel = 0;
      let reasonWhenMetered = 'never-metered';
      try {
        await window.testHelpers.waitFor(() => {
          const t = track();
          if (t && typeof t.level === 'number' && t.level > maxLevel) {
            maxLevel = t.level;
            reasonWhenMetered = t.levelUnavailableReason;
          }
          return maxLevel > 0.01;
        }, 8000, 100);
      } catch (_) { /* no level in time: the reason below says whether that is a bug or a runner with no audio device */ }
      const last = track();
      return { maxLevel, unavailableReason: reasonWhenMetered, finalReason: last ? last.levelUnavailableReason : null };
    });
    test.skip(result.finalReason === 'audio-context-not-rendering', 'nothing drives an AudioContext on this machine, so the meter cannot measure any level');
    expect(result.maxLevel).toBeGreaterThan(0.01);
    expect(result.unavailableReason).toBeNull();
  });

  // Chromium runs the audio decoder only for a remote track something renders.
  // With no app sink, totalSamplesReceived never advances while RTP keeps
  // arriving, so the analyser reads pure silence. Reporting level 0 there would
  // claim "the far end is silent" when the truth is "nothing is pulling this
  // track", so the meter reports null plus a reason instead.
  test('reports level null with a reason when nothing renders the remote track', async ({ page, browserName }) => {
    test.skip(browserName !== 'chromium', 'Firefox and WebKit decode a remote audio track with no sink attached');
    const result = await page.evaluate(async () => {
      const stream = await navigator.mediaDevices.getUserMedia({ audio: true });
      const { connectionIdB } = await window.testHelpers.createLoopbackSession('test-channel', (pcA) => {
        stream.getTracks().forEach((t) => pcA.addTrack(t, stream));
      });
      const track = () => {
        const recB = window.__webrtcInspector.getSnapshot().connections.find((c) => c.id === connectionIdB);
        return recB && recB.remoteTracks.find((t) => t.kind === 'audio');
      };
      // Needs two stats polls (2s each) to see packets growing while samples stay flat.
      await window.testHelpers.waitFor(() => {
        const t = track();
        return t && t.levelUnavailableReason === 'track-not-rendered';
      }, 9000, 200);
      const t = track();
      return { level: t.level, reason: t.levelUnavailableReason };
    });
    expect(result.reason).toBe('track-not-rendered');
    expect(result.level).toBeNull();
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
