// Pure JSON-shaping for the panel's "Copy as..." buttons (#33) — split out
// from the DOM wiring in panel.js so it's unit-testable, mirroring
// panel-sparkline.js's split for the same reason (no --load-extension
// harness here to test live DevTools panel interactions).

function buildSdpClipboardPayload(connId, sdpType, sdpResult) {
  const entry = sdpResult && sdpResult[sdpType];
  if (!entry) return null;
  return JSON.stringify({ connId, sdpType, type: entry.type, sdp: entry.sdp }, null, 2);
}

function buildClipboardJson(value) {
  return JSON.stringify(value, null, 2);
}

if (typeof module !== 'undefined') {
  module.exports = { buildSdpClipboardPayload, buildClipboardJson };
}
