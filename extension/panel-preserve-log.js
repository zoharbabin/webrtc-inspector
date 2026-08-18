// #31 — "Preserve log" toggle: window.__webrtcInspector's state lives in the
// inspected page, so it's wiped on every navigation/reload. This buffers the
// last known snapshot from each page load (like DevTools Network panel's
// own "Preserve log") so reconnect/navigation testing doesn't lose prior
// connection history the instant the page reloads. Extracted from panel.js
// so it's testable without a chrome.devtools mock (mirrors panel-sparkline.js
// /panel-clipboard.js/panel-timeline.js/panel-theme.js).
const MAX_GENERATIONS = 5;

function bufferGeneration(history, snap, gen) {
  if (!snap) return { history, droppedCount: 0 };
  const entry = {
    gen,
    connections: snap.connections || [],
    webSockets: snap.webSockets || [],
    recentLog: snap.recentLog || [],
  };
  const next = [...history, entry];
  const droppedCount = Math.max(0, next.length - MAX_GENERATIONS);
  return { history: next.slice(-MAX_GENERATIONS), droppedCount };
}

function mergeSnapshotForRender(history, liveSnap, preserveLog) {
  if (!liveSnap) return liveSnap;
  if (!preserveLog || !history.length) return liveSnap;
  const staleConnections = history.flatMap((entry) =>
    entry.connections.map((c) => ({ ...c, _gen: entry.gen, _stale: true })));
  const staleWebSockets = history.flatMap((entry) =>
    entry.webSockets.map((s) => ({ ...s, _gen: entry.gen, _stale: true })));
  const staleLog = history.flatMap((entry) =>
    entry.recentLog.map((e) => ({ ...e, _gen: entry.gen, _stale: true })));
  return {
    ...liveSnap,
    connections: [...staleConnections, ...liveSnap.connections],
    webSockets: [...staleWebSockets, ...liveSnap.webSockets],
    recentLog: [...staleLog, ...liveSnap.recentLog],
  };
}

if (typeof module !== 'undefined') {
  module.exports = { bufferGeneration, mergeSnapshotForRender, MAX_GENERATIONS };
}
