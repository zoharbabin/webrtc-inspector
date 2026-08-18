const { test, expect } = require('@playwright/test');
const { gotoFixture, SILENT_WAV_BASE64 } = require('../helpers');

// getTrackDiagnostics() (#37) — matches a <video>/<audio> element's
// srcObject track ids against tracked connections, powering the panel's
// "Test this stream" right-click overlay (extension/overlay.js).

test.describe('getTrackDiagnostics()', () => {
  test.beforeEach(async ({ page }) => {
    await gotoFixture(page);
    await page.evaluate((wav) => { window.__SILENT_WAV = wav; }, SILENT_WAV_BASE64);
  });

  test('matches a remote track to its receiving connection, kind, and status', async ({ page }) => {
    const { connectionIdB, remoteTrackId } = await page.evaluate(async () => {
      await window.__webrtcInspector.setFakeCam({ width: 64, height: 48 });
      const stream = await navigator.mediaDevices.getUserMedia({ video: true });
      const { connectionIdB } = await window.testHelpers.createLoopbackSession('test-channel', (pcA) => {
        pcA.addTrack(stream.getVideoTracks()[0], stream);
      });
      const snap = window.__webrtcInspector.getSnapshot();
      const remoteTrackId = snap.connections.find((c) => c.id === connectionIdB).remoteTracks[0].trackId;
      return { connectionIdB, remoteTrackId };
    });
    const diagnostics = await page.evaluate((id) => window.__webrtcInspector.getTrackDiagnostics([id]), remoteTrackId);
    expect(diagnostics.connectionId).toBe(connectionIdB);
    expect(diagnostics.kind).toBe('video');
    expect(diagnostics.status).toBe('live');
  });

  test('matches a local track to its sending connection', async ({ page }) => {
    // addTrack() after the O/A round (not in beforeOffer) so it's never
    // renegotiated to pcB — isolates a local-only match, since in the same
    // page loopback fixture a track added *before* the O/A round would also
    // land in pcB's remoteTracks under the same track id.
    const { connectionIdA, localTrackId } = await page.evaluate(async () => {
      const { connectionIdA } = await window.testHelpers.createLoopbackSession('test-channel');
      await window.__webrtcInspector.setFakeMic(window.__SILENT_WAV);
      const stream = await navigator.mediaDevices.getUserMedia({ audio: true });
      const localTrackId = stream.getTracks()[0].id;
      window.__pcA.addTrack(stream.getTracks()[0], stream);
      return { connectionIdA, localTrackId };
    });
    const diagnostics = await page.evaluate((id) => window.__webrtcInspector.getTrackDiagnostics([id]), localTrackId);
    expect(diagnostics.connectionId).toBe(connectionIdA);
    expect(diagnostics.kind).toBe('audio');
  });

  test('returns null when no tracked track matches any of the given ids', async ({ page }) => {
    await page.evaluate(() => window.testHelpers.createLoopbackSession());
    const diagnostics = await page.evaluate(() => window.__webrtcInspector.getTrackDiagnostics(['no-such-track-id']));
    expect(diagnostics).toBeNull();
  });

  test('returns null for a non-array/empty input instead of throwing', async ({ page }) => {
    const results = await page.evaluate(() => [
      window.__webrtcInspector.getTrackDiagnostics(undefined),
      window.__webrtcInspector.getTrackDiagnostics([]),
    ]);
    expect(results).toEqual([null, null]);
  });
});
