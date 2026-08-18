const { test, expect } = require('@playwright/test');
const {
  shouldCaptureEvent,
  isReconnectTransition,
  nextPrevStateByConnection,
  selectCaptureTargets,
} = require('../../extension/panel-screenshot.js');

// Screenshot-capture trigger logic (#38) — plain Node-executed, no browser
// or chrome.tabs mock needed (mirrors panel-severity.spec.js/panel-filter.spec.js).
// This only covers "does this event qualify for a capture" — the actual
// chrome.tabs.captureVisibleTab call lives in panel.js and isn't exercised here.

test.describe('shouldCaptureEvent()', () => {
  test('captures connection-created, track-added, track-received, ice-restart', () => {
    const state = new Map();
    ['pc-created', 'track-added', 'track-received', 'ice-restart'].forEach((type) => {
      expect(shouldCaptureEvent({ type, connectionId: 1 }, state)).toBe(true);
    });
  });

  test('does not capture unrelated event types', () => {
    const state = new Map();
    ['ice-candidate-local', 'datachannel-message', 'websocket-open', 'signaling-state'].forEach((type) => {
      expect(shouldCaptureEvent({ type, connectionId: 1 }, state)).toBe(false);
    });
  });

  test('does not capture a plain connection-state/ice-state entry with no prior down state', () => {
    const state = new Map();
    expect(shouldCaptureEvent({ type: 'connection-state', connectionId: 1, state: 'connected' }, state)).toBe(false);
  });
});

test.describe('isReconnectTransition()', () => {
  test('recognizes recovery to connected/completed after a prior failed/disconnected state, per connection', () => {
    const state = new Map([[1, 'failed']]);
    expect(isReconnectTransition({ type: 'connection-state', connectionId: 1, state: 'connected' }, state)).toBe(true);
    expect(isReconnectTransition({ type: 'ice-state', connectionId: 1, state: 'completed' }, new Map([[1, 'disconnected']]))).toBe(true);
  });

  test('does not flag a different connection\'s history as a reconnect', () => {
    const state = new Map([[1, 'failed']]);
    expect(isReconnectTransition({ type: 'connection-state', connectionId: 2, state: 'connected' }, state)).toBe(false);
  });

  test('ignores non-state event types entirely', () => {
    const state = new Map([[1, 'failed']]);
    expect(isReconnectTransition({ type: 'track-added', connectionId: 1, state: 'connected' }, state)).toBe(false);
  });
});

test.describe('nextPrevStateByConnection()', () => {
  test('records connection-state/ice-state entries per connection id', () => {
    let state = new Map();
    state = nextPrevStateByConnection(state, { type: 'connection-state', connectionId: 1, state: 'checking' });
    state = nextPrevStateByConnection(state, { type: 'ice-state', connectionId: 2, state: 'failed' });
    expect(state.get(1)).toBe('checking');
    expect(state.get(2)).toBe('failed');
  });

  test('leaves the map untouched (and does not mutate it) for other event types', () => {
    const state = new Map([[1, 'connected']]);
    const next = nextPrevStateByConnection(state, { type: 'track-added', connectionId: 1 });
    expect(next).toBe(state);
    expect(next.get(1)).toBe('connected');
  });
});

test.describe('selectCaptureTargets()', () => {
  test('captures pc-created and the later reconnect, in order, tracking state across the batch', () => {
    const entries = [
      { seq: 1, type: 'pc-created', connectionId: 1 },
      { seq: 2, type: 'connection-state', connectionId: 1, state: 'failed' },
      { seq: 3, type: 'connection-state', connectionId: 1, state: 'connected' },
    ];
    const { targets, state } = selectCaptureTargets(entries, new Map());
    expect(targets.map((e) => e.seq)).toEqual([1, 3]);
    expect(state.get(1)).toBe('connected');
  });

  test('carries the connection-state map forward across separate calls (batches from separate polls)', () => {
    const first = selectCaptureTargets(
      [{ seq: 1, type: 'connection-state', connectionId: 1, state: 'failed' }],
      new Map(),
    );
    const second = selectCaptureTargets(
      [{ seq: 2, type: 'connection-state', connectionId: 1, state: 'connected' }],
      first.state,
    );
    expect(second.targets.map((e) => e.seq)).toEqual([2]);
  });

  test('returns no targets for an empty batch', () => {
    const { targets } = selectCaptureTargets([], new Map());
    expect(targets).toEqual([]);
  });
});
