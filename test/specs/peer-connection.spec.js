const { test, expect } = require('@playwright/test');
const { gotoFixture, SILENT_WAV_BASE64 } = require('../helpers');

test.describe('RTCPeerConnection instrumentation', () => {
  test.beforeEach(async ({ page }) => {
    await gotoFixture(page);
    await page.evaluate((wav) => { window.__SILENT_WAV = wav; }, SILENT_WAV_BASE64);
  });

  test('installs window.__webrtcInspector', async ({ page }) => {
    const installed = await page.evaluate(() => {
      const inspector = window.__webrtcInspector;
      return !!inspector && !inspector.unsupported;
    });
    expect(installed).toBe(true);
  });

  test('tracks both peers of a loopback session', async ({ page }) => {
    await page.evaluate(() => window.testHelpers.createLoopbackSession());
    const snap = await page.evaluate(() => window.__webrtcInspector.getSnapshot());
    expect(snap.connections).toHaveLength(2);
  });

  test('captures local ICE candidates', async ({ page }) => {
    const { connectionIdA } = await page.evaluate(() => window.testHelpers.createLoopbackSession());
    await page.waitForFunction(
      (id) => window.__webrtcInspector.getSnapshot().connections.find((c) => c.id === id).localCandidateTypes.length > 0,
      connectionIdA
    );
    const snap = await page.evaluate(() => window.__webrtcInspector.getSnapshot());
    const recA = snap.connections.find((c) => c.id === connectionIdA);
    expect(recA.localCandidateTypes.length).toBeGreaterThan(0);
  });

  test('captures remote ICE candidates on the answering side', async ({ page }) => {
    const { connectionIdB } = await page.evaluate(() => window.testHelpers.createLoopbackSession());
    await page.waitForFunction(
      (id) => window.__webrtcInspector.getSnapshot().connections.find((c) => c.id === id).remoteCandidateTypes.length > 0,
      connectionIdB
    );
    const snap = await page.evaluate(() => window.__webrtcInspector.getSnapshot());
    const recB = snap.connections.find((c) => c.id === connectionIdB);
    expect(recB.remoteCandidateTypes.length).toBeGreaterThan(0);
  });

  test('captures local SDP summary (m-lines + codecs)', async ({ page }) => {
    const { connectionIdA } = await page.evaluate(() =>
      window.testHelpers.createLoopbackSession('test-channel', (pcA) => pcA.addTransceiver('audio'))
    );
    const snap = await page.evaluate(() => window.__webrtcInspector.getSnapshot());
    const recA = snap.connections.find((c) => c.id === connectionIdA);
    expect(recA.localSdpSummary).toBeTruthy();
    expect(recA.localSdpSummary.mLines).toBeGreaterThanOrEqual(1);
    expect(recA.localSdpSummary.codecs.length).toBeGreaterThan(0);
  });

  test('captures remote SDP summary on the answering side', async ({ page }) => {
    const { connectionIdB } = await page.evaluate(() =>
      window.testHelpers.createLoopbackSession('test-channel', (pcA) => pcA.addTransceiver('audio'))
    );
    const snap = await page.evaluate(() => window.__webrtcInspector.getSnapshot());
    const recB = snap.connections.find((c) => c.id === connectionIdB);
    expect(recB.remoteSdpSummary).toBeTruthy();
    expect(recB.remoteSdpSummary.mLines).toBeGreaterThanOrEqual(1);
  });

  test('getSdp() returns full local/remote SDP strings', async ({ page }) => {
    const { connectionIdA } = await page.evaluate(() => window.testHelpers.createLoopbackSession());
    const sdp = await page.evaluate((id) => window.__webrtcInspector.getSdp(id), connectionIdA);
    expect(sdp.local).toBeTruthy();
    expect(typeof sdp.local.sdp).toBe('string');
    expect(sdp.local.sdp.length).toBeGreaterThan(0);
  });

  test('logs an addTransceiver call and its local track', async ({ page }) => {
    const { connectionIdA } = await page.evaluate(async () => {
      const { connectionIdA } = await window.testHelpers.createLoopbackSession();
      await window.__webrtcInspector.setFakeCam({ width: 64, height: 48 });
      const stream = await navigator.mediaDevices.getUserMedia({ video: true });
      window.__pcA.addTransceiver(stream.getVideoTracks()[0], { direction: 'sendonly' });
      return { connectionIdA };
    });
    const snap = await page.evaluate(() => window.__webrtcInspector.getSnapshot());
    const recA = snap.connections.find((c) => c.id === connectionIdA);
    expect(recA.localTracks.some((t) => t.kind === 'video' && t.sourceTag === 'fake-cam')).toBe(true);
  });

  test('addTrack tags the local track with its getUserMedia source', async ({ page }) => {
    const { connectionIdA } = await page.evaluate(async () => {
      const { connectionIdA } = await window.testHelpers.createLoopbackSession();
      await window.__webrtcInspector.setFakeMic(window.__SILENT_WAV);
      const stream = await navigator.mediaDevices.getUserMedia({ audio: true });
      stream.getTracks().forEach((t) => window.__pcA.addTrack(t, stream));
      return { connectionIdA };
    });
    const snap = await page.evaluate(() => window.__webrtcInspector.getSnapshot());
    const recA = snap.connections.find((c) => c.id === connectionIdA);
    expect(recA.localTracks.some((t) => t.sourceTag === 'fake-mic')).toBe(true);
  });

  test('promotes qualityLimitationReason onto a sending video track', async ({ page }) => {
    const { connectionIdA, trackId } = await page.evaluate(async () => {
      await window.__webrtcInspector.setFakeCam({ width: 64, height: 48 });
      const stream = await navigator.mediaDevices.getUserMedia({ video: true });
      const trackId = stream.getVideoTracks()[0].id;
      const { connectionIdA } = await window.testHelpers.createLoopbackSession('test-channel', (pcA) => {
        pcA.addTrack(stream.getVideoTracks()[0], stream);
      });
      return { connectionIdA, trackId };
    });
    await page.waitForFunction(
      ({ id, trackId }) => {
        const rec = window.__webrtcInspector.getSnapshot().connections.find((c) => c.id === id);
        const track = rec && rec.localTracks.find((t) => t.trackId === trackId);
        return !!track && track.qualityLimitationReason !== null;
      },
      { id: connectionIdA, trackId },
      { timeout: 3000 }
    );
    const snap = await page.evaluate(() => window.__webrtcInspector.getSnapshot());
    const recA = snap.connections.find((c) => c.id === connectionIdA);
    const track = recA.localTracks.find((t) => t.trackId === trackId);
    expect(track.qualityLimitationReason).toBe('none');
  });

  test('leaves qualityLimitationReason null for an audio-only track', async ({ page }) => {
    const { connectionIdA, trackId } = await page.evaluate(async () => {
      await window.__webrtcInspector.setFakeMic(window.__SILENT_WAV);
      const stream = await navigator.mediaDevices.getUserMedia({ audio: true });
      const trackId = stream.getAudioTracks()[0].id;
      const { connectionIdA } = await window.testHelpers.createLoopbackSession('test-channel', (pcA) => {
        pcA.addTrack(stream.getAudioTracks()[0], stream);
      });
      return { connectionIdA, trackId };
    });
    await page.waitForFunction(
      (id) => window.__webrtcInspector.getSnapshot().connections.find((c) => c.id === id).latestStats !== null,
      connectionIdA,
      { timeout: 3000 }
    );
    const snap = await page.evaluate(() => window.__webrtcInspector.getSnapshot());
    const recA = snap.connections.find((c) => c.id === connectionIdA);
    const track = recA.localTracks.find((t) => t.trackId === trackId);
    expect(track.qualityLimitationReason).toBeNull();
  });
});
