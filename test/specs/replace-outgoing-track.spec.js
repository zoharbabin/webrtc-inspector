const { test, expect } = require('@playwright/test');
const { gotoFixture } = require('../helpers');

// replaceOutgoingTrack() rides RTCRtpSender.replaceTrack() — real tracks (via
// getUserMedia) are added so there's a genuine sender to swap, no mocking of
// RTCRtpSender itself.

test.describe('replaceOutgoingTrack()', () => {
  test.beforeEach(async ({ page }) => {
    await gotoFixture(page);
  });

  test('swaps the active video sender to a new track', async ({ page }) => {
    const result = await page.evaluate(async () => {
      await window.__webrtcInspector.setFakeCam({ width: 64, height: 48 });
      const { connectionIdA } = await window.testHelpers.createLoopbackSession('replace-track', async (pcA) => {
        const stream = await navigator.mediaDevices.getUserMedia({ video: true });
        pcA.addTrack(stream.getVideoTracks()[0], stream);
      });
      const newStream = await navigator.mediaDevices.getUserMedia({ video: true });
      const newTrack = newStream.getVideoTracks()[0];
      await window.__webrtcInspector.replaceOutgoingTrack(connectionIdA, 'video', newTrack);
      const sender = window.__pcA.getSenders().find((s) => s.track && s.track.kind === 'video');
      return { senderTrackId: sender.track.id, newTrackId: newTrack.id };
    });
    expect(result.senderTrackId).toBe(result.newTrackId);
  });

  test('emits track-replaced with the new track id and kind', async ({ page }) => {
    const result = await page.evaluate(async () => {
      await window.__webrtcInspector.setFakeCam({ width: 64, height: 48 });
      const { connectionIdA } = await window.testHelpers.createLoopbackSession('replace-track-event', async (pcA) => {
        const stream = await navigator.mediaDevices.getUserMedia({ video: true });
        pcA.addTrack(stream.getVideoTracks()[0], stream);
      });
      window.__events = [];
      window.__webrtcInspector.onEvent((e) => window.__events.push(e));
      const newStream = await navigator.mediaDevices.getUserMedia({ video: true });
      const newTrack = newStream.getVideoTracks()[0];
      await window.__webrtcInspector.replaceOutgoingTrack(connectionIdA, 'video', newTrack);
      const evt = window.__events.find((e) => e.type === 'track-replaced');
      return { evt, newTrackId: newTrack.id };
    });
    expect(result.evt).toBeDefined();
    expect(result.evt.kind).toBe('video');
    expect(result.evt.trackId).toBe(result.newTrackId);
  });

  test('throws for an unknown connection id', async ({ page }) => {
    const threw = await page.evaluate(async () => {
      const stream = await navigator.mediaDevices.getUserMedia({ video: true });
      try {
        await window.__webrtcInspector.replaceOutgoingTrack(999999, 'video', stream.getVideoTracks()[0]);
        return false;
      } catch {
        return true;
      }
    });
    expect(threw).toBe(true);
  });

  test('throws when there is no active sender of the requested kind', async ({ page }) => {
    const threw = await page.evaluate(async () => {
      const { connectionIdA } = await window.testHelpers.createLoopbackSession();
      const stream = await navigator.mediaDevices.getUserMedia({ video: true });
      try {
        await window.__webrtcInspector.replaceOutgoingTrack(connectionIdA, 'video', stream.getVideoTracks()[0]);
        return false;
      } catch {
        return true;
      }
    });
    expect(threw).toBe(true);
  });

  // Found via the real-LiveKit E2E suite (test/livekit/specs/track-replace-real.spec.js):
  // with two same-kind senders on one connection (e.g. camera + screen-share),
  // replaceOutgoingTrack had no way to pick which one — it always hit whichever
  // getSenders() returned first, silently leaving the other untouched. The
  // optional trackId disambiguator (from getSnapshot()'s localTracks[].trackId,
  // i.e. the currently-attached track on the sender to target) fixes this;
  // omitting it keeps the original first-match-by-kind behavior.
  test('trackId disambiguates which same-kind sender to replace when a connection has two', async ({ page }) => {
    const result = await page.evaluate(async () => {
      await window.__webrtcInspector.setFakeCam({ width: 64, height: 48 });
      const { connectionIdA } = await window.testHelpers.createLoopbackSession('replace-disambiguate', async (pcA) => {
        const streamA = await navigator.mediaDevices.getUserMedia({ video: true });
        const streamB = await navigator.mediaDevices.getUserMedia({ video: true });
        pcA.addTrack(streamA.getVideoTracks()[0], streamA);
        pcA.addTrack(streamB.getVideoTracks()[0], streamB);
        window.__firstVideoTrackId = streamA.getVideoTracks()[0].id;
        window.__secondVideoTrackId = streamB.getVideoTracks()[0].id;
      });
      const newStream = await navigator.mediaDevices.getUserMedia({ video: true });
      const newTrack = newStream.getVideoTracks()[0];
      await window.__webrtcInspector.replaceOutgoingTrack(
        connectionIdA, 'video', newTrack, window.__secondVideoTrackId
      );
      const senderTrackIds = window.__pcA.getSenders()
        .filter((s) => s.track && s.track.kind === 'video')
        .map((s) => s.track.id);
      return {
        senderTrackIds,
        newTrackId: newTrack.id,
        firstVideoTrackId: window.__firstVideoTrackId,
      };
    });
    // The untargeted sender (originally streamA's track) must still be
    // exactly that track — untouched by the swap.
    expect(result.senderTrackIds).toContain(result.firstVideoTrackId);
    // The targeted sender now carries the new track.
    expect(result.senderTrackIds).toContain(result.newTrackId);
  });
});
