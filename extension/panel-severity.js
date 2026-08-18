// #36 — bad-state-first connection sorting. A multi-connection page (common
// with SFU renegotiation) can bury the one connection a tester cares about
// under several healthy ones; ranking by severity surfaces it immediately.
// Rank is the worse of connectionState/iceConnectionState (lower = worse),
// so a connection that's healthy on one but failed on the other still
// surfaces near the top. Extracted from panel.js so it's testable without a
// chrome.devtools mock (mirrors panel-sparkline.js/panel-clipboard.js/etc).
const SEVERITY_RANK = {
  failed: 0,
  disconnected: 1,
  closed: 2,
  new: 3,
  connecting: 3,
  checking: 3,
  connected: 4,
  completed: 4,
};
const UNKNOWN_RANK = 3;

function rankOf(state) {
  return state in SEVERITY_RANK ? SEVERITY_RANK[state] : UNKNOWN_RANK;
}

function connectionSeverityRank(c) {
  const rank = Math.min(
    rankOf(c.state && c.state.connectionState),
    rankOf(c.state && c.state.iceConnectionState),
  );
  return c.closed ? Math.min(rank, SEVERITY_RANK.closed) : rank;
}

function sortConnectionsBySeverity(connections) {
  return [...connections].sort((a, b) => connectionSeverityRank(a) - connectionSeverityRank(b));
}

if (typeof module !== 'undefined') {
  module.exports = { SEVERITY_RANK, connectionSeverityRank, sortConnectionsBySeverity };
}
