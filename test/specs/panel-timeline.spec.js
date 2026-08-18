const { test, expect } = require('@playwright/test');
const { buildTimelineLanes, timelineOffsetPct } = require('../../extension/panel-timeline.js');

// Pure timeline/waterfall shaping for the DevTools panel (#34) — plain
// Node-executed, no browser needed (mirrors panel-sparkline.spec.js).

test.describe('buildTimelineLanes()', () => {
  test('returns no lanes for an empty or undefined log', () => {
    expect(buildTimelineLanes([])).toEqual({ lanes: [], minTs: null, maxTs: null });
    expect(buildTimelineLanes(undefined)).toEqual({ lanes: [], minTs: null, maxTs: null });
  });

  test('drops non-lifecycle event types (e.g. per-message events) entirely', () => {
    const { lanes } = buildTimelineLanes([
      { type: 'datachannel-message', connectionId: 1, ts: 100, preview: 'hi' },
      { type: 'ice-candidate-local', connectionId: 1, ts: 100 },
    ]);
    expect(lanes).toEqual([]);
  });

  test('groups lifecycle events into a pc# lane by connectionId and a ws# lane by socketId', () => {
    const { lanes } = buildTimelineLanes([
      { type: 'pc-created', connectionId: 1, ts: 100 },
      { type: 'websocket-created', socketId: 5, ts: 150 },
      { type: 'track-added', connectionId: 1, ts: 200 },
    ]);
    expect(lanes.map((l) => l.label)).toEqual(['pc#1', 'ws#5']);
    expect(lanes[0].events.map((e) => e.type)).toEqual(['pc-created', 'track-added']);
  });

  test('sorts each lane\'s events by timestamp, independent of log order', () => {
    const { lanes } = buildTimelineLanes([
      { type: 'connection-killed', connectionId: 1, ts: 300 },
      { type: 'pc-created', connectionId: 1, ts: 100 },
    ]);
    expect(lanes[0].events.map((e) => e.ts)).toEqual([100, 300]);
  });

  test('tags each event with its lifecycle category', () => {
    const { lanes } = buildTimelineLanes([
      { type: 'pc-created', connectionId: 1, ts: 100 },
      { type: 'websocket-error', socketId: 2, ts: 100 },
    ]);
    const categories = lanes.flatMap((l) => l.events.map((e) => e.category));
    expect(categories).toEqual(expect.arrayContaining(['open', 'error']));
  });

  test('computes minTs/maxTs across all included lifecycle events', () => {
    const { minTs, maxTs } = buildTimelineLanes([
      { type: 'pc-created', connectionId: 1, ts: 100 },
      { type: 'connection-killed', connectionId: 1, ts: 900 },
    ]);
    expect(minTs).toBe(100);
    expect(maxTs).toBe(900);
  });
});

test.describe('timelineOffsetPct()', () => {
  test('places the earliest event at 0% and the latest at 100%', () => {
    expect(timelineOffsetPct(100, 100, 900)).toBe(0);
    expect(timelineOffsetPct(900, 100, 900)).toBe(100);
  });

  test('interpolates linearly between minTs and maxTs', () => {
    expect(timelineOffsetPct(500, 100, 900)).toBe(50);
  });

  test('returns 0 when every event shares the same timestamp (no division by zero)', () => {
    expect(timelineOffsetPct(100, 100, 100)).toBe(0);
  });
});
