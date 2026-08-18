// Pure timeline/waterfall shaping for the panel (#34) — derives per-connection
// and per-WebSocket lifecycle lanes purely from the existing event log's
// timestamps (no new instrumentation). Split out for unit testing, mirroring
// panel-sparkline.js/panel-clipboard.js's split.

// Only lifecycle-relevant event types are plotted — noisy per-message events
// (datachannel-message, websocket-message, ice-candidate-local/-remote) would
// swamp a waterfall meant to answer "when did X open/close/error relative to Y".
const LIFECYCLE_EVENT_TYPES = {
  'pc-created': 'open',
  'connection-killed': 'close',
  'ice-restart': 'state',
  'connection-state': 'state',
  'ice-state': 'state',
  'track-added': 'open',
  'track-received': 'open',
  'track-ended': 'close',
  'track-muted': 'state',
  'track-unmuted': 'state',
  'datachannel-opened': 'open',
  'websocket-created': 'open',
  'websocket-open': 'open',
  'websocket-close': 'close',
  'websocket-error': 'error',
  'ice-candidate-error': 'error',
  'candidate-type-flip': 'state',
};

function buildTimelineLanes(recentLog) {
  const entries = (recentLog || []).filter(
    (e) => LIFECYCLE_EVENT_TYPES[e.type] && (e.connectionId !== undefined || e.socketId !== undefined)
  );
  if (!entries.length) return { lanes: [], minTs: null, maxTs: null };

  const minTs = Math.min(...entries.map((e) => e.ts));
  const maxTs = Math.max(...entries.map((e) => e.ts));

  const laneMap = new Map();
  entries.forEach((e) => {
    const label = e.connectionId !== undefined ? `pc#${e.connectionId}` : `ws#${e.socketId}`;
    if (!laneMap.has(label)) laneMap.set(label, []);
    laneMap.get(label).push({ ts: e.ts, type: e.type, category: LIFECYCLE_EVENT_TYPES[e.type] });
  });

  const lanes = Array.from(laneMap.entries())
    .map(([label, events]) => ({ label, events: events.sort((a, b) => a.ts - b.ts) }))
    .sort((a, b) => a.label.localeCompare(b.label, undefined, { numeric: true }));

  return { lanes, minTs, maxTs };
}

function timelineOffsetPct(ts, minTs, maxTs) {
  if (maxTs === minTs) return 0;
  return ((ts - minTs) / (maxTs - minTs)) * 100;
}

if (typeof module !== 'undefined') {
  module.exports = { LIFECYCLE_EVENT_TYPES, buildTimelineLanes, timelineOffsetPct };
}
