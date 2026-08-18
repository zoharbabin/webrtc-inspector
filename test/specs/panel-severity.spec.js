const { test, expect } = require('@playwright/test');
const { connectionSeverityRank, sortConnectionsBySeverity } = require('../../extension/panel-severity.js');

// Bad-state-first connection sorting (#36) — plain Node-executed, no
// browser needed (mirrors panel-timeline.spec.js/panel-theme.spec.js).
// connectionSeverityRank()/sortConnectionsBySeverity() are the pure logic
// panel.js applies to getSnapshot()'s connections before rendering.

function conn(id, connectionState, iceConnectionState, closed) {
  return { id, closed: !!closed, state: { connectionState, iceConnectionState } };
}

test.describe('connectionSeverityRank()', () => {
  test('ranks failed worse than disconnected worse than closed worse than healthy', () => {
    const failed = connectionSeverityRank(conn(1, 'failed', 'failed'));
    const disconnected = connectionSeverityRank(conn(2, 'disconnected', 'disconnected'));
    const closed = connectionSeverityRank(conn(3, 'closed', 'closed'));
    const connecting = connectionSeverityRank(conn(4, 'connecting', 'checking'));
    const healthy = connectionSeverityRank(conn(5, 'connected', 'connected'));
    expect(failed).toBeLessThan(disconnected);
    expect(disconnected).toBeLessThan(closed);
    expect(closed).toBeLessThan(connecting);
    expect(connecting).toBeLessThan(healthy);
  });

  test('takes the worse of connectionState/iceConnectionState when they disagree', () => {
    expect(connectionSeverityRank(conn(1, 'connected', 'failed')))
      .toBe(connectionSeverityRank(conn(2, 'failed', 'failed')));
  });

  test('an unknown/future state value ranks as neutral (same as connecting)', () => {
    expect(connectionSeverityRank(conn(1, 'some-future-state', 'some-future-state')))
      .toBe(connectionSeverityRank(conn(2, 'connecting', 'connecting')));
  });

  test('a connection flagged closed ranks at least as bad as "closed" even if its state fields say otherwise', () => {
    const rank = connectionSeverityRank(conn(1, 'connected', 'connected', true));
    expect(rank).toBe(connectionSeverityRank(conn(2, 'closed', 'closed')));
  });
});

test.describe('sortConnectionsBySeverity()', () => {
  test('surfaces failed/disconnected/closed connections ahead of healthy ones', () => {
    const connections = [
      conn(1, 'connected', 'connected'),
      conn(2, 'failed', 'failed'),
      conn(3, 'connecting', 'checking'),
      conn(4, 'disconnected', 'disconnected'),
    ];
    expect(sortConnectionsBySeverity(connections).map((c) => c.id)).toEqual([2, 4, 3, 1]);
  });

  test('is a stable sort — ties keep their original relative (insertion) order', () => {
    const connections = [
      conn(1, 'connected', 'connected'),
      conn(2, 'connected', 'connected'),
      conn(3, 'failed', 'failed'),
      conn(4, 'connected', 'connected'),
    ];
    expect(sortConnectionsBySeverity(connections).map((c) => c.id)).toEqual([3, 1, 2, 4]);
  });

  test('does not mutate the input array', () => {
    const connections = [conn(1, 'connected', 'connected'), conn(2, 'failed', 'failed')];
    const original = [...connections];
    sortConnectionsBySeverity(connections);
    expect(connections).toEqual(original);
  });

  test('returns an empty array unchanged', () => {
    expect(sortConnectionsBySeverity([])).toEqual([]);
  });
});
