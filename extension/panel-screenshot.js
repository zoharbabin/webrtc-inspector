// #38 — screenshot capture synced to key event-log transitions. Automatic
// (a manual per-event button can't be timed to fast ICE/track transitions),
// but off by default and armed only via an explicit "Record" toggle —
// mirrors Chrome DevTools' own Performance panel record button — so the
// tabs/host_permissions capability this needs is only exercised when the
// user opts in for the session. Pure trigger-decision logic extracted so
// it's testable without a chrome.tabs mock (mirrors the other panel-*.js
// modules).

const CAPTURE_EVENT_TYPES = new Set(['pc-created', 'track-added', 'track-received', 'ice-restart']);
const RECOVERED_STATES = new Set(['connected', 'completed']);
const DOWN_STATES = new Set(['disconnected', 'failed']);

// "Reconnect" has no single emit() type of its own — it's a
// connection-state/ice-state entry recovering to connected/completed after
// having been seen disconnected/failed for that same connection.
function isReconnectTransition(entry, prevStateByConnection) {
  if (entry.type !== 'connection-state' && entry.type !== 'ice-state') return false;
  if (!RECOVERED_STATES.has(entry.state)) return false;
  return DOWN_STATES.has(prevStateByConnection.get(entry.connectionId));
}

function shouldCaptureEvent(entry, prevStateByConnection) {
  return CAPTURE_EVENT_TYPES.has(entry.type) || isReconnectTransition(entry, prevStateByConnection);
}

function nextPrevStateByConnection(prevStateByConnection, entry) {
  if (entry.type !== 'connection-state' && entry.type !== 'ice-state') return prevStateByConnection;
  const next = new Map(prevStateByConnection);
  next.set(entry.connectionId, entry.state);
  return next;
}

// Scans a batch of not-yet-processed log entries (oldest first) and returns
// which ones qualify for a screenshot, plus the updated per-connection state
// map to carry into the next call.
function selectCaptureTargets(entries, prevStateByConnection) {
  let state = prevStateByConnection;
  const targets = [];
  entries.forEach((entry) => {
    if (shouldCaptureEvent(entry, state)) targets.push(entry);
    state = nextPrevStateByConnection(state, entry);
  });
  return { targets, state };
}

if (typeof module !== 'undefined') {
  module.exports = {
    CAPTURE_EVENT_TYPES,
    isReconnectTransition,
    shouldCaptureEvent,
    nextPrevStateByConnection,
    selectCaptureTargets,
  };
}
