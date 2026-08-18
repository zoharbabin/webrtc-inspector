const { test, expect } = require('@playwright/test');
const { parseFilterQuery, filterLogEntries, filterConnections, filterWebSockets } = require('../../extension/panel-filter.js');

// Filter/search bar (#32) — plain Node-executed, no browser needed (mirrors
// panel-timeline.spec.js/panel-theme.spec.js). These are the pure functions
// panel.js wires to the filter <input>'s 'input' event, re-filtering the
// last-received snapshot on every keystroke.

test.describe('parseFilterQuery()', () => {
  test('splits key:value tokens from free text', () => {
    expect(parseFilterQuery('type:websocket-message conn:3 dir:out hello world')).toEqual({
      text: ['hello', 'world'], type: 'websocket-message', conn: '3', dir: 'out',
    });
  });

  test('returns an all-free-text filter for a plain query', () => {
    expect(parseFilterQuery('foo bar')).toEqual({ text: ['foo', 'bar'] });
  });

  test('returns an empty filter for a blank/undefined query', () => {
    expect(parseFilterQuery('')).toEqual({ text: [] });
    expect(parseFilterQuery(undefined)).toEqual({ text: [] });
  });

  test('lowercases token values', () => {
    expect(parseFilterQuery('TYPE:Websocket-Message HELLO')).toEqual({ text: ['hello'], type: 'websocket-message' });
  });
});

const EVENTS = [
  { seq: 1, ts: 1, type: 'websocket-message', dir: 'out', socketId: 1, preview: 'ping' },
  { seq: 2, ts: 2, type: 'websocket-message', dir: 'in', socketId: 1, preview: 'pong' },
  { seq: 3, ts: 3, type: 'pc-created', connectionId: 5 },
  { seq: 4, ts: 4, type: 'connection-killed', connectionId: 5 },
];

test.describe('filterLogEntries()', () => {
  test('returns all entries unchanged for an empty filter', () => {
    expect(filterLogEntries(EVENTS, parseFilterQuery(''))).toEqual(EVENTS);
  });

  test('filters by type: substring match', () => {
    const result = filterLogEntries(EVENTS, parseFilterQuery('type:websocket'));
    expect(result.map((e) => e.seq)).toEqual([1, 2]);
  });

  test('filters by conn: matching either connectionId or socketId', () => {
    expect(filterLogEntries(EVENTS, parseFilterQuery('conn:5')).map((e) => e.seq)).toEqual([3, 4]);
    expect(filterLogEntries(EVENTS, parseFilterQuery('conn:1')).map((e) => e.seq)).toEqual([1, 2]);
  });

  test('filters by dir: exact match', () => {
    expect(filterLogEntries(EVENTS, parseFilterQuery('dir:out')).map((e) => e.seq)).toEqual([1]);
  });

  test('filters by free text against type/preview/ids', () => {
    expect(filterLogEntries(EVENTS, parseFilterQuery('ping')).map((e) => e.seq)).toEqual([1]);
    expect(filterLogEntries(EVENTS, parseFilterQuery('killed')).map((e) => e.seq)).toEqual([4]);
  });

  test('combines multiple tokens with AND semantics', () => {
    expect(filterLogEntries(EVENTS, parseFilterQuery('type:websocket dir:in')).map((e) => e.seq)).toEqual([2]);
  });
});

const CONNECTIONS = [
  { id: 1, state: { connectionState: 'connected', iceConnectionState: 'connected' } },
  { id: 2, state: { connectionState: 'failed', iceConnectionState: 'disconnected' } },
];

test.describe('filterConnections()', () => {
  test('returns all connections unchanged for an empty filter', () => {
    expect(filterConnections(CONNECTIONS, parseFilterQuery(''))).toEqual(CONNECTIONS);
  });

  test('filters by conn: matching the connection id', () => {
    expect(filterConnections(CONNECTIONS, parseFilterQuery('conn:2'))).toEqual([CONNECTIONS[1]]);
  });

  test('filters by free text against id/state', () => {
    expect(filterConnections(CONNECTIONS, parseFilterQuery('failed'))).toEqual([CONNECTIONS[1]]);
  });

  test('returns nothing when a type: or dir: token is present (those only apply to log entries)', () => {
    expect(filterConnections(CONNECTIONS, parseFilterQuery('type:pc-created'))).toEqual([]);
    expect(filterConnections(CONNECTIONS, parseFilterQuery('dir:out'))).toEqual([]);
  });
});

const WEBSOCKETS = [
  { id: 1, state: 'open', url: 'wss://a.example/socket' },
  { id: 2, state: 'closed', url: 'wss://b.example/socket' },
];

test.describe('filterWebSockets()', () => {
  test('returns all websockets unchanged for an empty filter', () => {
    expect(filterWebSockets(WEBSOCKETS, parseFilterQuery(''))).toEqual(WEBSOCKETS);
  });

  test('filters by conn: matching the socket id', () => {
    expect(filterWebSockets(WEBSOCKETS, parseFilterQuery('conn:1'))).toEqual([WEBSOCKETS[0]]);
  });

  test('filters by free text against url/state', () => {
    expect(filterWebSockets(WEBSOCKETS, parseFilterQuery('b.example'))).toEqual([WEBSOCKETS[1]]);
  });
});
