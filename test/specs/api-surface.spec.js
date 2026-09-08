const { test, expect } = require('@playwright/test');
const { gotoFixture } = require('../helpers');

// Drift-detection assertion for the LiveKit E2E plan's coverage matrix
// (~/Downloads/webrtc-inspector-livekit-e2e-plan.md section 4/8): that plan
// maps every one of window.__webrtcInspector's public methods to either a
// real-LiveKit scenario or an explicit fixture-coverage reason, cited
// against this exact list. Needs no LiveKit infrastructure, so it lives in
// the fast, PR-blocking suite — a method addition/removal is caught on the
// PR that makes the change, not up to a day later on the nightly job.
const EXPECTED_METHODS = [
  'getSnapshot',
  'getSnapshotDiff',
  'exportBundle',
  'exportWebrtcInternalsDump',
  'captureEvents',
  'diffCaptures',
  'getEvents',
  'getSdp',
  'getTrackDiagnostics',
  'setFakeMic',
  'clearFakeMic',
  'injectAudio',
  'playIntoFakeMic',
  'getFakeMicTrack',
  'setFakeCam',
  'clearFakeCam',
  'getRemoteTrackStream',
  'replaceOutgoingTrack',
  'capEncoding',
  'injectDataChannelMessage',
  'setDataChannelInterceptor',
  'clearDataChannelInterceptor',
  'registerDecoder',
  'setSuggestDecoder',
  'clearSuggestDecoder',
  'setLabeler',
  'clearLabeler',
  'setIceCandidateFilter',
  'clearIceCandidateFilter',
  'setWebSocketInterceptor',
  'clearWebSocketInterceptor',
  'setMediaFaultInjector',
  'clearMediaFaultInjector',
  'injectWebSocketMessage',
  'sendOnWebSocket',
  'killConnection',
  'restartIce',
  'simulateNetworkLoss',
  'simulateNetworkPreset',
  'registerNetworkPreset',
  'onEvent',
  'clearLog',
];

test.describe('window.__webrtcInspector public API surface', () => {
  test('exposes exactly the 42 documented methods plus version, no more, no fewer', async ({ page }) => {
    await gotoFixture(page);
    const { methodNames, hasVersion } = await page.evaluate(() => {
      const api = window.__webrtcInspector;
      return {
        methodNames: Object.keys(api).filter((k) => typeof api[k] === 'function').sort(),
        hasVersion: typeof api.version === 'string',
      };
    });

    expect(hasVersion).toBe(true);
    expect(methodNames).toEqual([...EXPECTED_METHODS].sort());
    expect(methodNames.length).toBe(42);
  });
});
