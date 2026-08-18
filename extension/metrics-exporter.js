// #21 — optional Prometheus/OpenTelemetry metrics export. Not loaded by
// default and not required by core/webrtc-inspector.js (kept dependency-free)
// — load this only if you want to periodically push getSnapshot()-derived
// metrics to a collector. Reuses panel-sparkline.js's extractMetricsFromStats
// (the same bitrate/RTT/jitter/loss derivation the DevTools panel charts,
// including its guard against Chromium's counter-reset-on-codec-switch
// quirk) rather than re-deriving it — load panel-sparkline.js first if using
// this as a plain <script> outside Node.
const extractStats = (typeof require === 'function')
  ? require('./panel-sparkline.js').extractMetricsFromStats
  : window.extractMetricsFromStats;

function deriveConnectionMetrics(snapshot, countersByConnection) {
  return (snapshot.connections || []).map((c) => {
    let bitrateKbps = null, rttMs = null, jitterMs = null, lossPct = null;
    if (c.latestStats) {
      const prevCounters = countersByConnection.get(c.id) || { bytesSent: null, ts: null };
      const { metrics, counters } = extractStats(c.latestStats.reports, c.latestStats.ts, prevCounters);
      countersByConnection.set(c.id, counters);
      bitrateKbps = metrics.bitrateKbps;
      rttMs = metrics.rttMs;
      jitterMs = metrics.jitterMs;
      lossPct = metrics.lossPct;
    }
    return { connectionId: c.id, qualityScore: c.qualityScore, bitrateKbps, rttMs, jitterMs, lossPct };
  });
}

const METRIC_DEFS = [
  { key: 'qualityScore', name: 'webrtc_quality_score' },
  { key: 'bitrateKbps', name: 'webrtc_bitrate_kbps' },
  { key: 'rttMs', name: 'webrtc_rtt_ms' },
  { key: 'jitterMs', name: 'webrtc_jitter_ms' },
  { key: 'lossPct', name: 'webrtc_packet_loss_pct' },
];

function isFiniteNumber(v) {
  return typeof v === 'number' && Number.isFinite(v);
}

// Prometheus text exposition format (https://prometheus.io/docs/instrumenting/exposition_formats/).
function buildPrometheusExposition(connectionMetrics) {
  const lines = [];
  METRIC_DEFS.forEach(({ key, name }) => {
    const samples = connectionMetrics.filter((m) => isFiniteNumber(m[key]));
    if (samples.length === 0) return;
    lines.push(`# TYPE ${name} gauge`);
    samples.forEach((m) => lines.push(`${name}{connection_id="${m.connectionId}"} ${m[key]}`));
  });
  return lines.length ? `${lines.join('\n')}\n` : '';
}

// Minimal OTLP/HTTP JSON payload (https://github.com/open-telemetry/opentelemetry-proto) —
// one Metric per tracked name, gauge data points across connections.
function buildOtlpPayload(connectionMetrics, ts, resourceAttributes) {
  const timeUnixNano = String(Math.round(ts * 1e6));
  const metrics = METRIC_DEFS.map(({ key, name }) => ({
    name,
    gauge: {
      dataPoints: connectionMetrics
        .filter((m) => isFiniteNumber(m[key]))
        .map((m) => ({
          attributes: [{ key: 'connection_id', value: { stringValue: String(m.connectionId) } }],
          timeUnixNano,
          asDouble: m[key],
        })),
    },
  })).filter((metric) => metric.gauge.dataPoints.length > 0);

  return {
    resourceMetrics: [{
      resource: {
        attributes: Object.entries(resourceAttributes || {}).map(([key, value]) => ({
          key, value: { stringValue: String(value) },
        })),
      },
      scopeMetrics: [{ scope: { name: 'webrtc-inspector' }, metrics }],
    }],
  };
}

// Starts an interval pushing batched metrics to opts.endpointUrl. Pushes
// immediately, then every opts.intervalMs (default 15000). A failed push
// (collector down, network error) is swallowed to opts.onError, if given,
// rather than stopping the interval — a transient outage shouldn't kill
// tracking for the rest of the session. Returns { stop() }.
function startMetricsExporter(api, opts) {
  const {
    endpointUrl,
    intervalMs = 15000,
    format = 'prometheus',
    resourceAttributes = {},
    fetchImpl = (typeof fetch !== 'undefined' ? fetch : undefined),
    onError,
  } = opts || {};
  if (!endpointUrl) throw new Error('startMetricsExporter: opts.endpointUrl is required');
  if (typeof fetchImpl !== 'function') throw new Error('startMetricsExporter: no fetch implementation available; pass opts.fetchImpl');

  const countersByConnection = new Map();

  async function tick() {
    try {
      const snapshot = api.getSnapshot();
      const connectionMetrics = deriveConnectionMetrics(snapshot, countersByConnection);
      const ts = Date.now();
      const isOtlp = format === 'otlp';
      const body = isOtlp
        ? JSON.stringify(buildOtlpPayload(connectionMetrics, ts, resourceAttributes))
        : buildPrometheusExposition(connectionMetrics);
      await fetchImpl(endpointUrl, {
        method: 'POST',
        headers: { 'Content-Type': isOtlp ? 'application/json' : 'text/plain; version=0.0.4' },
        body,
      });
    } catch (err) {
      if (typeof onError === 'function') onError(err);
    }
  }

  tick();
  const timer = setInterval(tick, intervalMs);
  return { stop: () => clearInterval(timer) };
}

if (typeof module !== 'undefined') {
  module.exports = { deriveConnectionMetrics, buildPrometheusExposition, buildOtlpPayload, startMetricsExporter };
}
