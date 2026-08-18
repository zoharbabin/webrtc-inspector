// Pure data model for the DevTools panel's live bitrate/RTT/jitter/loss
// sparklines (see #19) — no DOM/chrome API references, so it's usable both
// as a plain <script> global in panel.html and via require() in tests.
//
// getSnapshot() only exposes the latest polled stats sample per connection;
// the panel accumulates a rolling window of samples client-side here.

const SPARKLINE_MAX_SAMPLES = 60; // ~60s of history at the panel's 1s poll interval

// Chromium resets bytesSent/packetsSent when the encoder reinitializes (e.g.
// a codec switch) — documented since 2015 (webrtcHacks). A naive delta-based
// bitrate chart sees that as a huge negative delta, producing a sawtooth
// spike. Guard by skipping (not charting) any sample where the counter went
// backwards, rather than clamping it to a misleading zero.
function extractMetricsFromStats(reports, ts, prevCounters) {
  const outbound = reports.find((r) => r.type === 'outbound-rtp');
  const inbound = reports.find((r) => r.type === 'inbound-rtp');
  const remoteInbound = reports.find((r) => r.type === 'remote-inbound-rtp');
  const pair = reports.find((r) => r.type === 'candidate-pair' && r.nominated && r.state === 'succeeded')
    || reports.find((r) => r.type === 'candidate-pair' && r.state === 'succeeded');

  const bytesSent = outbound && typeof outbound.bytesSent === 'number' ? outbound.bytesSent : null;
  let bitrateKbps = null;
  if (bytesSent !== null && prevCounters.bytesSent !== null && prevCounters.ts !== null) {
    const deltaBytes = bytesSent - prevCounters.bytesSent;
    const deltaMs = ts - prevCounters.ts;
    if (deltaBytes >= 0 && deltaMs > 0) bitrateKbps = (deltaBytes * 8) / deltaMs;
  }

  const rttMs = pair && typeof pair.currentRoundTripTime === 'number' ? pair.currentRoundTripTime * 1000 : null;
  const jitterMs = inbound && typeof inbound.jitter === 'number' ? inbound.jitter * 1000 : null;

  let lossPct = null;
  if (remoteInbound && typeof remoteInbound.fractionLost === 'number') {
    lossPct = remoteInbound.fractionLost * 100;
  } else if (inbound && typeof inbound.packetsLost === 'number' && typeof inbound.packetsReceived === 'number') {
    const total = inbound.packetsLost + inbound.packetsReceived;
    lossPct = total > 0 ? (inbound.packetsLost / total) * 100 : 0;
  }

  return {
    metrics: { bitrateKbps, rttMs, jitterMs, lossPct },
    counters: { bytesSent, ts },
  };
}

function pushSample(series, key, ts, value) {
  if (!series[key]) series[key] = [];
  series[key].push({ ts, value });
  if (series[key].length > SPARKLINE_MAX_SAMPLES) series[key].shift();
}

// historyByConnection: Map<connectionId, {series, counters}> — owned by the
// caller (one long-lived Map for the panel's whole polling lifetime).
function updateSparklineHistory(historyByConnection, connectionId, reports, ts) {
  let entry = historyByConnection.get(connectionId);
  if (!entry) {
    entry = { series: {}, counters: { bytesSent: null, ts: null } };
    historyByConnection.set(connectionId, entry);
  }
  const { metrics, counters } = extractMetricsFromStats(reports, ts, entry.counters);
  entry.counters = counters;
  pushSample(entry.series, 'bitrateKbps', ts, metrics.bitrateKbps);
  pushSample(entry.series, 'rttMs', ts, metrics.rttMs);
  pushSample(entry.series, 'jitterMs', ts, metrics.jitterMs);
  pushSample(entry.series, 'lossPct', ts, metrics.lossPct);
  return entry.series;
}

// Renders one metric's samples as an SVG <polyline> points string, scaled to
// width x height. Null samples (no correlating stats report that tick) are
// skipped rather than charted as zero.
function sparklinePoints(samples, width, height) {
  const values = (samples || []).filter((s) => typeof s.value === 'number');
  if (values.length === 0) return '';
  const max = Math.max(...values.map((s) => s.value), 0);
  const min = Math.min(...values.map((s) => s.value), 0);
  const range = max - min || 1;
  const stepX = values.length > 1 ? width / (values.length - 1) : 0;
  return values.map((s, i) => {
    const x = i * stepX;
    const y = height - ((s.value - min) / range) * height;
    return `${x.toFixed(1)},${y.toFixed(1)}`;
  }).join(' ');
}

if (typeof module !== 'undefined') {
  module.exports = { SPARKLINE_MAX_SAMPLES, extractMetricsFromStats, pushSample, updateSparklineHistory, sparklinePoints };
}
