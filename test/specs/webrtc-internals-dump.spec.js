const { test, expect } = require('@playwright/test');
const { gotoFixture } = require('../helpers');

// exportWebrtcInternalsDump() matches the JSON shape chrome://webrtc-internals'
// "Create Dump" produces (see #20), verified against the still-maintained
// rtcstats/rtcstats dump-importer's parser (import-internals.js /
// packages/rtcstats-shared/timeseries.js): {UserAgent, getUserMedia,
// PeerConnections: {<id>: {url, rtcConfiguration, updateLog, stats}}}, where
// `stats` is a flat `<statId>-<property>` map of {statsType, values} with
// `values` a JSON-stringified array index-aligned to that stat's own
// `<statId>-timestamp` entry.

test.describe('exportWebrtcInternalsDump()', () => {
  test.beforeEach(async ({ page }) => {
    await gotoFixture(page);
  });

  test('returns a JSON-serializable dump with one PeerConnections entry per connection', async ({ page }) => {
    const dump = await page.evaluate(async () => {
      await window.testHelpers.createLoopbackSession();
      return JSON.parse(JSON.stringify(window.__webrtcInspector.exportWebrtcInternalsDump()));
    });
    expect(typeof dump.UserAgent).toBe('string');
    expect(dump.UserAgent.length).toBeGreaterThan(0);
    expect(dump.getUserMedia).toEqual([]);
    const ids = Object.keys(dump.PeerConnections);
    expect(ids.length).toBe(2);
    ids.forEach((id) => {
      const pc = dump.PeerConnections[id];
      expect(typeof pc.url).toBe('string');
      expect(pc.rtcConfiguration === null || typeof pc.rtcConfiguration === 'object').toBe(true);
      expect(Array.isArray(pc.updateLog)).toBe(true);
      expect(typeof pc.stats).toBe('object');
    });
  });

  test('updateLog translates known event types to webrtc-internals names with plain-string state values', async ({ page }) => {
    const updateLog = await page.evaluate(async () => {
      const { connectionIdA } = await window.testHelpers.createLoopbackSession();
      return window.__webrtcInspector.exportWebrtcInternalsDump().PeerConnections[connectionIdA].updateLog;
    });
    const iceEvent = updateLog.find((e) => e.type === 'iceconnectionstatechange');
    expect(iceEvent).toBeDefined();
    expect(typeof iceEvent.value).toBe('string');
    expect(() => JSON.parse(iceEvent.value)).toThrow();
    expect(typeof iceEvent.timestamp).toBe('number');
  });

  test('setLocalDescription/setRemoteDescription entries carry {type, sdp} matching getSdp()', async ({ page }) => {
    const result = await page.evaluate(async () => {
      const { connectionIdA } = await window.testHelpers.createLoopbackSession();
      const updateLog = window.__webrtcInspector.exportWebrtcInternalsDump().PeerConnections[connectionIdA].updateLog;
      const sdp = window.__webrtcInspector.getSdp(connectionIdA);
      return { updateLog, sdp };
    });
    const localEvent = result.updateLog.find((e) => e.type === 'setLocalDescription');
    expect(localEvent).toBeDefined();
    const parsed = JSON.parse(localEvent.value);
    expect(parsed.type).toBe(result.sdp.local.type);
    expect(parsed.sdp).toBe(result.sdp.local.sdp);
  });

  test('unmapped event types pass through under their own type name with a JSON value', async ({ page }) => {
    const updateLog = await page.evaluate(async () => {
      const { connectionIdA } = await window.testHelpers.createLoopbackSession();
      return window.__webrtcInspector.exportWebrtcInternalsDump().PeerConnections[connectionIdA].updateLog;
    });
    const dcEvent = updateLog.find((e) => e.type === 'datachannel-opened');
    expect(dcEvent).toBeDefined();
    expect(() => JSON.parse(dcEvent.value)).not.toThrow();
    expect(JSON.parse(dcEvent.value).label).toBeDefined();
  });

  test('stats: each statId has a -timestamp entry and every property array is index-aligned to it', async ({ page }) => {
    const stats = await page.evaluate(async () => {
      const { connectionIdA } = await window.testHelpers.createLoopbackSession();
      await window.testHelpers.wait(4200); // >= 2 stats-polling ticks (2s interval)
      return window.__webrtcInspector.exportWebrtcInternalsDump().PeerConnections[connectionIdA].stats;
    });
    const statIds = new Set(Object.keys(stats).map((k) => k.replace(/-[^-]+$/, '')));
    expect(statIds.size).toBeGreaterThan(0);
    statIds.forEach((statId) => {
      const timestamps = JSON.parse(stats[`${statId}-timestamp`].values);
      expect(timestamps.length).toBeGreaterThanOrEqual(2);
      Object.keys(stats)
        .filter((k) => k.startsWith(`${statId}-`) && k !== `${statId}-timestamp`)
        .forEach((propKey) => {
          const values = JSON.parse(stats[propKey].values);
          expect(values.length).toBe(timestamps.length);
        });
    });
  });

  test('a candidate-pair stat exposes currentRoundTripTime with a real statsType', async ({ page }) => {
    const stats = await page.evaluate(async () => {
      const { connectionIdA } = await window.testHelpers.createLoopbackSession();
      await window.testHelpers.wait(2100);
      return window.__webrtcInspector.exportWebrtcInternalsDump().PeerConnections[connectionIdA].stats;
    });
    const rttKey = Object.keys(stats).find((k) => k.endsWith('-currentRoundTripTime'));
    expect(rttKey).toBeDefined();
    expect(stats[rttKey].statsType).toBe('candidate-pair');
    expect(Array.isArray(JSON.parse(stats[rttKey].values))).toBe(true);
  });
});
