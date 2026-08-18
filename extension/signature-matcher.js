// #29 — anomaly/signature pattern-matching over a captured event stream.
// A classification layer on top of #5's capture format (captureEvents() ->
// {capturedAt, events}, or exportBundle() -> {..., fullLog}): matches a
// captured session against a set of named signatures instead of requiring
// a manual read-through, so common failure modes get named rather than
// re-diagnosed from scratch every time.
//
// A signature is { name, match(events, opts) -> finding[] } — deliberately
// a function, not a static pattern list, since a signature like "N missed
// heartbeats then abrupt close" needs windowed/stateful reasoning a plain
// per-event predicate chain can't express. `events` is the flat,
// chronological event-log array this library already produces (each entry
// has at least {type, ts, seq}, plus connectionId/socketId/etc.
// depending on type).

function groupByScope(events, scopeKey) {
  const groups = new Map();
  events.forEach((e) => {
    const key = e[scopeKey];
    if (key == null) return;
    if (!groups.has(key)) groups.set(key, []);
    groups.get(key).push(e);
  });
  return groups;
}

// Signature: N consecutive outgoing messages on one socket/connection with
// no incoming reply in between, then that scope closes within windowMs of
// the first unanswered send. A generic proxy for "missed heartbeats then
// abrupt disconnect" that doesn't require parsing any particular app-level
// ping/pong protocol — the library has no visibility into message
// semantics, only direction and timing.
function detectMissedHeartbeatReconnectGap(events, opts) {
  const minConsecutive = (opts && opts.minConsecutive) || 3;
  const windowMs = (opts && opts.windowMs) || 10000;

  function scan(scopeKey, messageType, closeTypes) {
    const findings = [];
    groupByScope(events, scopeKey).forEach((scopedEvents, scopeId) => {
      let unanswered = 0;
      let firstUnanswered = null;
      scopedEvents.forEach((e) => {
        if (e.type === messageType && e.dir === 'out') {
          if (unanswered === 0) firstUnanswered = e;
          unanswered += 1;
        } else if (e.type === messageType && e.dir === 'in') {
          unanswered = 0;
          firstUnanswered = null;
        } else if (closeTypes.includes(e.type) && unanswered >= minConsecutive) {
          if (e.ts - firstUnanswered.ts <= windowMs) {
            findings.push({
              signature: 'missed-heartbeat-reconnect-gap',
              scopeKey,
              scopeId,
              missedCount: unanswered,
              firstMissedSeq: firstUnanswered.seq,
              closeSeq: e.seq,
              description: `${unanswered} consecutive unanswered outgoing ${messageType === 'websocket-message' ? 'WebSocket' : 'data-channel'} messages on ${scopeKey} ${scopeId}, then ${e.type} — looks like a missed-heartbeat reconnect gap.`,
            });
          }
          unanswered = 0;
          firstUnanswered = null;
        }
      });
    });
    return findings;
  }

  return [
    ...scan('socketId', 'websocket-message', ['websocket-close']),
    ...scan('connectionId', 'datachannel-message', ['connection-killed']),
  ];
}

// Signature: a terminal close/failure with no reconnect attempt (a new
// connection/socket created) or, for a recoverable connection-state
// transition, no recovery back to 'connected' on the same connection,
// within windowMs.
function detectAbruptCloseWithoutRecovery(events, opts) {
  const windowMs = (opts && opts.windowMs) || 10000;
  const findings = [];

  function isTerminalClose(e) {
    return e.type === 'connection-killed'
      || e.type === 'websocket-close'
      || (e.type === 'connection-state' && (e.state === 'failed' || e.state === 'disconnected'));
  }

  events.forEach((e) => {
    if (!isTerminalClose(e)) return;
    const scopeKey = e.connectionId != null ? 'connectionId' : 'socketId';
    const scopeId = e[scopeKey];
    const recovered = events.some((other) => {
      if (other.ts <= e.ts || other.ts - e.ts > windowMs) return false;
      if (other.type === 'pc-created' || other.type === 'websocket-created') return true;
      return scopeKey === 'connectionId' && other.connectionId === scopeId
        && other.type === 'connection-state' && other.state === 'connected';
    });
    if (!recovered) {
      findings.push({
        signature: 'abrupt-close-without-recovery',
        scopeKey,
        scopeId,
        eventSeq: e.seq,
        description: `${e.type}${e.state ? ` (${e.state})` : ''} on ${scopeKey} ${scopeId} with no reconnect attempt or recovery within ${windowMs}ms.`,
      });
    }
  });

  return findings;
}

const DEFAULT_SIGNATURES = [
  { name: 'missed-heartbeat-reconnect-gap', match: detectMissedHeartbeatReconnectGap },
  { name: 'abrupt-close-without-recovery', match: detectAbruptCloseWithoutRecovery },
];

// capture: an events array, or an object carrying one under `.events`
// (captureEvents()) or `.fullLog` (exportBundle()).
function matchSignatures(capture, signatures, opts) {
  const events = Array.isArray(capture) ? capture : ((capture && (capture.events || capture.fullLog)) || []);
  return (signatures || DEFAULT_SIGNATURES).flatMap((sig) => sig.match(events, opts));
}

if (typeof module !== 'undefined') {
  module.exports = {
    matchSignatures,
    DEFAULT_SIGNATURES,
    detectMissedHeartbeatReconnectGap,
    detectAbruptCloseWithoutRecovery,
  };
}
