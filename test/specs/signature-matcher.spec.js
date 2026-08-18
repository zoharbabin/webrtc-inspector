const { test, expect } = require('@playwright/test');
const {
  matchSignatures,
  detectMissedHeartbeatReconnectGap,
  detectAbruptCloseWithoutRecovery,
} = require('../../extension/signature-matcher.js');

// Anomaly/signature pattern-matching over a captured session (#29) —
// plain Node-executed, no browser needed (mirrors metrics-exporter.spec.js
// and scenario-compiler.spec.js). Events below are hand-built minimal
// {type, ts, seq, ...} records matching the shapes captureEvents()/
// exportBundle() actually produce.

function wsMsg(seq, ts, socketId, dir) {
  return { type: 'websocket-message', seq, ts, socketId, dir };
}
function wsClose(seq, ts, socketId) {
  return { type: 'websocket-close', seq, ts, socketId };
}
function wsCreated(seq, ts, socketId) {
  return { type: 'websocket-created', seq, ts, socketId };
}
function dcMsg(seq, ts, connectionId, dir) {
  return { type: 'datachannel-message', seq, ts, connectionId, dir };
}
function connKilled(seq, ts, connectionId) {
  return { type: 'connection-killed', seq, ts, connectionId };
}
function connState(seq, ts, connectionId, state) {
  return { type: 'connection-state', seq, ts, connectionId, state };
}
function pcCreated(seq, ts, connectionId) {
  return { type: 'pc-created', seq, ts, connectionId };
}

test.describe('detectMissedHeartbeatReconnectGap()', () => {
  test('flags 3+ consecutive unanswered outgoing WebSocket sends followed by a close within the window', () => {
    const events = [
      wsMsg(1, 0, 1, 'out'),
      wsMsg(2, 100, 1, 'out'),
      wsMsg(3, 200, 1, 'out'),
      wsClose(4, 300, 1),
    ];
    const findings = detectMissedHeartbeatReconnectGap(events);
    expect(findings).toEqual([{
      signature: 'missed-heartbeat-reconnect-gap',
      scopeKey: 'socketId',
      scopeId: 1,
      missedCount: 3,
      firstMissedSeq: 1,
      closeSeq: 4,
      description: '3 consecutive unanswered outgoing WebSocket messages on socketId 1, then websocket-close — looks like a missed-heartbeat reconnect gap.',
    }]);
  });

  test('does not flag when an incoming message resets the unanswered count before the close', () => {
    const events = [
      wsMsg(1, 0, 1, 'out'),
      wsMsg(2, 100, 1, 'out'),
      wsMsg(3, 200, 1, 'in'),
      wsMsg(4, 300, 1, 'out'),
      wsClose(5, 400, 1),
    ];
    expect(detectMissedHeartbeatReconnectGap(events)).toEqual([]);
  });

  test('does not flag when the close happens outside the time window', () => {
    const events = [
      wsMsg(1, 0, 1, 'out'),
      wsMsg(2, 100, 1, 'out'),
      wsMsg(3, 200, 1, 'out'),
      wsClose(4, 50000, 1),
    ];
    expect(detectMissedHeartbeatReconnectGap(events, { windowMs: 10000 })).toEqual([]);
  });

  test('respects a custom minConsecutive', () => {
    const events = [wsMsg(1, 0, 1, 'out'), wsMsg(2, 100, 1, 'out'), wsClose(3, 200, 1)];
    expect(detectMissedHeartbeatReconnectGap(events, { minConsecutive: 3 })).toEqual([]);
    expect(detectMissedHeartbeatReconnectGap(events, { minConsecutive: 2 })).toHaveLength(1);
  });

  test('applies the same pattern to datachannel-message + connection-killed, scoped by connectionId', () => {
    const events = [
      dcMsg(1, 0, 7, 'out'),
      dcMsg(2, 100, 7, 'out'),
      dcMsg(3, 200, 7, 'out'),
      connKilled(4, 300, 7),
    ];
    const findings = detectMissedHeartbeatReconnectGap(events);
    expect(findings).toEqual([{
      signature: 'missed-heartbeat-reconnect-gap',
      scopeKey: 'connectionId',
      scopeId: 7,
      missedCount: 3,
      firstMissedSeq: 1,
      closeSeq: 4,
      description: '3 consecutive unanswered outgoing data-channel messages on connectionId 7, then connection-killed — looks like a missed-heartbeat reconnect gap.',
    }]);
  });
});

test.describe('detectAbruptCloseWithoutRecovery()', () => {
  test('flags a websocket-close with no new websocket-created within the window', () => {
    const events = [wsClose(1, 0, 1)];
    const findings = detectAbruptCloseWithoutRecovery(events, { windowMs: 5000 });
    expect(findings).toEqual([{
      signature: 'abrupt-close-without-recovery',
      scopeKey: 'socketId',
      scopeId: 1,
      eventSeq: 1,
      description: 'websocket-close on socketId 1 with no reconnect attempt or recovery within 5000ms.',
    }]);
  });

  test('does not flag when a new websocket is created within the window (reconnect)', () => {
    const events = [wsClose(1, 0, 1), wsCreated(2, 1000, 2)];
    expect(detectAbruptCloseWithoutRecovery(events, { windowMs: 5000 })).toEqual([]);
  });

  test('does not flag a connection-state failure that self-heals back to connected on the same connection', () => {
    const events = [connState(1, 0, 7, 'failed'), connState(2, 1000, 7, 'connected')];
    expect(detectAbruptCloseWithoutRecovery(events, { windowMs: 5000 })).toEqual([]);
  });

  test('flags a connection-state failure that never recovers within the window', () => {
    const events = [connState(1, 0, 7, 'failed'), connState(2, 20000, 7, 'connected')];
    const findings = detectAbruptCloseWithoutRecovery(events, { windowMs: 5000 });
    expect(findings).toEqual([{
      signature: 'abrupt-close-without-recovery',
      scopeKey: 'connectionId',
      scopeId: 7,
      eventSeq: 1,
      description: 'connection-state (failed) on connectionId 7 with no reconnect attempt or recovery within 5000ms.',
    }]);
  });
});

test.describe('matchSignatures()', () => {
  test('accepts a plain events array', () => {
    const events = [wsMsg(1, 0, 1, 'out'), wsMsg(2, 100, 1, 'out'), wsMsg(3, 200, 1, 'out'), wsClose(4, 300, 1)];
    expect(matchSignatures(events)).toHaveLength(2); // heartbeat-gap + abrupt-close both fire on the same close
  });

  test('accepts a captureEvents()-shaped {events} object', () => {
    const capture = { capturedAt: 123, events: [pcCreated(1, 0, 1), connKilled(2, 100, 1)] };
    expect(matchSignatures(capture)).toEqual([{
      signature: 'abrupt-close-without-recovery',
      scopeKey: 'connectionId',
      scopeId: 1,
      eventSeq: 2,
      description: 'connection-killed on connectionId 1 with no reconnect attempt or recovery within 10000ms.',
    }]);
  });

  test('accepts an exportBundle()-shaped {fullLog} object', () => {
    const bundle = { exportedAt: 123, fullLog: [pcCreated(1, 0, 1), connKilled(2, 100, 1)] };
    expect(matchSignatures(bundle)).toHaveLength(1);
  });

  test('returns no findings for an empty/unrecognized capture', () => {
    expect(matchSignatures({})).toEqual([]);
  });
});
