const { test, expect } = require('@playwright/test');

// SDP is settable directly by page JS (pc.setRemoteDescription(anyString)) —
// unlike ICE candidate type (a fixed \w+ enum), the codec name panel.js
// displays comes straight from the SDP text via a \S+ regex in
// core/webrtc-inspector.js's summarizeSdp(), with no character restriction.
// Every other page-controllable field in panel.js goes through escapeHtml()
// before landing in innerHTML; codecs and sourceTag previously didn't —
// this would have let a crafted remote SDP or a future custom sourceTag
// execute markup inside the DevTools panel's own extension-privileged page.

const CHROME_STUB = `
  window.chrome = {
    devtools: {
      panels: { themeName: 'dark', onThemeChanged: { addListener: () => {} } },
      network: { onNavigated: { addListener: () => {} } },
      inspectedWindow: { eval: (expr, cb) => cb(null, false) },
    },
  };
`;

function fakeSnapshot(overrides) {
  return {
    connections: [{
      id: 1,
      closed: false,
      state: { connectionState: 'connected', iceConnectionState: 'connected' },
      localTracks: [],
      remoteTracks: [],
      dataChannels: [],
      localSdpSummary: null,
      remoteSdpSummary: null,
      localCandidateTypes: [],
      remoteCandidateTypes: [],
      latestStats: null,
      ...overrides,
    }],
    webSockets: [],
    fakeMicActive: false,
    fakeCamActive: false,
    dataChannelInterceptorActive: false,
    webSocketInterceptorActive: false,
    activeOutages: [],
  };
}

test.describe('panel.js HTML-injection safety', () => {
  test.beforeEach(async ({ page }) => {
    await page.addInitScript(CHROME_STUB);
    await page.goto('/extension/panel.html');
  });

  test('a malicious codec name in remote SDP summary renders as text, not markup', async ({ page }) => {
    const payload = '<img src=x onerror="window.__xssFired = true">';
    await page.evaluate((snap) => window.renderSnapshot(snap), fakeSnapshot({
      remoteSdpSummary: { mLines: 1, codecs: [payload], byteLength: 100 },
    }));
    const fired = await page.evaluate(() => window.__xssFired);
    expect(fired).toBeUndefined();
    const imgCount = await page.locator('#connections img').count();
    expect(imgCount).toBe(0);
    expect(await page.locator('#connections').innerText()).toContain(payload);
  });

  test('a malicious codec name in local SDP summary renders as text, not markup', async ({ page }) => {
    const payload = '<img src=x onerror="window.__xssFired = true">';
    await page.evaluate((snap) => window.renderSnapshot(snap), fakeSnapshot({
      localSdpSummary: { mLines: 1, codecs: [payload], byteLength: 100 },
    }));
    const fired = await page.evaluate(() => window.__xssFired);
    expect(fired).toBeUndefined();
    expect(await page.locator('#connections img').count()).toBe(0);
  });

  test('a malicious sourceTag on a local track renders as text, not markup', async ({ page }) => {
    const payload = '<img src=x onerror="window.__xssFired = true">';
    await page.evaluate((snap) => window.renderSnapshot(snap), fakeSnapshot({
      localTracks: [{ kind: 'video', sourceTag: payload, status: 'live' }],
    }));
    const fired = await page.evaluate(() => window.__xssFired);
    expect(fired).toBeUndefined();
    expect(await page.locator('#connections img').count()).toBe(0);
  });
});
