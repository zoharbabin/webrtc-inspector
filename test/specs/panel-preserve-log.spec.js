const { test, expect } = require('@playwright/test');
const { bufferGeneration, mergeSnapshotForRender, MAX_GENERATIONS } = require('../../extension/panel-preserve-log.js');

// Preserve-log toggle (#31) — plain Node-executed, no browser needed
// (mirrors panel-timeline.spec.js/panel-theme.spec.js). bufferGeneration()
// and mergeSnapshotForRender() are the pure logic panel.js wires to
// chrome.devtools.network.onNavigated and the live getSnapshot() poll.

function snap(overrides) {
  return {
    connections: [{ id: 1, closed: false }],
    webSockets: [{ id: 1, state: 'open' }],
    recentLog: [{ ts: 100, type: 'pc-created' }],
    ...overrides,
  };
}

test.describe('bufferGeneration()', () => {
  test('appends a history entry tagged with the given generation', () => {
    const { history, droppedCount } = bufferGeneration([], snap(), 0);
    expect(history).toEqual([{ gen: 0, connections: snap().connections, webSockets: snap().webSockets, recentLog: snap().recentLog }]);
    expect(droppedCount).toBe(0);
  });

  test('returns the history unchanged with no drop when snap is null (nothing polled yet)', () => {
    const history = [{ gen: 0, connections: [], webSockets: [], recentLog: [] }];
    const result = bufferGeneration(history, null, 1);
    expect(result.history).toBe(history);
    expect(result.droppedCount).toBe(0);
  });

  test(`caps history at ${MAX_GENERATIONS} generations, reporting how many were dropped`, () => {
    let history = [];
    for (let gen = 0; gen < MAX_GENERATIONS + 2; gen++) {
      history = bufferGeneration(history, snap(), gen).history;
    }
    const { history: finalHistory, droppedCount } = bufferGeneration(history, snap(), MAX_GENERATIONS + 2);
    expect(finalHistory.length).toBe(MAX_GENERATIONS);
    expect(finalHistory[0].gen).toBe(3);
    expect(droppedCount).toBe(1);
  });
});

test.describe('mergeSnapshotForRender()', () => {
  test('returns the live snapshot unchanged when preserveLog is off', () => {
    const history = [{ gen: 0, connections: [{ id: 9 }], webSockets: [], recentLog: [] }];
    expect(mergeSnapshotForRender(history, snap(), false)).toEqual(snap());
  });

  test('returns the live snapshot unchanged when there is no buffered history', () => {
    expect(mergeSnapshotForRender([], snap(), true)).toEqual(snap());
  });

  test('passes through a null live snapshot untouched', () => {
    expect(mergeSnapshotForRender([{ gen: 0, connections: [], webSockets: [], recentLog: [] }], null, true)).toBeNull();
  });

  test('prepends stale, generation-tagged entries from history ahead of the live ones', () => {
    const history = [{ gen: 0, connections: [{ id: 9 }], webSockets: [{ id: 5 }], recentLog: [{ ts: 1, type: 'pc-created' }] }];
    const merged = mergeSnapshotForRender(history, snap(), true);
    expect(merged.connections).toEqual([{ id: 9, _gen: 0, _stale: true }, { id: 1, closed: false }]);
    expect(merged.webSockets).toEqual([{ id: 5, _gen: 0, _stale: true }, { id: 1, state: 'open' }]);
    expect(merged.recentLog).toEqual([{ ts: 1, type: 'pc-created', _gen: 0, _stale: true }, { ts: 100, type: 'pc-created' }]);
  });

  test('merges multiple generations in order, oldest first', () => {
    const history = [
      { gen: 0, connections: [{ id: 1 }], webSockets: [], recentLog: [] },
      { gen: 1, connections: [{ id: 2 }], webSockets: [], recentLog: [] },
    ];
    const merged = mergeSnapshotForRender(history, snap({ connections: [{ id: 3 }] }), true);
    expect(merged.connections.map((c) => c.id)).toEqual([1, 2, 3]);
    expect(merged.connections[0]._gen).toBe(0);
    expect(merged.connections[1]._gen).toBe(1);
  });
});
